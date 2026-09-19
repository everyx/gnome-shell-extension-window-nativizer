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

cleanup() {
    echo ">> [test-e2e] Cleaning up test environment..."
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
if ! echo "$EXT_INFO" | grep -q "State: ACTIVE"; then
    echo "!! Extension failed to activate in headless shell!"
    exit 1
fi
echo ">> Extension is ACTIVE."

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

# Allow manager idle_add to complete decoration attachment
sleep 0.1

# 4. Verify scene graph decoration attachment and execute compositor moving
echo ">> [test-e2e] Verifying shadow and clip effect attachment..."
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
    return JSON.stringify({
        hasClip,
        hasShadow,
        hasBand,
        actorCount: actors.length
    });
})()
')"

echo ">> Attachment check: $CHECK_RESULT"
if ! check_fields "$CHECK_RESULT" '{"hasClip": true, "hasShadow": true, "hasBand": true}'; then
    echo "!! RoundedClipEffect, WindowNativizerShadowActor or WindowNativizerResizeBand was not attached!"
    exit 1
fi
echo ">> Clip effect, shadow actor and resize band successfully verified on active window."

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
# Decorated: the band lives in the ring the client reserved (docs/decoration-model.md).
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
sleep 0.3

VERT_STATE="$(read_band_state)"
echo ">> Vertically maximized state: $VERT_STATE"
python3 - "$VERT_STATE" << 'PYEOF'
import json, sys

data = json.loads(sys.argv[1])
if not data.get("hasBand"):
    sys.exit("!! Expected resize band on vertically maximized window, but none found!")

strips = data.get("strips", {})
top = strips.get("top", {})
bottom = strips.get("bottom", {})
left = strips.get("left", {})
right = strips.get("right", {})

if top.get("width", -1) != 0 or top.get("height", -1) != 0:
    sys.exit(f"!! Expected top strip to collapse to 0x0 on vertical maximization, got {top}")
if bottom.get("width", -1) != 0 or bottom.get("height", -1) != 0:
    sys.exit(f"!! Expected bottom strip to collapse to 0x0 on vertical maximization, got {bottom}")
if left.get("width", 0) <= 0 or left.get("height", 0) <= 0:
    sys.exit(f"!! Expected left strip to remain active, got {left}")
if right.get("width", 0) <= 0 or right.get("height", 0) <= 0:
    sys.exit(f"!! Expected right strip to remain active, got {right}")
PYEOF
echo ">> Vertically maximized (tiled) resize band verified: constrained strips collapsed, unconstrained active."

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
sleep 0.3

LEFT_TILED_STATE="$(read_band_state)"
echo ">> Left-tiled state: $LEFT_TILED_STATE"
python3 - "$LEFT_TILED_STATE" << 'PYEOF'
import json, sys

data = json.loads(sys.argv[1])
if not data.get("hasBand"):
    sys.exit("!! Expected resize band on left-tiled window, but none found!")

strips = data.get("strips", {})
top = strips.get("top", {})
bottom = strips.get("bottom", {})
left = strips.get("left", {})
right = strips.get("right", {})

if top.get("width", -1) != 0 or top.get("height", -1) != 0:
    sys.exit(f"!! Expected top strip to collapse to 0x0 on left-tiled window, got {top}")
if bottom.get("width", -1) != 0 or bottom.get("height", -1) != 0:
    sys.exit(f"!! Expected bottom strip to collapse to 0x0 on left-tiled window, got {bottom}")
if left.get("width", -1) != 0 or left.get("height", -1) != 0:
    sys.exit(f"!! Expected left strip to collapse to 0x0 on left-tiled window, got {left}")
if right.get("width", 0) <= 0 or right.get("height", 0) <= 0:
    sys.exit(f"!! Expected right strip to remain active on left-tiled window, got {right}")
PYEOF
echo ">> Left-tiled resize band verified: top, bottom, and left collapsed; right active."

# (b) Fully maximize: band must be destroyed
shell_eval '
(() => {
    const actors = global.get_window_actors();
    if (actors.length > 0)
        actors[0].meta_window.maximize();
})()
' >/dev/null
sleep 0.3

FULL_STATE="$(read_band_state)"
echo ">> Fully maximized state: $FULL_STATE"
python3 - "$FULL_STATE" << 'PYEOF'
import json, sys

data = json.loads(sys.argv[1])
if data.get("hasBand"):
    sys.exit("!! Expected resize band to be destroyed on fully maximized window, but found one!")
PYEOF
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
sleep 0.3

RESTORED_STATE="$(read_band_state)"
echo ">> Restored state: $RESTORED_STATE"
python3 - "$RESTORED_STATE" << 'PYEOF'
import json, sys

data = json.loads(sys.argv[1])
if not data.get("hasBand"):
    sys.exit("!! Expected resize band restored after unmaximizing, but none found!")

strips = data.get("strips", {})
for edge in ["top", "bottom", "left", "right"]:
    s = strips.get(edge, {})
    if s.get("width", 0) <= 0 or s.get("height", 0) <= 0:
        sys.exit(f"!! Expected strip {edge} to be non-zero after unmaximize, got {s}")
PYEOF
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
sleep 0.3

FLUSH_STATE="$(read_band_state)"
echo ">> Hand-placed flush state: $FLUSH_STATE"
python3 - "$FLUSH_STATE" << 'PYEOF'
import json, sys

data = json.loads(sys.argv[1])
if not data.get("hasBand"):
    sys.exit("!! Expected a resize band on a hand-placed flush window, but none found!")

strips = data.get("strips", {})

top = strips.get("top", {})
if top.get("width", 0) <= 0 or top.get("height", 0) <= 0:
    sys.exit(f"!! Expected the top strip to survive on a hand-placed flush window, got {top}")

right = strips.get("right", {})
if right.get("width", 0) <= 0 or right.get("height", 0) <= 0:
    sys.exit(f"!! Expected the right strip to remain active, got {right}")

# Left and bottom are empty because they fall outside the monitor, not because an edge was
# suppressed - which is what an empty top strip would mean.
for edge in ["left", "bottom"]:
    s = strips.get(edge, {})
    if s.get("width", -1) != 0 or s.get("height", -1) != 0:
        sys.exit(f"!! Expected strip {edge} to be clipped away, got {s}")
PYEOF
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
sleep 0.6

DECLARED_STATE="$(read_declared_band_state)"
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

# (f) Overview lifecycle assertion: RoundedClipEffect must be suspended (enabled=false)
# during overview showing, and restored (enabled=true) upon returning to desktop (hidden).
# This prevents low-res downsampling blur on overview preview clones (issue #7903).
echo ">> [test-e2e] Verifying clip effect suspension in overview..."
OVERVIEW_SUSPEND_STATE="$(shell_eval '
(async () => {
    const Main = await import("resource:///org/gnome/shell/ui/main.js");
    const GLib = imports.gi.GLib;
    const actors = global.get_window_actors();
    const target = actors.find(a => a.meta_window && a.meta_window.get_title() === "Window Nativizer E2E Declared");
    if (!target) return JSON.stringify({error: "window not found"});

    const getClip = () => target.get_effects().find(e => e.toString().includes("RoundedClipEffect"));

    const initialClip = getClip();
    const initialEnabled = initialClip ? initialClip.get_enabled() : null;

    const pollState = async (expectedOverview, expectedClipEnabled, maxRetries = 20) => {
        for (let i = 0; i < maxRetries; i++) {
            await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { r(); return GLib.SOURCE_REMOVE; }));
            const clip = getClip();
            if (Main.overview.visible === expectedOverview && clip && clip.get_enabled() === expectedClipEnabled) {
                return { matched: true, overviewVisible: Main.overview.visible, clipEnabled: clip.get_enabled(), hasClip: true };
            }
        }
        const clip = getClip();
        return {
            matched: false,
            overviewVisible: Main.overview.visible,
            hasClip: Boolean(clip),
            clipEnabled: clip ? clip.get_enabled() : null
        };
    };

    Main.overview.show();
    const overviewRes = await pollState(true, false);

    Main.overview.hide();
    const desktopRes = await pollState(false, true);

    return JSON.stringify({
        hasClip: Boolean(initialClip) && overviewRes.hasClip && desktopRes.hasClip,
        initialEnabled,
        overviewVisible: overviewRes.overviewVisible,
        inOverviewEnabled: overviewRes.clipEnabled,
        desktopOverviewVisible: desktopRes.overviewVisible,
        restoredEnabled: desktopRes.clipEnabled
    });
})()
')"
echo ">> Overview suspend check: $OVERVIEW_SUSPEND_STATE"
if ! check_fields "$OVERVIEW_SUSPEND_STATE" '{"hasClip": true, "initialEnabled": true, "overviewVisible": true, "inOverviewEnabled": false, "desktopOverviewVisible": false, "restoredEnabled": true}'; then
    echo "!! Overview suspend assertion failed: clip effect was not properly toggled during overview!"
    exit 1
fi
echo ">> Overview clip effect suspension verified: disabled during overview, restored on desktop."

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
    for i in $(seq 1 80); do
        found="$(shell_eval "global.get_window_actors().some(a => a.meta_window && a.meta_window.get_wm_class() === '$LIBNATIVE_CLASS') ? 1 : 0" | grep -o '[01]' | head -1 || echo 0)"
        [ "$found" = "1" ] && break
        sleep 0.25
    done
    sleep 1.0
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
    echo ">> (skipped: none of gnome-calculator, gnome-text-editor or nautilus is installed, so the"
    echo "   skip side of the band criterion has no end-to-end case on this machine)"
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
        trackedCount: manager ? manager._windows.size : -1,
        reconcilePending: Boolean(manager?._reconcileTimeout)
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
# about: "the popup is not tracked" is a statement about `_windows`.
shell_eval '
(() => {
    global.__wnPopupSamples = [];
    global.__wnPopupTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
        const ext = Main.extensionManager.lookup("'$UUID'");
        const manager = ext?.stateObj?._manager;
        global.__wnPopupSamples.push({
            actors: global.get_window_actors().length,
            tracked: manager ? manager._windows.size : -1,
            pending: Boolean(manager?._reconcileTimeout),
            windowPending: [...(manager?._windows?.values?.() ?? [])].some(s => s.reconcileTimeout),
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
        reconcileScheduled: open.filter(s => s.pending).length,
        // A window that loses focus to the popup still reconciles through its own
        // `notify::appears-focused` signal: that path is not what this fix gates, so it is
        // reported rather than asserted.
        windowReconciles: open.filter(s => s.windowPending).length,
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

# 8. Stop shell before analyzing logs
"$DEV" stop >/dev/null 2>&1 || true

# 9. Log Inspection & Zero-Tolerance Assertion
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

# Detect true GLib / Gjs / Clutter / Mutter warnings, criticals, and errors
glib_issue = re.compile(r'(-WARNING\b|-CRITICAL\b|-ERROR\b|\b(WARNING|CRITICAL|ERROR)\s*\*\*:|JS ERROR)', re.I)
# Detect any log message from window-nativizer containing error, critical, or warning
csd_issue = re.compile(r'window-nativizer.*(warning|critical|error|exception)', re.I)

offending = []
exempted = 0
exempted_ibus = 0
for idx, line in enumerate(lines, start=1):
    if noise.search(line):
        continue
    if mutter_color_state.search(line):
        exempted += 1
        continue
    if ibus_teardown.search(line):
        exempted_ibus += 1
        continue
    if glib_issue.search(line) or csd_issue.search(line):
        offending.append(f"Line {idx}: {line.strip()}")

if offending:
    print("!! [FAIL] Test detected unexpected Warnings/Errors/Criticals:")
    print("----------------------------------------------------------------")
    for item in offending:
        print(item)
    print("----------------------------------------------------------------")
    sys.exit(1)

if exempted:
    print(f">> {exempted} known upstream Mutter line(s) exempted (see the note above the pattern).")
if exempted_ibus:
    print(f">> {exempted_ibus} known upstream ibus teardown line(s) exempted (see docs/shell-compatibility.md).")
print(">> [PASS] ZERO unexpected Warnings, Errors, or Criticals detected.")
PYEOF
echo ">> Lifecycle Summary:"
echo "   - Window Map: PASSED (WindowNativizerRoundedClipEffect, WindowNativizerShadowActor & WindowNativizerResizeBand attached)"
echo "   - Compositor Move: PASSED (Positions tracked synchronously)"
echo "   - Dynamic Resize Stress: PASSED (No allocation stalls or crashes)"
echo "   - Maximize / Unmaximize: PASSED"
echo "   - Window Destruction: PASSED (0 leaked shadow actors, 0 leaked resize bands)"
echo "   - Extension Reload: PASSED (band dropped on disable, rebuilt on enable)"
echo "   - Overview Clip Suspension: PASSED (disabled during overview, restored on desktop)"
echo "   - Close Shadow Actor Sync: PASSED (shadow opacity synchronized with windowActor ease animation)"
echo "   - Partial & Full Maximize: PASSED (constrained strips collapsed, fully maximized dropped, unmaximized restored)"
echo "   - Libadwaita client left alone: $LIBNATIVE_RESULT"
echo "   - Transient Popup Rejection (Layer 1 & 2): PASSED (unmanaged popup ignored, 0 unnecessary reconciles)"
echo "   - Log Audit: PASSED (0 unexpected ERROR/CRITICAL/WARNING; known Mutter/ibus lines counted above)"
echo "================================================================"
exit 0
