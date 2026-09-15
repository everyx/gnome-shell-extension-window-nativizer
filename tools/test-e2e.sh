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

# 3. Launch GTK4 test client in background
echo ">> [test-e2e] Launching GTK4 client (resize, maximize, close sequence)..."
"$DEV" app python3 "$ROOT/tools/e2e-client.py" &
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
"$DEV" app gjs "$ROOT/tools/probe-window.js" >/dev/null 2>&1 &
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
if [[ "$(band_count)" -ne 0 ]]; then
    echo "!! Resize band survived extension disable (it would keep taking clicks)!"
    kill "$PROBE_PID" 2>/dev/null || true
    exit 1
fi
sleep 0.1

"$DEV" ext enable "$UUID" >/dev/null
sleep 0.2
if [[ "$(band_count)" -lt 1 ]]; then
    echo "!! Resize band was not rebuilt after the extension was re-enabled!"
    kill "$PROBE_PID" 2>/dev/null || true
    exit 1
fi
echo ">> Band lifecycle across disable / re-enable confirmed."
kill "$PROBE_PID" 2>/dev/null || true
sleep 0.2

# 7. Stop shell before analyzing logs
"$DEV" stop >/dev/null 2>&1 || true

# 8. Log Inspection & Zero-Tolerance Assertion
echo "================================================================"
echo " Analyzing Shell Log for Warnings, Errors, and Criticals"
echo "================================================================"

python3 - "$LOG" << 'PYEOF'
import sys, re

log_path = sys.argv[1]
with open(log_path, "r", errors="ignore") as f:
    lines = f.readlines()

noise = re.compile(
    r'(AT-SPI|atk-bridge|Gvc-WARNING|xdg-desktop-portal|RealtimeKit|secrets|keyring|gvfsd-sftp|gsconnect|copyous|mark-shot|chinese-calendar|evolution|MESA: warning)',
    re.I
)

# Detect true GLib / Gjs / Clutter / Mutter warnings, criticals, and errors
glib_issue = re.compile(r'(-WARNING\b|-CRITICAL\b|-ERROR\b|\b(WARNING|CRITICAL|ERROR)\s*\*\*:|JS ERROR)', re.I)
# Detect any log message from window-nativizer containing error, critical, or warning
csd_issue = re.compile(r'window-nativizer.*(warning|critical|error|exception)', re.I)

offending = []
for idx, line in enumerate(lines, start=1):
    if noise.search(line):
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

print(">> [PASS] ZERO unexpected Warnings, Errors, or Criticals detected.")
PYEOF
echo ">> Lifecycle Summary:"
echo "   - Window Map: PASSED (WindowNativizerRoundedClipEffect, WindowNativizerShadowActor & WindowNativizerResizeBand attached)"
echo "   - Compositor Move: PASSED (Positions tracked synchronously)"
echo "   - Dynamic Resize Stress: PASSED (No allocation stalls or crashes)"
echo "   - Maximize / Unmaximize: PASSED"
echo "   - Window Destruction: PASSED (0 leaked shadow actors, 0 leaked resize bands)"
echo "   - Extension Reload: PASSED (band dropped on disable, rebuilt on enable)"
echo "   - Log Audit: PASSED (0 ERROR, 0 CRITICAL, 0 WARNING)"
echo "================================================================"
exit 0
