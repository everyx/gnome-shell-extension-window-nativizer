#!/usr/bin/env bash
# Headless E2E Test Suite for window-nativizer
# Tests full window lifecycle: Map -> Dynamic Resizing -> Compositor Moving -> Maximize/Unmaximize -> Close -> Extension Toggle
# Validates 0 ERROR, 0 CRITICAL, 0 WARNING with zero tolerance.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV="$ROOT/tools/dev.sh"
UUID="$(python3 -c "import json; print(json.load(open('$ROOT/src/metadata.json'))['uuid'])")"
STATE_DIR="/tmp/window-nativizer-dev"
PIDFILE="$STATE_DIR/shell.pid"
LOG="$STATE_DIR/shell.log"
PICK_REPLY="$STATE_DIR/pick-reply.txt"

cleanup() {
    echo ">> [test-e2e] Cleaning up test environment..."
    rm -f "$PICK_REPLY"
    "$DEV" stop >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "================================================================"
echo " Starting Headless E2E Test for $UUID"
echo "================================================================"

# 1. Start fresh headless shell
"$DEV" stop >/dev/null 2>&1 || true
"$DEV" shell

# 2. Verify extension is ACTIVE
echo ">> [test-e2e] Verifying extension state..."
EXT_INFO="$("$DEV" ext info "$UUID")"
echo "$EXT_INFO"
if ! echo "$EXT_INFO" | grep -qE "State: (ACTIVE|ENABLED)"; then
    echo "!! Extension failed to activate in headless shell!"
    exit 1
fi
echo ">> Extension is ACTIVE."

# 3. Every member we call must be callable on the shell we are testing, with the shape the code
# assumes. Public headers prove a declaration exists, not that GJS can reach it: out-arguments,
# (skip) annotations and properties-versus-methods all hide in that gap. See tools/gjs-surface.js.
echo ">> [test-e2e] Verifying the GJS surface this extension calls..."
GJS_TYPELIB_DIRS="$( { ls -d /usr/lib/mutter-[0-9]* /usr/lib64/mutter-[0-9]* /usr/lib/*/mutter-[0-9]* \
    /usr/lib/gnome-shell /usr/lib64/gnome-shell /usr/lib/*/gnome-shell 2>/dev/null || true; } | tr '\n' ':' | sed 's/:$//')"
GJS_LIB_DIRS="$( { ls -d /usr/lib/mutter-[0-9]* /usr/lib64/mutter-[0-9]* /usr/lib/*/mutter-[0-9]* \
    /usr/lib/gnome-shell /usr/lib64/gnome-shell /usr/lib/*/gnome-shell 2>/dev/null || true; } | tr '\n' ':' | sed 's/:$//')"
GJS_SURFACE_OUT="$(LD_LIBRARY_PATH="$GJS_LIB_DIRS${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
    GI_TYPELIB_PATH="$GJS_TYPELIB_DIRS" gjs -m "$ROOT/tools/gjs-surface.js" 2>&1)" || {
    echo "$GJS_SURFACE_OUT"
    echo "!! A member this extension calls is not callable on this shell."
    exit 1
}
echo "$GJS_SURFACE_OUT"

get_dbus_bus() {
    local pid
    pid="$(cat "$PIDFILE")"
    tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep '^DBUS_SESSION_BUS_ADDRESS=' | cut -d= -f2- || true
}

shell_eval() {
    local bus
    bus="$(get_dbus_bus)"
    gdbus call --address "$bus" --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1"
}

# The reply is a GVariant tuple whose JSON string has its own quotes escaped, so a field
# has to be parsed, not substring-matched: `leakedShadowCount.*:0` also matches a leaked
# count of 1 as soon as a zero-valued neighbour follows it. Pass a JSON object of the
# fields and values that must hold.
check_fields() {
    python3 - "$1" "$2" << 'PYEOF'
import json, re, sys

reply, expectation = sys.argv[1], sys.argv[2]
# GVariant prints the reply string with its quotes backslash-escaped (twice, through the
# Eval wrapper); the payloads here carry no backslash of their own, so drop them and read
# the JSON object.
match = re.search(r'\{.*\}', reply.replace('\\', ''), re.S)
if not match:
    sys.exit(f"no JSON object in reply: {reply!r}")
data = json.loads(match.group(0))
expected = json.loads(expectation)
wrong = {k: data.get(k) for k, v in expected.items() if data.get(k) != v}
if wrong:
    sys.exit(f"expected {expected}, got {wrong} (reply: {data})")
PYEOF
}

# The shell's own JS modules cannot be reached from outside it, so the members the extension
# takes from them are asserted from inside, over the nested session's D-Bus.
echo ">> [test-e2e] Verifying the shell-module surface (Main.*)..."
# Shell.Eval runs the string as a module, so the shell's JS modules are reached by resource URL
# (the same way tools/leak-probe.js reaches Main), and the completion value is awaited.
MAIN_PROBE="(async () => { const M = await import('resource:///org/gnome/shell/ui/main.js'); const Main = M.default ?? M; return JSON.stringify({overview: typeof Main.overview?.visible, uiGroup: typeof Main.uiGroup?.add_child}); })()"
MAIN_STATE="$(shell_eval "$MAIN_PROBE")"
if ! check_fields "$MAIN_STATE" '{"overview": "boolean", "uiGroup": "function"}'; then
    echo "!! Main.overview.visible and Main.uiGroup are not what the extension assumes: $MAIN_STATE"
    exit 1
fi
echo ">> Main.overview.visible is a boolean and Main.uiGroup.add_child is a function."

# Poll a reader command until its JSON output satisfies `predicate` (python -c; the state is
# argv[1], extra args follow), or give up after ~6s. Replaces a fixed settle sleep: a slow
# machine then waits for the state instead of racing it. On timeout it prints the last state
# and returns non-zero.
await_state() {
    local reader="$1" predicate="$2"
    shift 2
    local tries="${AWAIT_TRIES:-60}" state="" err
    err="$(mktemp)"
    for _ in $(seq 1 "$tries"); do
        state="$("$reader")"
        if python3 -c "$predicate" "$state" "$@" 2>"$err"; then
            rm -f "$err"
            printf '%s' "$state"
            return 0
        fi
        sleep 0.1
    done
    # A predicate that raised (a typo, or a reader that emitted non-JSON) would otherwise look
    # like a state that never settles; surface the traceback instead of misdiagnosing it.
    if [ -s "$err" ]; then
        echo "!! await_state predicate error:" >&2
        cat "$err" >&2
    fi
    rm -f "$err"
    printf '%s' "$state"
    return 1
}

# Ensure shell has settled onto the desktop (overview dismissed by dev-shell.sh)
OVERVIEW_INIT_STATE="$(shell_eval '
(async () => {
    const Main = await import("resource:///org/gnome/shell/ui/main.js");
    return JSON.stringify({overviewVisible: Main.overview.visible});
})()
')"
if ! check_fields "$OVERVIEW_INIT_STATE" '{"overviewVisible": false}'; then
    echo "!! Shell failed to settle onto desktop: initial headless overview is still visible!"
    exit 1
fi
echo ">> Shell session confirmed settled onto desktop."

# 3. Launch GTK4 test client in background
echo ">> [test-e2e] Launching GTK4 client (resize, maximize, close sequence)..."
"$DEV" app python3 "$ROOT/tools/e2e-client.py" --decorated &
CLIENT_PID=$!

# Wait for client window actor to be mapped
echo ">> [test-e2e] Waiting for window actor to map..."
MAPPED=0
for i in $(seq 1 30); do
    count="$(shell_eval 'global.get_window_actors().length' | grep -o '[0-9]\+' || echo "0")"
    if [[ "$count" -gt 0 ]]; then
        MAPPED=1
        break
    fi
    sleep 0.1
done

if [[ "$MAPPED" -ne 1 ]]; then
    echo "!! Timeout waiting for window actor to map!"
    exit 1
fi

# An actor appears before its window reports a usable geometry, and a line whose first map is slower
# reaches the check with both rects still all zero - which the extension reads, correctly, as no
# geometry to place a body in. Wait for the window rather than for its actor.
echo ">> [test-e2e] Waiting for the window's geometry..."
GEOM="0x0"
for i in $(seq 1 50); do
    GEOM="$(shell_eval '(() => { const w = global.get_window_actors()[0]?.meta_window; if (!w) return "0x0"; const r = w.get_frame_rect(); return r.width + "x" + r.height; })()' 2>/dev/null | grep -oE '[0-9]+x[0-9]+' | head -1 || echo "0x0")"
    [[ "$GEOM" != "0x0" ]] && break
    sleep 0.1
done
if [[ "$GEOM" == "0x0" ]]; then
    echo "!! Timeout waiting for the window to report a geometry!"
    exit 1
fi
echo ">> Window geometry is $GEOM."

# Allow manager idle_add to complete decoration attachment, then give the decision its bounded time:
# the classification it waits for is an asynchronous /proc read, so "not yet" and "never" have to be
# told apart by waiting rather than by failing on the first look.
CHECK_RESULT=""
for attempt in $(seq 1 20); do
CHECK_RESULT="$(shell_eval '
(() => {
    const actors = global.get_window_actors();
    if (actors.length === 0) return JSON.stringify({error: "no window actor found"});
    const winActor = actors[0];
    const effects = winActor.get_effects().map(e => e.toString());
    const hasClip = effects.some(e => e.includes("RoundedClipEffect"));
    
    const parent = winActor.get_parent();
    const children = parent ? parent.get_children().map(c => c.toString()) : [];
    const hasShadow = children.some(c => c.includes("WindowNativizerShadowActor"));
    const hasBand = children.some(c => c.includes("WindowNativizerResizeBand"));

    // Verify Manager.stateView(win) introspection seam
    const ext = typeof Main !== "undefined" ? Main.extensionManager.lookup("'"$UUID"'")?.stateObj : null;
    const stateView = (ext?._manager && winActor.meta_window) ? ext._manager.stateView(winActor.meta_window) : null;

    // What the decision was made from, so a failure here says which layer said no rather than only
    // that nothing was attached. A line whose reading, eligibility or classification differs is
    // otherwise indistinguishable from one where the actors were never created.
    const win = winActor.meta_window;
    const pid = win?.get_pid ? win.get_pid() : -1;
    const classifier = ext?._manager?.classifier ?? null;
    const b = win?.get_buffer_rect?.();
    const f = win?.get_frame_rect?.();
    return JSON.stringify({
        hasClip,
        hasShadow,
        hasBand,
        hasStateView: Boolean(stateView),
        stateViewClip: stateView?.hasClip ?? false,
        stateViewShadow: stateView?.hasShadow ?? false,
        stateViewBand: stateView?.hasResizeBand ?? false,
        actorCount: actors.length,
        facts: {
            windowType: String(win?.get_window_type?.()),
            maximized: String(win?.get_maximized ? win.get_maximized() : "n/a"),
            isMaximizedFn: String(win?.is_maximized ? win.is_maximized() : "n/a"),
            fullscreen: String(win?.is_fullscreen ? win.is_fullscreen() : "n/a"),
            allowsResize: String(win?.allows_resize ? win.allows_resize() : "n/a"),
            decorated: String(win?.decorated),
            buffer: b ? [b.x, b.y, b.width, b.height] : null,
            frame: f ? [f.x, f.y, f.width, f.height] : null,
            pid,
            adwaitaLook: classifier ? String(classifier.adwaitaLook(pid)) : "no-classifier",
            gtk4: classifier ? String(classifier.hasGtk4Client(pid)) : "no-classifier"
        }
    });
})()
')"

echo ">> Attachment check: $CHECK_RESULT"
if check_fields "$CHECK_RESULT" '{"hasClip": true, "hasShadow": true, "hasBand": true, "hasStateView": true, "stateViewClip": true, "stateViewShadow": true, "stateViewBand": true}'; then
    break
fi
sleep 0.1
done

if ! check_fields "$CHECK_RESULT" '{"hasClip": true, "hasShadow": true, "hasBand": true, "hasStateView": true, "stateViewClip": true, "stateViewShadow": true, "stateViewBand": true}'; then
    echo "!! RoundedClipEffect, WindowNativizerShadowActor or WindowNativizerResizeBand was not attached, or stateView mismatch!"
    exit 1
fi
echo ">> Clip effect, shadow actor and resize band successfully verified on active window."

# The blend exists for one direction only: libadwaita declares `transition: box-shadow` inside the
# backdrop state alone, so losing focus fades while gaining it snaps - and mutter's own X11 shadow
# switches with no easing at all. Both directions are asserted here, which needs a second window:
# focus cannot be taken from a window any other way, Meta.Window having no unmake-focused method in
# its public API. A blend that never gets a frame would also sit at weight 0 and paint no shadow
# while leaving the actor attached, which every other assertion in this file would accept.
echo ">> [test-e2e] Verifying a focus change blends one way and snaps the other..."
# Two clients of the guard's own, with distinct application ids so both exist. The client under test
# closes itself on its own schedule, and a probe that outlives it activates an unmanaged window -
# which makes mutter warn, and the log audit fails on that. The probe still picks the first two
# decorated windows rather than its own, so the liveness checks below are what make that safe.
# Distinct application ids, because GApplication is single-instance per id: two launches under one
# id produce one window, which is how this guard ended up borrowing the client under test.
"$DEV" app env WINDOW_NATIVIZER_DECORATED=1 WINDOW_NATIVIZER_APP_ID=dev.windownativizer.blenda gjs "$ROOT/tools/probe-window.js" >/dev/null 2>&1 &
"$DEV" app env WINDOW_NATIVIZER_DECORATED=1 WINDOW_NATIVIZER_APP_ID=dev.windownativizer.blendb gjs "$ROOT/tools/probe-window.js" >/dev/null 2>&1 &
BLEND_RESULT="$(shell_eval "
(async () => {
    const GLib = (await import('gi://GLib')).default;
    const Gio = (await import('gi://Gio')).default;
    const St = (await import('gi://St')).default;
    const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms,
        () => { r(); return GLib.SOURCE_REMOVE; }));

    // Both windows are the guard's own and have to map and be decorated before focus can move
    // between them, so wait for two rather than for a fixed number of seconds.
    let shadows = [];
    let tracked = [];
    for (let i = 0; i < 60; i++) {
        shadows = global.window_group.get_children()
            .filter(c => c.name === 'WindowNativizerShadowActor');
        tracked = shadows.map(s => s._windowActor?.meta_window).filter(Boolean);
        if (tracked.length >= 2)
            break;
        await sleep(250);
    }
    if (tracked.length < 2)
        return JSON.stringify({fadeStarted: false, fadeSettled: false, snapped: false,
            animationsOffStarted: true, animationsOffSettled: false,
            decorated: tracked.length, windows: global.get_window_actors().length});

    const target = tracked[0];
    const other = tracked[1];
    const targetShadow = shadows.find(s => s._windowActor?.meta_window === target);
    const alive = w => global.get_window_actors().some(a => a.meta_window === w);
    const settledNow = () => targetShadow.isSettled;

    // Start from the focused state, or the first activation below changes nothing.
    if (alive(target))
        target.activate(global.get_current_time());
    await sleep(150);

    // Whether the target was focused to begin with: a shell that did not take the activation has
    // nothing to fade when focus is handed on, and that is not the shadow's failure.
    const focusedBeforeHandoff = Boolean(target.appears_focused);
    // Whether the shadow was given a different style to blend towards at all: a fade that never
    // starts because the style never changed is a reconcile that did not run, not a blend that did
    // not animate.
    const styleKeyBeforeHandoff = targetShadow.style?.key ?? null;
    const animateBeforeHandoff = targetShadow.style?.animate ?? null;

    if (alive(other))
        other.activate(global.get_current_time());
    await sleep(50);
    const fadeStarted = targetShadow.isFading;
    const focusedAfterHandoff = Boolean(target.appears_focused);

    let fadeSettled = false;
    for (let i = 0; i < 60 && !fadeSettled; i++) {
        await sleep(25);
        fadeSettled = settledNow();
    }

    if (alive(target))
        target.activate(global.get_current_time());
    await sleep(50);
    const snapped = settledNow();
    const focusIn = {focused: target.appears_focused, outgoing: targetShadow.isFading,
        progress: targetShadow.progress};

    // With animations off, GTK hands a CSS transition no frame clock, so upstream snaps in both
    // directions - losing focus must then start no blend at all. The setting reaches the shell
    // through dconf, so wait for the shell to see it rather than for a fixed delay.
    const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    const wasAnimations = iface.get_boolean('enable-animations');
    iface.set_boolean('enable-animations', false);
    for (let i = 0; i < 40 && St.Settings.get().enable_animations; i++)
        await sleep(25);

    if (alive(other))
        other.activate(global.get_current_time());
    await sleep(250);
    const animationsOffStarted = targetShadow.isFading;
    const animationsOffSettled = settledNow();

    iface.set_boolean('enable-animations', wasAnimations);

    return JSON.stringify({fadeStarted, fadeSettled, snapped, focusIn, focusedBeforeHandoff,
        styleKeyBeforeHandoff, animateBeforeHandoff, focusedAfterHandoff,
        animationsOffStarted, animationsOffSettled,
        decorated: tracked.length, windows: global.get_window_actors().length});
})()
")"
pkill -f "probe-window[.]js" 2>/dev/null || true

echo ">> Blend check: $BLEND_RESULT"
# Losing focus must start a blend and the blend must settle - a unit test cannot reach either,
# because it needs a compositor to advance the frames. Gaining focus must then land in one frame,
# because upstream declares no transition for that direction.
if ! check_fields "$BLEND_RESULT" '{"fadeStarted": true, "fadeSettled": true, "snapped": true, "animationsOffStarted": false, "animationsOffSettled": true}'; then
    echo "!! A focus change did not fade on the way out, did not snap on the way back in, or still blended with animations off: $BLEND_RESULT"
    exit 1
fi
echo ">> Focus out faded and settled; focus back in snapped; with animations off it did not blend at all."

echo ">> [test-e2e] Simulating high-frequency compositor window movement..."
for i in 1 2 3 4 5; do
    sleep 0.06
    shell_eval "
    (() => {
        const actors = global.get_window_actors();
        if (actors.length > 0) {
            actors[0].meta_window.move_frame(true, 80 + $i * 40, 60 + $i * 30);
        }
    })()
    " >/dev/null
done

# Wait for client process to finish remaining steps (resize, maximize, unmaximize, close)
wait $CLIENT_PID
echo ">> Client exited normally."

# 5. Verify scene graph cleanup (0 leaked shadow actors)
sleep 0.2
echo ">> [test-e2e] Verifying complete cleanup after window close..."
CLEANUP_CHECK="$(shell_eval '
(() => {
    const actors = global.get_window_actors();
    const windowGroupChildren = global.window_group.get_children().map(c => c.toString());
    const leakedShadows = windowGroupChildren.filter(c => c.includes("WindowNativizerShadowActor"));
    const leakedBands = windowGroupChildren.filter(c => c.includes("WindowNativizerResizeBand"));
    return JSON.stringify({
        actorsLength: actors.length,
        leakedShadowCount: leakedShadows.length,
        leakedBandCount: leakedBands.length
    });
})()
')"
echo ">> Cleanup check: $CLEANUP_CHECK"
if ! check_fields "$CLEANUP_CHECK" '{"leakedShadowCount": 0, "leakedBandCount": 0}'; then
    echo "!! Leaked shadow actors or resize band detected in windowGroup after window close!"
    exit 1
fi
echo ">> 0 leaked actors confirmed."

# 6. Test the band lifecycle across an extension disable / re-enable, with a window open:
#    the band is the only actor that takes clicks, so one that survived disable would keep
#    swallowing them. tools/probe-window.js is a plain non-CSD GTK4 window that stays open.
echo ">> [test-e2e] Testing extension disable / re-enable lifecycle with an open window..."
# Decorated: the band lives in the ring the client reserved.
"$DEV" app env WINDOW_NATIVIZER_DECORATED=1 gjs "$ROOT/tools/probe-window.js" >/dev/null 2>&1 &
PROBE_PID=$!
PROBE_UP=0
for i in $(seq 1 30); do
    count="$(shell_eval 'global.get_window_actors().length' | grep -o '[0-9]\+' || echo "0")"
    if [[ "$count" -gt 0 ]]; then
        PROBE_UP=1
        break
    fi
    sleep 0.1
done
if [[ "$PROBE_UP" -ne 1 ]]; then
    echo "!! Timeout waiting for the probe window to map!"
    kill "$PROBE_PID" 2>/dev/null || true
    exit 1
fi
sleep 0.2

# Same JSON-object parse as check_fields: a reply carrying more than one digit run must
# yield this field rather than whatever `grep -o` matches first, or a stale count could slip
# past the assertions below.
band_count() {
    local reply
    reply="$(shell_eval '
    (() => {
        const bands = global.window_group.get_children().filter(c =>
            c.toString().includes("WindowNativizerResizeBand"));
        return JSON.stringify({bandCount: bands.length});
    })()
    ')"
    python3 - "$reply" << 'PYEOF'
import json, re, sys

reply = sys.argv[1]
# See check_fields: the GVariant reply carries backslash-escaped quotes, and the payload
# itself has none, so drop them before reading the JSON object.
match = re.search(r'\{.*\}', reply.replace('\\', ''), re.S)
print(json.loads(match.group(0))["bandCount"] if match else 0)
PYEOF
}

if [[ "$(band_count)" -lt 1 ]]; then
    echo "!! No resize band on the open probe window!"
    kill "$PROBE_PID" 2>/dev/null || true
    exit 1
fi

"$DEV" ext disable "$UUID" >/dev/null
BAND_REMOVED=0
for _ in $(seq 1 20); do
    if [[ "$(band_count)" -eq 0 ]]; then
        BAND_REMOVED=1
        break
    fi
    sleep 0.05
done
if [[ "$BAND_REMOVED" -ne 1 ]]; then
    echo "!! Resize band survived extension disable (it would keep taking clicks)!"
    kill "$PROBE_PID" 2>/dev/null || true
    exit 1
fi

"$DEV" ext enable "$UUID" >/dev/null
BAND_RESTORED=0
for _ in $(seq 1 20); do
    if [[ "$(band_count)" -ge 1 ]]; then
        BAND_RESTORED=1
        break
    fi
    sleep 0.05
done
if [[ "$BAND_RESTORED" -ne 1 ]]; then
    echo "!! Resize band was not rebuilt after the extension was re-enabled!"
    kill "$PROBE_PID" 2>/dev/null || true
    exit 1
fi
echo ">> Band lifecycle across disable / re-enable confirmed."

# 7. Test band geometry under partial (tiled) and full maximization:
#    - Vertically maximized (half-tiled proxy): band remains active, top and bottom strips
#      collapse to 0x0, while unconstrained left and right strips stay active at 12px width.
#    - Fully maximized: band is destroyed entirely.
#    - Unmaximized: band is restored on all four sides.
echo ">> [test-e2e] Verifying resize band under partial (tiled) and full maximization..."

read_band_state() {
    local reply
    reply="$(shell_eval '
    (() => {
        global.window_group.show();
        const actors = global.get_window_actors();
        if (actors.length === 0) return JSON.stringify({hasBand: false, error: "no actor"});
        const winActor = actors[0];
        const parent = winActor.get_parent();
        const children = parent ? parent.get_children() : [];
        const band = children.find(c => c.name === "WindowNativizerResizeBand" && c._windowActor === winActor);
        if (!band) return JSON.stringify({hasBand: false});

        const strips = {};
        for (const child of band.get_children()) {
            const name = child.name || "";
            for (const edge of ["top", "bottom", "left", "right"]) {
                if (name.includes(edge)) {
                    strips[edge] = {width: child.width, height: child.height};
                }
            }
        }
        return JSON.stringify({hasBand: true, strips});
    })()
    ')"
    python3 - "$reply" << 'PYEOF'
import json, re, sys

reply = sys.argv[1]
match = re.search(r'\{.*\}', reply.replace('\\', ''), re.S)
if not match:
    sys.exit("invalid json")
print(match.group(0))
PYEOF
}

# The same reading with the frame rect and the strip origins, for the case that turns on where
# the strips sit relative to the body rather than on which of them exist. It picks its window by
# title: the probe window of the section above can still be on the stage.
read_declared_band_state() {
    local reply
    reply="$(shell_eval '
    (() => {
        global.window_group.show();
        const actors = global.get_window_actors();
        const winActor = actors.find(a => a.meta_window &&
            a.meta_window.get_title() === "Window Nativizer E2E Declared");
        if (!winActor) return JSON.stringify({hasBand: false, error: "declared-margin window not on stage"});
        const win = winActor.meta_window;
        const buf = win.get_buffer_rect();
        const frame = win.get_frame_rect();
        const parent = winActor.get_parent();
        const children = parent ? parent.get_children() : [];
        const band = children.find(c => c.name === "WindowNativizerResizeBand" && c._windowActor === winActor);
        if (!band) return JSON.stringify({hasBand: false, error: "no band on this window"});

        const strips = {};
        for (const child of band.get_children()) {
            const name = child.name || "";
            const [x, y] = child.get_transformed_position();
            for (const edge of ["top", "bottom", "left", "right"]) {
                if (name.includes(edge)) {
                    strips[edge] = {x: Math.round(x), y: Math.round(y),
                                    width: child.width, height: child.height};
                }
            }
        }
        return JSON.stringify({
            hasBand: true,
            buffer: {x: buf.x, y: buf.y, width: buf.width, height: buf.height},
            frame: {x: frame.x, y: frame.y, width: frame.width, height: frame.height},
            strips,
        });
    })()
    ')"
    python3 - "$reply" << 'PYEOF'
import json, re, sys

reply = sys.argv[1]
match = re.search(r'\{.*\}', reply.replace('\\', ''), re.S)
if not match:
    sys.exit("invalid json")
print(match.group(0))
PYEOF
}

# Suppression or clipping? (a) is the case that tells them apart: top and bottom collapse to 0x0
# while both side strips stay on screen, so those two are suppressed edges. In (a2) the left strip
# also reads 0x0, but only because it falls outside the monitor and the clip removes it; (d) carries
# the other direction - a hand-placed flush window keeps its top strip, so nothing was inferred from
# where its frame sits.
# (a) Maximize vertically (simulates half-tiled state)
shell_eval '
(() => {
    global.window_group.show();
    const actors = global.get_window_actors();
    if (actors.length > 0)
        actors[0].meta_window.set_maximize_flags(2); // Meta.MaximizeFlags.VERTICAL
})()
' >/dev/null
VERT_STATE="$(await_state read_band_state '
import json, sys
d = json.loads(sys.argv[1])
s = d.get("strips", {})
zero = lambda e: s.get(e, {}).get("width", -1) == 0 and s.get(e, {}).get("height", -1) == 0
live = lambda e: s.get(e, {}).get("width", 0) > 0 and s.get(e, {}).get("height", 0) > 0
sys.exit(0 if d.get("hasBand") and zero("top") and zero("bottom") and live("left") and live("right") else 1)
')" || { echo "!! Vertically maximized band did not settle into its expected shape: $VERT_STATE"; exit 1; }
echo ">> Vertically maximized state: $VERT_STATE"
echo ">> Vertically maximized (tiled) resize band verified: constrained strips collapsed, unconstrained active."

# The ring is 15% of the theme colour over whatever is behind it, and that is the whole of the tiled
# style - a style-field assertion cannot see whether it renders at all. The wallpaper is unknowable,
# so the check is relative: it holds for any backdrop, and accepts either theme colour.
RING_BUS="$(get_dbus_bus)"
RING_PIXEL="$(shell_eval '
(() => {
    const w = global.get_window_actors()[0].meta_window;
    const f = w.get_frame_rect();
    // The screenshot is in physical pixels and frame rects are in logical ones, so scale.
    const s = global.display.get_monitor_scale(w.get_monitor());
    return JSON.stringify({left: Math.round(f.x * s), y: Math.round((f.y + Math.floor(f.height / 2)) * s)});
})()
')"
rm -f /tmp/window-nativizer-ring.png
gdbus call --address "$RING_BUS" --dest org.gnome.Shell --object-path /org/gnome/Shell/Screenshot \
    --method org.gnome.Shell.Screenshot.Screenshot false false /tmp/window-nativizer-ring.png >/dev/null 2>&1
if ! python3 - "$RING_PIXEL" <<'PYEOF'
import json, re, sys
from PIL import Image

reply = sys.argv[1]
match = re.search(r'\{.*\}', reply.replace('\\', ''), re.S)
if not match:
    sys.exit(f"no geometry in reply: {reply!r}")
g = json.loads(match.group(0))
im = Image.open('/tmp/window-nativizer-ring.png').convert('RGB')
x, y = g['left'], g['y']
backdrop = im.getpixel((x - 8, y))
ring = im.getpixel((x - 1, y))
expected = [[round(a * 0.15 + b * 0.85) for a, b in ((theme, backdrop[i]) for i in range(3))]
            for theme in (0, 255)]
close = any(all(abs(ring[i] - e[i]) <= 4 for i in range(3)) for e in expected)
print(f"backdrop={backdrop} ring={ring} expected={expected}")
sys.exit(0 if close else 1)
PYEOF
then
    echo "!! The tiled ring did not render at the layer's own alpha over the backdrop (see the line above)"
    exit 1
fi
echo ">> Tiled ring pixel verified at the layer alpha."


# Inspect the tiled ring style via ShadowActor's public properties (style.border, style.shadows).
# The blend's settled state and styles are exposed cleanly by the ShadowFadeStateMachine.
#
# The tiled style's ring is drawn by the shadow actor, and that actor was gated on "has shadow" -
# which a tiled window does not have, so the ring was never drawn at all. The band assertion above
# cannot see that: the resize axis is independent of the decoration, which is why it stayed green.
TILED_STYLE="$(shell_eval '
(() => {
    const w = global.get_window_actors()[0].meta_window;
    const shadows = global.window_group.get_children()
        .filter(c => c.name === "WindowNativizerShadowActor");
    const s = shadows.find(c => c._windowActor && c._windowActor.meta_window === w);
    return JSON.stringify({
        verticalOnly: w.maximized_vertically && !w.maximized_horizontally,
        actor: Boolean(s),
        border: s && s.style && s.style.border ? true : false,
        // The ring is the only layer the tiled style has, and it carries the colour - which is
        // what the upstream tiled rule is: a 1px box-shadow whose colour is currentColor.
        shadowLayers: s && s.style && s.style.shadows ? s.style.shadows.length : -1,
        layerColored: s && s.style && s.style.shadows && s.style.shadows[0]
            ? Boolean(s.style.shadows[0].color) : false,
    });
})()
')"
echo ">> Tiled style: $TILED_STYLE"
if ! check_fields "$TILED_STYLE" '{"verticalOnly": true, "actor": true, "border": true, "shadowLayers": 1, "layerColored": true}'; then
    echo "!! A vertically maximized window did not get the tiled style, or the actor that draws its ring is missing: $TILED_STYLE"
    exit 1
fi
echo ">> Tiled ring verified: the tiled style carries a border, exactly one layer holding the colour, and the actor that draws it."

# (a2) Left half of the work area, flush against the left edge, vertically maximized as
# Mutter's own left tile does it (`meta_window_tile_internal()`). The divider keeps its band;
# the constrained top and bottom do not, and neither does the left, whose strip falls outside
# the monitor clip.
shell_eval '
(() => {
    global.window_group.show();
    const actors = global.get_window_actors();
    if (actors.length > 0) {
        const win = actors[0].meta_window;
        const monitor = win.get_monitor();
        const wa = win.get_work_area_for_monitor(monitor);
        win.unmaximize();
        win.set_maximize_flags(2); // Meta.MaximizeFlags.VERTICAL, as tiling sets it
        win.move_resize_frame(false, wa.x, wa.y, Math.floor(wa.width / 2), wa.height);
    }
})()
' >/dev/null
LEFT_TILED_STATE="$(await_state read_band_state '
import json, sys
d = json.loads(sys.argv[1])
s = d.get("strips", {})
zero = lambda e: s.get(e, {}).get("width", -1) == 0 and s.get(e, {}).get("height", -1) == 0
live = lambda e: s.get(e, {}).get("width", 0) > 0 and s.get(e, {}).get("height", 0) > 0
sys.exit(0 if d.get("hasBand") and zero("top") and zero("bottom") and zero("left") and live("right") else 1)
')" || { echo "!! Left-tiled band did not settle into its expected shape: $LEFT_TILED_STATE"; exit 1; }
echo ">> Left-tiled state: $LEFT_TILED_STATE"
echo ">> Left-tiled resize band verified: top, bottom, and left collapsed; right active."

# (b) Fully maximize: band must be destroyed
shell_eval '
(() => {
    const actors = global.get_window_actors();
    if (actors.length > 0)
        actors[0].meta_window.maximize();
})()
' >/dev/null
FULL_STATE="$(await_state read_band_state '
import json, sys
sys.exit(0 if not json.loads(sys.argv[1]).get("hasBand") else 1)
')" || { echo "!! Resize band survived a fully maximized window: $FULL_STATE"; exit 1; }
echo ">> Fully maximized state: $FULL_STATE"
echo ">> Fully maximized state verified: resize band destroyed."

# (c) Unmaximize: band must be restored on all four sides
shell_eval '
(() => {
    const actors = global.get_window_actors();
    if (actors.length > 0) {
        const win = actors[0].meta_window;
        win.unmaximize();
        win.move_resize_frame(false, 300, 200, 800, 600);
    }
})()
' >/dev/null
RESTORED_STATE="$(await_state read_band_state '
import json, sys
d = json.loads(sys.argv[1])
s = d.get("strips", {})
live = all(s.get(e, {}).get("width", 0) > 0 and s.get(e, {}).get("height", 0) > 0
           for e in ("top", "bottom", "left", "right"))
sys.exit(0 if d.get("hasBand") and live else 1)
')" || { echo "!! Resize band was not restored on all sides: $RESTORED_STATE"; exit 1; }
echo ">> Restored state: $RESTORED_STATE"
echo ">> Unmaximized state verified: resize band restored on all sides."

# (d) A window the user placed flush by hand is not tiled: no maximize flag is set for it, so
# Mutter reports every edge unconstrained and the band has to survive. Inferring tiling from
# geometry would read this rectangle as a left tile and drop the top strip with it - this is
# the assertion that fails if that inference comes back.
shell_eval '
(() => {
    global.window_group.show();
    const actors = global.get_window_actors();
    if (actors.length > 0) {
        const win = actors[0].meta_window;
        const monitor = win.get_monitor();
        const wa = win.get_work_area_for_monitor(monitor);
        win.unmaximize();
        win.move_resize_frame(false, wa.x, wa.y, Math.floor(wa.width / 2), wa.height);
    }
})()
' >/dev/null
FLUSH_STATE="$(await_state read_band_state '
import json, sys
d = json.loads(sys.argv[1])
s = d.get("strips", {})
live = lambda e: s.get(e, {}).get("width", 0) > 0 and s.get(e, {}).get("height", 0) > 0
zero = lambda e: s.get(e, {}).get("width", -1) == 0 and s.get(e, {}).get("height", -1) == 0
# Left and bottom are empty because they fall outside the monitor, not because an edge was
# suppressed - which is what an empty top strip would mean.
sys.exit(0 if d.get("hasBand") and live("top") and live("right") and zero("left") and zero("bottom") else 1)
')" || { echo "!! Hand-placed flush window did not settle: $FLUSH_STATE"; exit 1; }
echo ">> Hand-placed flush state: $FLUSH_STATE"
echo ">> Hand-placed flush window verified: top and right strips survive, left and bottom clipped."

kill "$PROBE_PID" 2>/dev/null || true
pkill -f "probe-window[.]js" 2>/dev/null || true
for i in $(seq 1 30); do
    count="$(shell_eval 'global.get_window_actors().length' | grep -o '[0-9]\+' || echo "0")"
    if [[ "$count" -eq 0 ]]; then
        break
    fi
    sleep 0.1
done

# (e) A client that draws its own CSD declares margins with it. The old reading took any wide
# enough ring for a native-width handle and skipped the band; only GTK4 can prove that from the
# outside, so this window keeps its band - and the band is the ring around the frame, not the
# actor, which is what the strip origins say.
# The expected band width comes from the generated constant, never from a literal here.
BAND_PX="$(rg -o 'RESIZE_HANDLE_SIZE = ([0-9]+)' -r '$1' "$ROOT/src/lib/gtkRules.generated.js")"
echo ">> [test-e2e] Verifying the band on a window that declares its own margins..."
"$DEV" app python3 "$ROOT/tools/e2e-client.py" --decorated --title "Window Nativizer E2E Declared" --hold 4000 >/dev/null 2>&1 &
for i in $(seq 1 60); do
    found="$(shell_eval 'global.get_window_actors().some(a => a.meta_window && a.meta_window.get_title() === "Window Nativizer E2E Declared") ? 1 : 0' | grep -o '[01]' | head -1 || echo 0)"
    [ "$found" = "1" ] && break
    sleep 0.25
done
# Poll for the band to appear on all four sides before the geometry assertion, instead of a
# fixed settle sleep.
# Capture the awaited snapshot itself, not a second read that could race the first.
DECLARED_STATE="$(await_state read_declared_band_state '
import json, sys
d = json.loads(sys.argv[1])
s = d.get("strips", {})
sys.exit(0 if d.get("hasBand") and all(s.get(e, {}).get("width", 0) > 0 and s.get(e, {}).get("height", 0) > 0 for e in ("top", "right", "bottom", "left")) else 1)
')" || { echo "!! The declared-margin window never showed its band: $DECLARED_STATE"; exit 1; }
echo ">> Declared-margin window state: $DECLARED_STATE"
python3 - "$DECLARED_STATE" "$BAND_PX" << 'PYEOF'
import json, sys

data = json.loads(sys.argv[1])
band = int(sys.argv[2])
if not data.get("hasBand"):
    sys.exit("!! Expected a resize band on a window that declares its own margins, but none found!")

buf, frame, strips = data["buffer"], data["frame"], data["strips"]
# The window has to declare a ring, or this case is the bare one the sections above cover.
ring = {
    "left": frame["x"] - buf["x"],
    "top": frame["y"] - buf["y"],
    "right": buf["x"] + buf["width"] - (frame["x"] + frame["width"]),
    "bottom": buf["y"] + buf["height"] - (frame["y"] + frame["height"]),
}
for edge, value in ring.items():
    if value <= 0:
        sys.exit(f"!! Expected the client to declare a margin on the {edge}, got {value}")

# The band is frame grown by the constant on every side - the whole of it outside the body.
expected = {
    "top": {"x": frame["x"] - band, "y": frame["y"] - band,
            "width": frame["width"] + 2 * band, "height": band},
    "right": {"x": frame["x"] + frame["width"], "y": frame["y"],
              "width": band, "height": frame["height"]},
    "bottom": {"x": frame["x"] - band, "y": frame["y"] + frame["height"],
               "width": frame["width"] + 2 * band, "height": band},
    "left": {"x": frame["x"] - band, "y": frame["y"],
             "width": band, "height": frame["height"]},
}
for edge, want in expected.items():
    got = strips.get(edge)
    if not got:
        sys.exit(f"!! Expected a {edge} strip on a declared-margin window, got none")
    for key in ("x", "y", "width", "height"):
        if got.get(key) != want[key]:
            sys.exit(f"!! {edge} strip {key}: expected {want[key]}, got {got.get(key)}"
                     f" (the band must hug the frame, not the actor)")
PYEOF
echo ">> Declared-margin window verified: band present, all four strips hug the frame."

# (f) Overview lifecycle assertion: RoundedClipEffect must remain enabled in overview,
# activating hardware mipmapping (Cogl.PipelineFilter.LINEAR_MIPMAP_LINEAR) to prevent downsampling aliasing,
# and restoring standard desktop filtering upon returning to desktop.
echo ">> [test-e2e] Verifying clip effect and hardware mipmapping lifecycle in overview..."
OVERVIEW_STATE="$(shell_eval '
(async () => {
    const Main = await import("resource:///org/gnome/shell/ui/main.js");
    const GLib = imports.gi.GLib;
    const Cogl = imports.gi.Cogl;
    const actors = global.get_window_actors();
    const target = actors.find(a => a.meta_window && a.meta_window.get_title() === "Window Nativizer E2E Declared");
    if (!target) return JSON.stringify({error: "window not found"});

    const getClip = () => target.get_effects().find(e => e.toString().includes("RoundedClipEffect"));

    const initialClip = getClip();
    const initialEnabled = initialClip ? initialClip.get_enabled() : null;

    const getMinFilter = clip => {
        const pipeline = clip?.get_pipeline?.();
        if (!pipeline?.get_layer_filters)
            return null;
        try {
            const filters = pipeline.get_layer_filters(0);
            return Array.isArray(filters) ? filters[0] : filters;
        } catch {
            return null;
        }
    };

    const pollState = async (expectedOverview, expectedMipmapped, maxRetries = 20) => {
        for (let i = 0; i < maxRetries; i++) {
            await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { r(); return GLib.SOURCE_REMOVE; }));
            const clip = getClip();
            const minFilter = getMinFilter(clip);
            const isMipmapped = minFilter === Cogl.PipelineFilter.LINEAR_MIPMAP_LINEAR;
            if (Main.overview.visible === expectedOverview && clip && clip.get_enabled() && isMipmapped === expectedMipmapped) {
                return {
                    matched: true,
                    overviewVisible: Main.overview.visible,
                    clipEnabled: clip.get_enabled(),
                    minFilter,
                    isMipmapped,
                    hasClip: true
                };
            }
        }
        const clip = getClip();
        const minFilter = getMinFilter(clip);
        return {
            matched: false,
            overviewVisible: Main.overview.visible,
            hasClip: Boolean(clip),
            clipEnabled: clip ? clip.get_enabled() : null,
            minFilter,
            isMipmapped: minFilter === Cogl.PipelineFilter.LINEAR_MIPMAP_LINEAR
        };
    };

    Main.overview.show();
    const clipDuringShowing = getClip();
    const showingModeEarly = clipDuringShowing ? clipDuringShowing._overviewMode : false;
    const overviewRes = await pollState(true, true);

    Main.overview.hide();
    const desktopRes = await pollState(false, false);

    return JSON.stringify({
        hasClip: Boolean(initialClip) && overviewRes.hasClip && desktopRes.hasClip,
        initialEnabled,
        showingModeEarly,
        overviewVisible: overviewRes.overviewVisible,
        inOverviewEnabled: overviewRes.clipEnabled,
        inOverviewMipmapped: overviewRes.isMipmapped,
        inOverviewMinFilter: overviewRes.minFilter,
        desktopOverviewVisible: desktopRes.overviewVisible,
        restoredEnabled: desktopRes.clipEnabled,
        restoredMipmapped: desktopRes.isMipmapped
    });
})()
')"
echo ">> Overview state check: $OVERVIEW_STATE"
if ! check_fields "$OVERVIEW_STATE" '{"hasClip": true, "initialEnabled": true, "showingModeEarly": true, "overviewVisible": true, "inOverviewEnabled": true, "inOverviewMipmapped": true, "desktopOverviewVisible": false, "restoredEnabled": true, "restoredMipmapped": false}'; then
    echo "!! Overview assertion failed: clip effect or hardware mipmapping was not properly managed during overview!"
    exit 1
fi
echo ">> Overview lifecycle verified: clip retained and hardware mipmapping activated in overview, restored on desktop."

# The declared-margin client closes itself (--hold); wait for it to go before proceeding.
for i in $(seq 1 40); do
    left="$(shell_eval 'global.get_window_actors().some(a => a.meta_window && a.meta_window.get_title() === "Window Nativizer E2E Declared") ? 1 : 0' | grep -o '[01]' | head -1 || echo 0)"
    [ "$left" = "0" ] && break
    sleep 0.25
done

# (g) Verify shadow actor opacity synchronization during window close animation
echo ">> [test-e2e] Verifying shadow actor opacity synchronization during window close animation..."
"$DEV" app python3 "$ROOT/tools/e2e-client.py" --decorated --app-id "org.test.windownativizer.fade" --title "ShadowFadeProbe" --hold 2000 &
SHADOW_FADE_CLIENT_PID=$!
MAPPED=0
for i in $(seq 1 40); do
    found="$(shell_eval "global.get_window_actors().some(a => a.meta_window && a.meta_window.get_title() === 'ShadowFadeProbe') ? 1 : 0" | grep -o '[01]' | head -1 || echo 0)"
    if [ "$found" = "1" ]; then
        MAPPED=1
        break
    fi
    sleep 0.05
done
if [ "$MAPPED" -ne 1 ]; then
    echo "!! Timeout waiting for ShadowFadeProbe window actor to map!"
    kill "$SHADOW_FADE_CLIENT_PID" 2>/dev/null || true
    exit 1
fi

SHADOW_FADE_STATE="$(shell_eval '
(async () => {
    const GLib = imports.gi.GLib;
    const actor = global.get_window_actors().find(a => a.meta_window && a.meta_window.get_title() === "ShadowFadeProbe");
    if (!actor) return JSON.stringify({error: "actor not found"});

    // Allow manager process-detection (/proc/<pid>/maps) and idle attachment to complete.
    let shadow = null;
    for (let i = 0; i < 40; i++) {
        shadow = global.window_group.get_children().find(c => c.name === "WindowNativizerShadowActor" && c._windowActor === actor);
        if (shadow) break;
        await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 25, () => { r(); return GLib.SOURCE_REMOVE; }));
    }
    if (!shadow) return JSON.stringify({error: "shadow not found"});

    const samples = [];
    shadow.connect("notify::opacity", () => {
        samples.push(shadow.opacity);
    });

    // Window has --hold 2000 so it will call win.close() ~2s after launch.
    let settled = false;
    for (let i = 0; i < 80; i++) {
        await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { r(); return GLib.SOURCE_REMOVE; }));
        const stillThere = global.get_window_actors().some(a => a.meta_window && a.meta_window.get_title() === "ShadowFadeProbe");
        if (!stillThere) {
            settled = true;
            break;
        }
    }

    const hasFaded = samples.some(op => op > 0 && op < 255);
    return JSON.stringify({
        settled,
        sampleCount: samples.length,
        hasFaded
    });
})()
')"
echo ">> Shadow actor close sync check: $SHADOW_FADE_STATE"
if ! check_fields "$SHADOW_FADE_STATE" '{"settled": true, "hasFaded": true}'; then
    echo "!! Shadow actor close sync assertion failed: shadow opacity was not synchronized with window close!"
    wait "$SHADOW_FADE_CLIENT_PID" 2>/dev/null || true
    exit 1
fi
wait "$SHADOW_FADE_CLIENT_PID" 2>/dev/null || true
echo ">> Shadow actor close sync verified: shadow opacity synchronized during window close."

# (h) A libadwaita client is the reference this whole extension copies: nothing of ours may land on
# it. It is also the only end-to-end evidence for the skip side of the band criterion, which rests
# on the process (libadwaita in /proc/<pid>/maps) rather than on the window's declared ring.
LIBNATIVE_APP=""
LIBNATIVE_CLASS=""
# Any libadwaita client will do: what matters is that its process maps the provider. The wmclass is
# the app id on Wayland, which is steadier to match than a process name (`pgrep -x` cannot match one
# longer than 15 characters, and these are).
for pair in gnome-calculator:org.gnome.Calculator gnome-text-editor:org.gnome.TextEditor nautilus:org.gnome.Nautilus; do
    if command -v "${pair%%:*}" >/dev/null 2>&1; then
        LIBNATIVE_APP="${pair%%:*}"
        LIBNATIVE_CLASS="${pair##*:}"
        break
    fi
done
LIBNATIVE_RESULT="SKIPPED (no libadwaita client installed)"
if [ -n "$LIBNATIVE_APP" ]; then
    echo ">> [test-e2e] Verifying a libadwaita client is left alone ($LIBNATIVE_APP)..."
    "$DEV" app "$LIBNATIVE_APP" >/dev/null 2>&1 &
    LIBNATIVE_PID=$!
    found=0
    for i in $(seq 1 80); do
        found="$(shell_eval "global.get_window_actors().some(a => a.meta_window && a.meta_window.get_wm_class() === '$LIBNATIVE_CLASS') ? 1 : 0" | grep -o '[01]' | head -1 || echo 0)"
        [ "$found" = "1" ] && break
        sleep 0.25
    done
    if [ "$found" != "1" ]; then
        echo "!! The libadwaita client ($LIBNATIVE_APP) never mapped a '$LIBNATIVE_CLASS' window"
        exit 1
    fi
    # Poll for the settled decision instead of a fixed settle sleep: the extension has to have
    # reconciled the mapping and decided to leave the client alone.
    NATIVE_STATE=""
    for i in $(seq 1 60); do
    NATIVE_STATE="$(shell_eval "
    (() => {
        global.window_group.show();
        const kids = global.window_group.get_children();
        const actor = global.get_window_actors()
            .find(a => a.meta_window && a.meta_window.get_wm_class() === '$LIBNATIVE_CLASS');
        if (!actor) return 'window-not-found';
        const band = kids.some(c => c.name === 'WindowNativizerResizeBand' && c._windowActor === actor);
        const effects = (actor.get_effects ? actor.get_effects() : []).map(e => String(e)).join(',');
        return 'band=' + (band ? 1 : 0) + ';effects=' + (effects || 'none');
    })()
    ")"
    [[ "$NATIVE_STATE" == *"band=0;effects=none"* ]] && break
    sleep 0.1
    done
    echo ">> Libadwaita client state: $NATIVE_STATE"
    python3 - "$NATIVE_STATE" << 'PYEOF'
import sys

state = sys.argv[1]
if "window-not-found" in state:
    sys.exit(f"!! The libadwaita client's window never appeared: {state}")
if "band=0" not in state:
    sys.exit(f"!! Expected no resize band on a libadwaita client, got: {state}")
if "effects=none" not in state:
    sys.exit(f"!! Expected no clip effect on a libadwaita client, got: {state}")
PYEOF
    echo ">> Libadwaita client verified: no band, no clip, nothing of ours."
    LIBNATIVE_RESULT="PASSED ($LIBNATIVE_APP)"
    pkill -x "$LIBNATIVE_APP" 2>/dev/null || true
    pkill -f "$LIBNATIVE_APP" 2>/dev/null || true
    kill "$LIBNATIVE_PID" 2>/dev/null || true
    for i in $(seq 1 40); do
        left="$(shell_eval "global.get_window_actors().some(a => a.meta_window && a.meta_window.get_wm_class() === '$LIBNATIVE_CLASS') ? 1 : 0" | grep -o '[01]' | head -1 || echo 0)"
        [ "$left" = "0" ] && break
        sleep 0.25
    done
else
    echo "!! No libadwaita client (gnome-calculator, gnome-text-editor or nautilus) is installed,"
    echo "   so the skip side of the band criterion cannot be verified on this machine."
    if [ "${ALLOW_SKIP_LIBNATIVE:-0}" != "1" ]; then
        echo "   Set ALLOW_SKIP_LIBNATIVE=1 to run the rest of the suite without this case."
        exit 1
    fi
    echo "   Continuing because ALLOW_SKIP_LIBNATIVE=1."
fi

# Ensure all background test windows have completely vanished before testing popup lifecycle
for i in $(seq 1 40); do
    count="$(shell_eval 'global.get_window_actors().length' | grep -o '[0-9]\+' || echo "0")"
    if [[ "$count" -eq 0 ]]; then
        break
    fi
    sleep 0.1
done

# (i) Test transient popup menu gate & unmanaged focus protection (Issue #13):
#    - Layer 1: When an application opens a transient popup/dropdown menu, Mutter creates a
#      menu window actor, but manager._trackWindow must reject it (trackedCount strictly remains 1, not 2).
#    - Layer 2: While the unmanaged popup menu holds grab/focus, manager must not schedule debounced
#      reconciliation (reconcilePending must remain false).
echo ">> [test-e2e] Verifying transient popup rejection and focus protection (Issue #13)..."
"$DEV" app python3 "$ROOT/tools/repro-popup-menu.py" --auto --timeout 2500 >/dev/null 2>&1 &
REPRO_PID=$!

POPUP_MAPPED=0
for i in $(seq 1 40); do
    count="$(shell_eval 'global.get_window_actors().length' | grep -o '[0-9]\+' || echo "0")"
    if [[ "$count" -ge 2 ]]; then
        POPUP_MAPPED=1
        break
    fi
    sleep 0.1
done

if [[ "$POPUP_MAPPED" -ne 1 ]]; then
    echo "!! Timeout waiting for popup menu actor to map!"
    kill "$REPRO_PID" 2>/dev/null || true
    exit 1
fi

POPUP_CHECK="$(shell_eval '
(() => {
    const ext = Main.extensionManager.lookup("'$UUID'");
    const manager = ext?.stateObj?._manager;
    const actors = global.get_window_actors();
    return JSON.stringify({
        actorCount: actors.length,
        trackedCount: manager ? manager.trackedCount : -1,
        reconcilePending: Boolean(manager?.hasPendingWindowReconcile)
    });
})()
')"
echo ">> Popup check: $POPUP_CHECK"
if ! check_fields "$POPUP_CHECK" '{"actorCount": 2, "trackedCount": 1, "reconcilePending": false}'; then
    echo "!! Transient popup was incorrectly tracked or scheduled unmanaged reconcile!"
    kill "$REPRO_PID" 2>/dev/null || true
    exit 1
fi

# Both layers are about what happens *while the menu is open*, so sample its whole lifetime
# instead of one instant: a single look cannot tell "never scheduled" from "not scheduled
# yet", and it says nothing about the symptom the issue reported, a menu that vanishes.
# The sample covers the global debounced reconcile - the path this fix gates. A window that
# loses focus to the popup still reconciles through its own `notify::appears-focused` signal,
# which is reported, not asserted. The synchronous paths (`grab-op-end`, `restacked`) are not
# observable this way at all. Reading the manager's own bookkeeping is what the assertion is
# about: "the popup is not tracked" is a statement about trackedCount.
shell_eval '
(() => {
    global.__wnPopupSamples = [];
    global.__wnPopupTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
        const ext = Main.extensionManager.lookup("'$UUID'");
        const manager = ext?.stateObj?._manager;
        global.__wnPopupSamples.push({
            actors: global.get_window_actors().length,
            tracked: manager ? manager.trackedCount : -1,
            windowPending: Boolean(manager?.hasPendingWindowReconcile),
        });
        return global.__wnPopupSamples.length < 150 ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
    });
    return "started";
})()
' >/dev/null
sleep 2

POPUP_SAMPLES="$(shell_eval '
(() => {
    if (global.__wnPopupTimer) {
        GLib.Source.remove(global.__wnPopupTimer);
        global.__wnPopupTimer = null;
    }
    const samples = global.__wnPopupSamples ?? [];
    global.__wnPopupSamples = [];
    // Only the samples with the menu open say anything: those are "the menu is still there",
    // and in them it must neither be tracked nor have a reconcile queued. After the menu
    // closes a reconcile is expected, so those samples are not counted.
    const open = samples.filter(s => s.actors >= 2);
    // Scale-free on purpose: a busy machine slows the sampling down, so the claim is that
    // the menu was there for most of what we sampled, not a wall-clock count of samples. The
    // floor only rules out a sample set too short for "most of" to mean anything.
    const survived = open.length >= 10 && open.length * 2 >= samples.length;
    return JSON.stringify({
        sampleCount: samples.length,
        openSamples: open.length,
        survived,
        trackedBad: open.filter(s => s.tracked !== 1).length,
        reconcileScheduled: open.filter(s => s.windowPending).length,
    });
})()
')"
echo ">> Popup samples: $POPUP_SAMPLES"
if ! check_fields "$POPUP_SAMPLES" '{"survived": true, "trackedBad": 0, "reconcileScheduled": 0}'; then
    echo "!! The menu did not stay open, or was tracked, or queued a reconcile while it was open!"
    kill "$REPRO_PID" 2>/dev/null || true
    exit 1
fi
wait $REPRO_PID 2>/dev/null || true
for i in $(seq 1 30); do
    count="$(shell_eval 'global.get_window_actors().length' | grep -o '[0-9]\+' || echo "0")"
    if [[ "$count" -eq 0 ]]; then
        break
    fi
    sleep 0.1
done
echo ">> Menu survived most of the sampled window, was never tracked, and left no debounced reconcile pending (Layer 1 + Layer 2 passed)."

# X11 (Xwayland) windows: the X11 clip target is the window actor's first child, not the actor
# (src/lib/clipTarget.js) - a Wayland client never reaches that branch - and the resize band
# follows the frame reading: skipped on an SSD window (Mutter's frame owns the grab in its
# invisible border) and drawn on a bare one.
echo ">> [test-e2e] Verifying decoration on an X11 (Xwayland) window..."

# GTK's decorated=1 asks for server-side decoration on X11 (`_MOTIF_WM_HINTS`,
# gdk/x11/gdksurface-x11.c), so this is an SSD window: Mutter draws the frame, `win.decorated`
# is true, and the band is correctly skipped.
"$DEV" xapp env WINDOW_NATIVIZER_DECORATED=1 gjs "$ROOT/tools/probe-window.js" >/dev/null 2>&1 &
X11_PROBE_PID=$!
wait_for_x11_window() {
    for _ in $(seq 1 60); do
        local up
        up="$(shell_eval 'global.get_window_actors().some(a => a.meta_window.get_client_type() === 1) ? 1 : 0' | grep -o '[01]' | head -1 || echo 0)"
        [[ "$up" = "1" ]] && return 0
        sleep 0.1
    done
    return 1
}
if ! wait_for_x11_window; then
    echo "!! The X11 client never mapped a window"
    kill "$X11_PROBE_PID" 2>/dev/null || true
    exit 1
fi

# The effect attaches on the manager's next reconcile, and only after the async provider probe
# says the process is not Adwaita, so poll until it lands rather than reading once.
read_x11_state() {
    local reply
    reply="$(shell_eval '
    (() => {
        const actor = global.get_window_actors().find(a => a.meta_window.get_client_type() === 1);
        if (!actor) return JSON.stringify({found: false});
        const first = actor.get_first_child() ?? actor;
        const has = o => o.get_effects().some(e => e.toString().includes("RoundedClipEffect"));
        const band = global.window_group.get_children().some(c =>
            c.toString().includes("WindowNativizerResizeBand") && c._windowActor === actor);
        return JSON.stringify({found: true, onFirstChild: has(first), onActor: has(actor), band});
    })()
    ')"
    python3 - "$reply" << 'PYEOF'
import json, re, sys
match = re.search(r'\{.*\}', sys.argv[1].replace('\\', ''), re.S)
print(json.dumps(json.loads(match.group(0))) if match else '{"found": false}')
PYEOF
}

X11_STATE="$(await_state read_x11_state '
import json, sys
d = json.loads(sys.argv[1])
sys.exit(0 if d.get("found") and d.get("onFirstChild") and not d.get("onActor") else 1)
')" || {
    echo "!! The X11 clip did not attach to the X11 target (the window actor's first child): $X11_STATE"
    kill "$X11_PROBE_PID" 2>/dev/null || true
    exit 1
}
echo ">> X11 SSD window state: $X11_STATE"
if ! check_fields "$X11_STATE" '{"found": true, "onFirstChild": true, "onActor": false, "band": false}'; then
    echo "!! X11 SSD: the clip is not on the X11 target, or a band is drawn despite Mutter's frame: $X11_STATE"
    kill "$X11_PROBE_PID" 2>/dev/null || true
    exit 1
fi
echo ">> X11 SSD verified: clip on the X11 target; band skipped (Mutter's frame owns the grab)."

kill "$X11_PROBE_PID" 2>/dev/null || true
pkill -f "probe-window[.]js" 2>/dev/null || true
for i in $(seq 1 40); do
    count="$(shell_eval 'global.get_window_actors().length' | grep -o '[0-9]\+' || echo "0")"
    [[ "$count" -eq 0 ]] && break
    sleep 0.1
done

# Bare (undecorated, no ring, no frame): the band sits on the desktop around the body.
echo ">> [test-e2e] Verifying the band on a bare X11 window..."
"$DEV" xapp gjs "$ROOT/tools/probe-window.js" >/dev/null 2>&1 &
X11_PROBE_PID=$!
if ! wait_for_x11_window; then
    echo "!! The bare X11 client never mapped a window"
    kill "$X11_PROBE_PID" 2>/dev/null || true
    exit 1
fi
X11_BARE="$(await_state read_x11_state '
import json, sys
d = json.loads(sys.argv[1])
sys.exit(0 if d.get("found") and d.get("band") else 1)
')" || {
    echo "!! The bare X11 window never got its band: $X11_BARE"
    kill "$X11_PROBE_PID" 2>/dev/null || true
    exit 1
}
echo ">> X11 bare window state: $X11_BARE"
echo ">> X11 bare verified: band present on an undecorated X11 window."

kill "$X11_PROBE_PID" 2>/dev/null || true
pkill -f "probe-window[.]js" 2>/dev/null || true
for i in $(seq 1 40); do
    count="$(shell_eval 'global.get_window_actors().length' | grep -o '[0-9]\+' || echo "0")"
    [[ "$count" -eq 0 ]] && break
    sleep 0.1
done

# 8. Stress: repeated disable/enable must rebuild cleanly and leak no actors.
#    Each cycle tears down and rebuilds; a connect() without its disconnect(), or an actor
#    left in the scene graph, shows up here as a surviving WindowNativizer actor or a
#    decoration that is not rebuilt.
echo ">> [test-e2e] Stress: repeated disable/enable cycles with a window open..."
"$DEV" app env WINDOW_NATIVIZER_DECORATED=1 gjs "$ROOT/tools/probe-window.js" >/dev/null 2>&1 &
STRESS_PID=$!
STRESS_UP=0
for i in $(seq 1 30); do
    count="$(shell_eval 'global.get_window_actors().length' | grep -o '[0-9]\+' || echo "0")"
    if [[ "$count" -gt 0 ]]; then
        STRESS_UP=1
        break
    fi
    sleep 0.1
done
if [[ "$STRESS_UP" -ne 1 ]]; then
    echo "!! Timeout waiting for the stress window to map!"
    kill "$STRESS_PID" 2>/dev/null || true
    exit 1
fi
sleep 0.2

# Shadow actors and resize bands live in window_group; the clip is an effect on the window
# actor, so it is checked by the decoration rebuild instead.
nativizer_actor_count() {
    local reply
    reply="$(shell_eval '
    (() => {
        const n = global.window_group.get_children()
            .filter(c => c.toString().includes("WindowNativizer")).length;
        return JSON.stringify({n});
    })()
    ')"
    python3 - "$reply" << 'PYEOF'
import json, re, sys
match = re.search(r'\{.*\}', sys.argv[1].replace('\\', ''), re.S)
print(json.loads(match.group(0))["n"] if match else -1)
PYEOF
}

# The live extension object's manager: null after disable, populated after enable.
manager_state() {
    local reply
    reply="$(shell_eval '
    (async () => {
        const Main = await import("resource:///org/gnome/shell/ui/main.js");
        const ext = Main.extensionManager.lookup("'"$UUID"'")?.stateObj;
        const m = ext?._manager;
        return JSON.stringify({hasManager: !!m, windows: m?.trackedCount ?? -1});
    })()
    ')"
    python3 - "$reply" << 'PYEOF'
import json, re, sys
match = re.search(r'\{.*\}', sys.argv[1].replace('\\', ''), re.S)
print(json.dumps(json.loads(match.group(0))) if match else '{}')
PYEOF
}

STRESS_OK=1
for cycle in 1 2 3 4 5; do
    "$DEV" ext disable "$UUID" >/dev/null
    for _ in $(seq 1 40); do
        [[ "$(nativizer_actor_count)" -eq 0 ]] && break
        sleep 0.05
    done
    if [[ "$(nativizer_actor_count)" -ne 0 ]]; then
        echo "!! Cycle $cycle: WindowNativizer actors survived disable (leak)!"; STRESS_OK=0; break
    fi
    if ! check_fields "$(manager_state)" '{"hasManager": false}'; then
        echo "!! Cycle $cycle: manager still present after disable!"; STRESS_OK=0; break
    fi

    "$DEV" ext enable "$UUID" >/dev/null
    for _ in $(seq 1 40); do
        [[ "$(nativizer_actor_count)" -gt 0 ]] && break
        sleep 0.05
    done
    if [[ "$(nativizer_actor_count)" -le 0 ]]; then
        echo "!! Cycle $cycle: decorations were not rebuilt after enable!"; STRESS_OK=0; break
    fi
    # Exactly the one open window must be tracked - a duplicated connect would show as more.
    if ! check_fields "$(manager_state)" '{"hasManager": true, "windows": 1}'; then
        echo "!! Cycle $cycle: manager did not track the open window exactly once!"; STRESS_OK=0; break
    fi
done
kill "$STRESS_PID" 2>/dev/null || true
# `$!` is the dev.sh wrapper, not the gjs client it spawned; kill the client too, or it outlives
# this section and the next one counts it as an extra window.
pkill -f "probe-window[.]js" 2>/dev/null || true
wait "$STRESS_PID" 2>/dev/null || true
if [[ "$STRESS_OK" -ne 1 ]]; then
    exit 1
fi
# The window must be gone before the next section.
count=1
for i in $(seq 1 40); do
    count="$(shell_eval 'global.get_window_actors().length' | grep -o '[0-9]\+' || echo "0")"
    [[ "$count" -eq 0 ]] && break
    sleep 0.1
done
if [[ "$count" -ne 0 ]]; then
    echo "!! A probe window survived the reload-stress section ($count actor(s))"
    exit 1
fi
echo ">> 5 disable/enable cycles: no leaked actors, window tracked once each cycle."

# Actors are not the whole story: a disable() that drops every actor can still leave signal
# handlers connected on objects nothing will ever destroy. `tools/leak-probe.js` instruments
# GObject's connect for the duration of the cycles and reports the handlers that are still
# connected on a live object afterwards - one D-Bus implementation per cycle, before the fix.
echo ">> [test-e2e] Signal-handler leak probe: 5 disable/enable cycles..."
LEAK_CYCLES=5
LEAK_PROBE="$(sed -e "s/__UUID__/$UUID/" -e "s/'__CYCLES__'/'$LEAK_CYCLES'/" "$ROOT/tools/leak-probe.js")"
LEAK_STATE="$(shell_eval "$LEAK_PROBE")"
if ! check_fields "$LEAK_STATE" '{"ok": true}'; then
    echo "!! The signal-handler leak probe did not run: $LEAK_STATE"
    exit 1
fi
LEAK_HANDLERS="$(python3 - "$LEAK_STATE" << 'PYEOF'
import json, re, sys

reply = sys.argv[1]
match = re.search(r'\{.*\}', reply.replace('\\', ''), re.S)
print(len(json.loads(match.group(0)).get('handlers', [])) if match else -1)
PYEOF
)"
if [[ "$LEAK_HANDLERS" -ne 0 ]]; then
    echo "!! $LEAK_HANDLERS signal handler(s) survived $LEAK_CYCLES disable/enable cycles: $LEAK_STATE"
    exit 1
fi
echo ">> $LEAK_CYCLES cycles: 0 signal handlers survived disable."

# A window whose actor read throws must not take the teardown with it. Before the guard in
# Manager.disable(), the exception skipped `_windows.clear()`, the global signal disconnect and the
# manager drop, so the shell was told the extension was disabled while its Manager stayed wired -
# and every later enable() hit the idempotency guard and did nothing. The fault goes into the live
# manager, so this is the real disable() path and not a copy of it.
echo ">> [test-e2e] Teardown fault injection: a window that throws mid-teardown..."
FAULT_STATE="$(shell_eval '
(async () => {
    const Main = await import("resource:///org/gnome/shell/ui/main.js");
    const ext = Main.extensionManager.lookup("'"$UUID"'")?.stateObj;
    const manager = ext._manager;
    manager._windows.set(
        {get_compositor_private() { throw new Error("injected teardown fault"); }},
        {signals: []});
    let threw = false;
    try {
        ext.disable();
    } catch {
        threw = true;
    }
    const state = {
        threw,
        windows: manager.trackedCount,
        globalSignals: manager._signals.length,
        settingsHandlers: manager._settingsHandlerIds.length,
        dropped: ext._manager === null,
    };
    ext.enable();
    state.reEnabled = ext._manager !== null;
    return JSON.stringify(state);
})()
')"
if ! check_fields "$FAULT_STATE" '{"threw": false, "windows": 0, "globalSignals": 0, "settingsHandlers": 0, "dropped": true, "reEnabled": true}'; then
    echo "!! Teardown did not survive a throwing window: $FAULT_STATE"
    exit 1
fi
echo ">> Throwing window: teardown completed, nothing left behind, extension re-enabled."

# Many windows over several rounds, Wayland and X11 mixed, with a resize/maximize storm between.
# A leak that is per-window or per-reconcile only shows once the count exceeds one; the state
# has to return to empty every round and not grow across rounds.
echo ">> [test-e2e] Stress: windows over rounds, Wayland and X11 mixed..."

read_session_state() {
    local reply
    reply="$(shell_eval '
    (async () => {
        const Main = await import("resource:///org/gnome/shell/ui/main.js");
        const ext = Main.extensionManager.lookup("'"$UUID"'")?.stateObj;
        const m = ext?._manager;
        const kids = global.window_group.get_children();
        return JSON.stringify({
            actors: global.get_window_actors().length,
            tracked: m?.trackedCount ?? -1,
            bands: kids.filter(c => c.toString().includes("WindowNativizerResizeBand")).length,
            shadows: kids.filter(c => c.toString().includes("WindowNativizerShadowActor")).length,
        });
    })()
    ')"
    python3 - "$reply" << 'PYEOF'
import json, re, sys
match = re.search(r'\{.*\}', sys.argv[1].replace('\\', ''), re.S)
print(json.dumps(json.loads(match.group(0))) if match else '{}')
PYEOF
}

STRESS_WINDOWS=6
STRESS_ROUNDS=3
AWAIT_TRIES=150   # more windows map and reconcile than one; give the poll room
for round in $(seq 1 "$STRESS_ROUNDS"); do
    PIDS=()
    for i in $(seq 1 "$STRESS_WINDOWS"); do
        if (( i % 3 == 0 )); then
            "$DEV" xapp gjs "$ROOT/tools/probe-window.js" >/dev/null 2>&1 &
        else
            "$DEV" app gjs "$ROOT/tools/probe-window.js" >/dev/null 2>&1 &
        fi
        PIDS+=($!)
    done

    OPEN_STATE="$(await_state read_session_state "
import json, sys
d = json.loads(sys.argv[1])
sys.exit(0 if d.get('actors') == $STRESS_WINDOWS and d.get('tracked') == $STRESS_WINDOWS and d.get('bands') == $STRESS_WINDOWS else 1)
")" || {
        echo "!! Round $round: $STRESS_WINDOWS windows did not all map, track and band: $OPEN_STATE"
        kill "${PIDS[@]}" 2>/dev/null || true
        pkill -f "probe-window[.]js" 2>/dev/null || true
        exit 1
    }
    echo ">> Round $round open: $OPEN_STATE"

    shell_eval '
    (() => {
        for (const a of global.get_window_actors()) {
            const w = a.meta_window;
            if (!w.allows_resize?.()) continue;
            const f = w.get_frame_rect();
            w.move_resize_frame(false, f.x + 20, f.y + 20, 640, 480);
            w.maximize();
            w.unmaximize();
            w.move_resize_frame(false, f.x - 10, f.y - 10, 700, 520);
        }
    })()
    ' >/dev/null

    for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
    pkill -f "probe-window[.]js" 2>/dev/null || true

    CLOSED_STATE="$(await_state read_session_state "
import json, sys
d = json.loads(sys.argv[1])
sys.exit(0 if d.get('actors') == 0 and d.get('tracked') == 0 and d.get('bands') == 0 and d.get('shadows') == 0 else 1)
")" || {
        echo "!! Round $round: state did not return to empty after close (leak): $CLOSED_STATE"
        exit 1
    }
    echo ">> Round $round closed: $CLOSED_STATE"
done
echo ">> $STRESS_ROUNDS rounds x $STRESS_WINDOWS windows: every round returned to empty."

# 9. A D-Bus pick in flight must be answered even when the extension is disabled mid-pick.
#    The inspector owns the invocation; disable() has to cancel and answer it, or the caller
#    (prefs, which does not otherwise wait on a timeout) blocks forever. Built with the same
#    gdbus primitives as shell_eval, against the nested session's own bus.
echo ">> [test-e2e] A pick in flight is answered when the extension is disabled..."
rm -f "$PICK_REPLY"
PICK_BUS="$(get_dbus_bus)"
PICK_IFACE="org.gnome.Shell.Extensions.WindowNativizer"
PICK_PATH="/org/gnome/Shell/Extensions/WindowNativizer"
( gdbus call --address "$PICK_BUS" --dest "$PICK_IFACE" --object-path "$PICK_PATH" \
        --method "$PICK_IFACE".PickWindow > "$PICK_REPLY" 2>&1; echo $? >> "$PICK_REPLY" ) &
PICK_BG=$!
# Prove the pick is genuinely in flight before disabling: no reply yet, and the picker overlay
# on screen. Without this a pick that already returned would pass, exercising nothing.
PICK_PENDING=0
for _ in $(seq 1 120); do
    if tail -1 "$PICK_REPLY" 2>/dev/null | grep -q '^[0-9]\+$'; then
        echo "!! The pick returned before it could be interrupted; there was nothing to cancel!"
        kill "$PICK_BG" 2>/dev/null || true
        exit 1
    fi
    OVERLAY_STATE="$(shell_eval '
    (async () => {
        const Main = await import("resource:///org/gnome/shell/ui/main.js");
        const up = Main.uiGroup.get_children().some(c => c.name === "WindowNativizerInspectorOverlay");
        return JSON.stringify({overlay: up});
    })()
    ')"
    if check_fields "$OVERLAY_STATE" '{"overlay": true}'; then
        PICK_PENDING=1
        break
    fi
    sleep 0.05
done
if [[ "$PICK_PENDING" -ne 1 ]]; then
    echo "!! The pick never came on screen, so there was nothing to cancel!"
    kill "$PICK_BG" 2>/dev/null || true
    exit 1
fi
"$DEV" ext disable "$UUID" >/dev/null
PICK_ANSWERED=0
for _ in $(seq 1 60); do
    if tail -1 "$PICK_REPLY" 2>/dev/null | grep -q '^[0-9]\+$'; then
        PICK_ANSWERED=1
        break
    fi
    sleep 0.1
done
if [[ "$PICK_ANSWERED" -ne 1 ]]; then
    echo "!! A D-Bus pick hung after the extension was disabled mid-pick!"
    kill "$PICK_BG" 2>/dev/null || true
    exit 1
fi
if [[ "$(tail -1 "$PICK_REPLY")" -ne 0 ]]; then
    echo "!! The pick call failed instead of answering: $(cat "$PICK_REPLY")"
    exit 1
fi
"$DEV" ext enable "$UUID" >/dev/null
echo ">> A pick in flight was answered (empty result) on disable."

# The picker puts a full-screen reactive overlay on the stage. If it could not be put on screen,
# that overlay used to stay there swallowing every click, and the invocation was never answered, so
# every later pick was refused as BUSY. Injected by making `Main.uiGroup.add_child` throw - the one
# step of the picker's construction that can be forced from outside.
echo ">> [test-e2e] Pick failure injection: a picker that cannot be put on screen..."
PATCH_STATE="$(shell_eval '
(async () => {
    const Main = await import("resource:///org/gnome/shell/ui/main.js");
    global.__wnRealAddChild = Main.uiGroup.add_child;
    Main.uiGroup.add_child = function () { throw new Error("injected add_child fault"); };
    return JSON.stringify({patched: true});
})()
')"
if ! check_fields "$PATCH_STATE" '{"patched": true}'; then
    echo "!! Could not inject the picker fault: $PATCH_STATE"
    exit 1
fi

PICK_FAULT=$(mktemp)
for attempt in 1 2; do
    timeout 20 gdbus call --address "$PICK_BUS" --dest "$PICK_IFACE" \
        --object-path "$PICK_PATH" --method "$PICK_IFACE".PickWindow > "$PICK_FAULT" 2>&1 || true
    if grep -qi 'BUSY\|already in progress' "$PICK_FAULT"; then
        echo "!! Attempt $attempt was refused as BUSY instead of being answered: $(cat "$PICK_FAULT")"
        rm -f "$PICK_FAULT"
        exit 1
    fi
done
rm -f "$PICK_FAULT"

PICK_AFTERMATH="$(shell_eval '
(async () => {
    const Main = await import("resource:///org/gnome/shell/ui/main.js");
    Main.uiGroup.add_child = global.__wnRealAddChild;
    delete global.__wnRealAddChild;
    const ext = Main.extensionManager.lookup("'"$UUID"'")?.stateObj;
    const leftovers = Main.uiGroup.get_children()
        .filter(c => String(c.name ?? "").startsWith("WindowNativizerInspector")).length;
    return JSON.stringify({
        leftovers,
        pending: Boolean(ext._inspector?._pendingInvocation),
        pickable: ext._manager !== null,
    });
})()
')"
if ! check_fields "$PICK_AFTERMATH" '{"leftovers": 0, "pending": false, "pickable": true}'; then
    echo "!! A picker that failed to start left state behind: $PICK_AFTERMATH"
    exit 1
fi
echo ">> Failed picker: no overlay left on the stage, invocation answered, next pick not refused."

# The preferences window is a separate GTK4 process and nothing else here opens it. Its stderr still
# lands in $LOG - the shell spawns it - so a markup or JS error in prefs.js is visible only to a case
# that opens it. One was: a group title containing "&" was parsed as markup, failed, and rendered
# empty, with a Gtk-WARNING as its only trace.
echo ">> [test-e2e] Opening the preferences window..."
PREF_BUS="$(get_dbus_bus)"
DBUS_SESSION_BUS_ADDRESS="$PREF_BUS" timeout 20 gnome-extensions prefs "$UUID" >/dev/null 2>&1 || true

# Close it and then wait for it to be gone before the session stops. Two reasons, both measured:
# stopping with it still mapped makes Mutter close it during teardown, and that path pings the client
# with a serial it then rejects ("Tried to ping window ... with a bad serial"); and the roundtrip
# timestamp is the one Mutter accepts, where get_current_time() gives it nothing to ping with.
PREF_STATE='{}'
PREF_OPEN=0
PREF_CLOSED=0
for _ in $(seq 1 20); do
    PREF_STATE="$(shell_eval '
(async () => {
    const wins = global.get_window_actors().map(a => a.meta_window)
        .filter(w => (w.get_wm_class() || "") === "org.gnome.Shell.Extensions");
    for (const w of wins)
        w.delete(global.display.get_current_time_roundtrip());
    return JSON.stringify({found: wins.length});
})()
')"
    if check_fields "$PREF_STATE" '{"found": 1}'; then
        if [[ "$PREF_OPEN" == 0 ]]; then
            PREF_OPEN=1
        fi
    elif check_fields "$PREF_STATE" '{"found": 0}'; then
        if [[ "$PREF_OPEN" == 1 ]]; then
            PREF_CLOSED=1
            break
        fi
    fi
    sleep 2
done
if [[ "$PREF_OPEN" != 1 ]]; then
    echo "!! The preferences window never appeared: $PREF_STATE"
    exit 1
fi
if [[ "$PREF_CLOSED" != 1 ]]; then
    echo "!! The preferences window did not close: $PREF_STATE"
    exit 1
fi
echo ">> Preferences window opened and closed; anything it logged is audited below."

# 10. Stop shell before analyzing logs
"$DEV" stop >/dev/null 2>&1 || true

# 11. Log Inspection & Zero-Tolerance Assertion
echo "================================================================"
echo " Analyzing Shell Log for Warnings, Errors, and Criticals"
echo "================================================================"

python3 - "$LOG" << 'PYEOF'
import sys, re

log_path = sys.argv[1]
with open(log_path, "r", errors="ignore") as f:
    lines = f.readlines()

noise = re.compile(
    r'(AT-SPI|atk-bridge|Gvc-WARNING|xdg-desktop-portal|RealtimeKit|secrets|keyring|gvfsd-sftp|gsconnect|copyous|mark-shot|chinese-calendar|evolution|MESA: warning|pip-on-top|gsignal\.c:2723|gnome-calculator)',
    re.I
)

# One upstream defect is exempted on purpose, narrowly and with its evidence, rather than dropped
# into the noise bag above. Mutter hands a NULL colour state to a setter that requires one:
#
#   meta_wayland_actor_surface_real_sync_actor_state() (src/wayland/meta-wayland-actor-surface.c)
#     color_state = clutter_actor_get_color_state (surface_actor);   -> NULL when never set
#     if (surface->color_state) color_state = surface->color_state;  -> NULL without colour mgmt
#     clutter_actor_set_color_state (surface_actor, color_state);    -> g_return_if_fail prints this
#
# Introduced in 63fa79c878 (2024-07-16, "wayland/surface: Add double-buffered color state") and
# still in Mutter 50.4, so it fires for almost every client; the failed call returns immediately and
# there was nothing to write back, so the line is its only effect. Measured, not assumed: one window
# mapped and resized produces one of these with the extension enabled and one with it disabled.
# docs/shell-compatibility.md records it; the count is reported rather than swallowed.
mutter_color_state = re.compile(
    r"clutter_actor_set_color_state: assertion 'CLUTTER_IS_COLOR_STATE \(color_state\)' failed")

# Upstream ibus-portal logs a warning on D-Bus daemon shutdown during test teardown:
#   (ibus-portal:<pid>): GLib-GIO-WARNING **: ...: Error releasing name org.freedesktop.portal.IBus: The connection is closed
# It occurs when `dev.sh stop` terminates the test D-Bus broker while ibus-portal is still running.
# Like the Mutter colour state assertion above, this is counted and reported rather than swallowed silently.
ibus_teardown = re.compile(
    r"\(ibus-portal:\d+\): GLib-GIO-WARNING \*\*: .*: Error releasing name org\.freedesktop\.portal\.IBus: The connection is closed")

# Any GTK app in this nested session logs this when it finds no accessibility registry to register
# with - the nested session has no at-spi bus:
#   (<process>:<pid>): Gtk-CRITICAL **: ... Unable to register the application:
#     ... Could not activate remote peer 'org.a11y.atspi.Registry': unit failed
# Environment-only, not from the extension, and process-independent: the X11 case gets it from
# mutter-x11-frames and the preferences case from the prefs process. Counted, not swallowed.
a11y_registry_absent = re.compile(
    r": Gtk-CRITICAL \*\*: .*Unable to register the application.*org\.a11y\.atspi\.Registry")

# Creating an Adw.PreferencesWindow logs this twice in this GJS/libadwaita pair, once for the getter
# and once for the setter of the same property:
#   (<process>:<pid>): Gjs-WARNING **: ...: Type GITypeInfo of property
#     Adw.PreferencesWindow::visible-page does not match ... Falling back to slow path
# Upstream (GJS's introspection of a libadwaita property), not from the extension. Counted.
gjs_visible_page = re.compile(
    r": Gjs-WARNING \*\*: .*Type GITypeInfo of property Adw\.PreferencesWindow::visible-page")

# The teardown fault-injection case makes one tracked window throw from `get_compositor_private()`,
# to prove `disable()` finishes anyway. Catching and logging it is the behaviour under test, so
# exactly this line is expected - and exactly one of them: the pattern is narrower than the general
# window-nativizer one, it is matched first, and the count below is asserted. Any other extension
# error still fails the audit.
teardown_fault = re.compile(
    r"window-nativizer\] Failed to tear down a window decoration")

# The picker fault-injection case makes `Main.uiGroup.add_child` throw for two attempts, so exactly
# two of these are expected, for the same reasons and with the same count assertion.
picker_fault = re.compile(
    r"window-nativizer\] Failed to start the window picker")

# Detect true GLib / Gjs / Clutter / Mutter warnings, criticals, and errors
glib_issue = re.compile(r'(-WARNING\b|-CRITICAL\b|-ERROR\b|\b(WARNING|CRITICAL|ERROR)\s*\*\*:|JS ERROR)', re.I)
# Detect any log message from window-nativizer containing error, critical, or warning
csd_issue = re.compile(r'window-nativizer.*(warning|critical|error|exception)', re.I)

offending = []
exempted = 0
exempted_ibus = 0
exempted_a11y = 0
exempted_gjs_visible_page = 0
exempted_teardown = 0
exempted_picker = 0
for idx, line in enumerate(lines, start=1):
    if teardown_fault.search(line):
        exempted_teardown += 1
        continue
    if picker_fault.search(line):
        exempted_picker += 1
        continue
    # An extension error is checked before the noise bag: a genuine window-nativizer line whose
    # payload happens to contain e.g. "gnome-calculator" or "secrets" must not be swallowed.
    if csd_issue.search(line):
        offending.append(f"Line {idx}: {line.strip()}")
        continue
    if noise.search(line):
        continue
    if mutter_color_state.search(line):
        exempted += 1
        continue
    if ibus_teardown.search(line):
        exempted_ibus += 1
        continue
    if a11y_registry_absent.search(line):
        exempted_a11y += 1
        continue
    if gjs_visible_page.search(line):
        exempted_gjs_visible_page += 1
        continue
    if glib_issue.search(line):
        offending.append(f"Line {idx}: {line.strip()}")

if offending:
    print("!! [FAIL] Test detected unexpected Warnings/Errors/Criticals:")
    print("----------------------------------------------------------------")
    for item in offending:
        print(item)
    print("----------------------------------------------------------------")
    sys.exit(1)

# Each injected fault is expected to produce its own exact number of lines: a case that did not run,
# and one that logged more than it provokes, both fail.
for name, got, want in (("teardown", exempted_teardown, 1), ("picker", exempted_picker, 2)):
    if got != want:
        print(f"!! [FAIL] Expected exactly {want} line(s) from the injected {name} fault, found "
              f"{got}: the fault-injection case did not run, or it logged more than it provokes.")
        sys.exit(1)

if exempted:
    print(f">> {exempted} known upstream Mutter line(s) exempted (see the note above the pattern).")
if exempted_ibus:
    print(f">> {exempted_ibus} known upstream ibus teardown line(s) exempted (see docs/shell-compatibility.md).")
if exempted_a11y:
    print(f">> {exempted_a11y} environment-only a11y-registry line(s) exempted (see the note above the pattern).")
if exempted_gjs_visible_page:
    print(f">> {exempted_gjs_visible_page} known upstream GJS introspection line(s) exempted (see the note above the pattern).")
print(f">> {exempted_teardown + exempted_picker} injected-fault line(s) exempted (the fault-injection cases assert the counts).")
print(">> [PASS] ZERO unexpected Warnings, Errors, or Criticals detected.")
PYEOF
echo ">> Lifecycle Summary:"
echo "   - GJS Surface: PASSED (every member we call is callable, with the shape the code assumes; signatures above)"
echo "   - Shell Modules: PASSED (Main.overview.visible and Main.uiGroup are as assumed)"
echo "   - Window Map: PASSED (WindowNativizerRoundedClipEffect, WindowNativizerShadowActor & WindowNativizerResizeBand attached)"
echo "   - Shadow Blend: PASSED (focus out fades; focus in snaps; nothing blends with animations off)"
echo "   - Compositor Move: PASSED (Positions tracked synchronously)"
echo "   - Dynamic Resize Stress: PASSED (No allocation stalls or crashes)"
echo "   - Maximize / Unmaximize: PASSED"
echo "   - Window Destruction: PASSED (0 leaked shadow actors, 0 leaked resize bands)"
echo "   - Extension Reload: PASSED (band dropped on disable, rebuilt on enable)"
echo "   - Overview Clip Mode: PASSED (corners retained with hardware mipmapping in overview, restored on desktop)"
echo "   - Close Shadow Actor Sync: PASSED (shadow opacity synchronized with windowActor ease animation)"
echo "   - Partial & Full Maximize: PASSED (tiled ring drawn, constrained strips collapsed, fully maximized dropped, unmaximized restored)"
echo "   - Libadwaita client left alone: $LIBNATIVE_RESULT"
echo "   - Transient Popup Rejection (Layer 1 & 2): PASSED (unmanaged popup ignored, 0 unnecessary reconciles)"
echo "   - Reload Stress (5 cycles): PASSED (no leaked actors, window tracked once per cycle)"
echo "   - Signal-Handler Leak Probe ($LEAK_CYCLES cycles): PASSED (0 handlers survived disable)"
echo "   - Teardown Fault Injection: PASSED (a throwing window did not abort disable())"
echo "   - Multi-Window Stress ($STRESS_ROUNDS rounds x $STRESS_WINDOWS windows): PASSED (returned to empty every round)"
echo "   - Pick In Flight On Disable: PASSED (D-Bus invocation answered, no hang)"
echo "   - Pick Failure Injection: PASSED (no overlay left, answered, not left BUSY)"
echo "   - Preferences Window: PASSED (opened and closed; nothing it logged failed the audit)"
echo "   - X11 Window Decoration: PASSED (clip on the X11 target; SSD band skipped, bare band drawn)"
echo "   - Log Audit: PASSED (0 unexpected ERROR/CRITICAL/WARNING; known Mutter/ibus lines counted above)"
echo "================================================================"
exit 0
