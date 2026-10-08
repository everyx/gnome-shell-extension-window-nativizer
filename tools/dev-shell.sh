#!/usr/bin/env bash
# Nested session startup script (invoked by dev.sh; separate file to avoid shell quoting issues)
set -u

# UUID passed from caller (dev.sh) via environment variable
UUID="${WINDOW_NATIVIZER_UUID:-window-nativizer@everyx.github.io}"
WL_DISPLAY="wayland-window-nativizer"
STATE_DIR="/tmp/window-nativizer-dev"
PIDFILE="$STATE_DIR/shell.pid"

# Note: this script runs inside dbus-run-session bash (see dev.sh)
export G_MESSAGES_DEBUG='GNOME Shell'
export WINDOW_NATIVIZER_UUID="$UUID"
export XDG_CONFIG_HOME="$STATE_DIR/config"
mkdir -p "$XDG_CONFIG_HOME"

# Pre-populate isolated dconf so only our extension is enabled (isolating from host extensions)
if ! gsettings set org.gnome.shell enabled-extensions "['$UUID']"; then
    echo "!! Failed to pre-populate isolated enabled-extensions in test sandbox!" >&2
    exit 1
fi

SCALE="${WINDOW_NATIVIZER_SCALE:-1.0}"
if [[ "$SCALE" != "1.0" && "$SCALE" != "1" ]]; then
    gsettings set org.gnome.mutter experimental-features "['scale-monitor-framebuffer']" 2>/dev/null || true
fi

gnome-shell --headless --wayland --wayland-display="$WL_DISPLAY" \
    --virtual-monitor 1920x1080 --unsafe-mode &
echo $! > "$PIDFILE"
sleep 4

# Workaround for headless mode: without GDM activation flow, window_group remains hidden,
# window actors are never mapped (visual testing distorts). Force show window_group and
# dismiss initial overview via Eval, polling until overview is genuinely hidden.
is_settled() {
    python3 - "$1" << 'PYEOF'
import json, re, sys
# GVariant prints the reply string with its quotes backslash-escaped (twice, through the
# Eval wrapper); strip backslashes before reading the JSON object.
match = re.search(r'\{.*\}', sys.argv[1].replace('\\', ''), re.S)
if match:
    try:
        if json.loads(match.group(0)).get("settled") is True:
            sys.exit(0)
    except Exception:
        pass
sys.exit(1)
PYEOF
}

SETTLED=0
for i in $(seq 1 15); do
    BUS_ADDR="$(tr '\0' '\n' < /proc/$!/environ 2>/dev/null | grep '^DBUS_SESSION_BUS_ADDRESS=' | cut -d= -f2-)"
    if [[ -n "$BUS_ADDR" ]]; then
        eval_reply="$(gdbus call --address "$BUS_ADDR" --dest org.gnome.Shell \
            --object-path /org/gnome/Shell \
            --method org.gnome.Shell.Eval \
            '(async () => {
                const Main = await import("resource:///org/gnome/shell/ui/main.js");
                const GLib = imports.gi.GLib;
                global.window_group.show();
                if (Main.overview.visible) Main.overview.hide();
                for (let j = 0; j < 30; j++) {
                    if (!Main.overview.visible) return JSON.stringify({settled: true});
                    await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { r(); return GLib.SOURCE_REMOVE; }));
                }
                return JSON.stringify({settled: !Main.overview.visible});
            })()' 2>/dev/null || true)"
        if is_settled "$eval_reply"; then
            echo "window_group.show() & overview.hide() OK (attempt $i)"
            SETTLED=1
            break
        fi
    fi
    sleep 1
done
if [[ "$SETTLED" -ne 1 ]]; then
    echo "!! Failed to initialize window_group and dismiss overview after 15 attempts!"
    exit 1
fi

# Enable extension and verify active status (via nested session's own D-Bus)
# The state's spelling is the line's own (45 says ENABLED, 50 says ACTIVE); accept the shell's
# answer instead of matching one word for it.
ENABLED=0
for _ in $(seq 1 20); do
    gnome-extensions enable "$UUID" >/dev/null 2>&1 || true
    if gnome-extensions info "$UUID" 2>/dev/null | grep -qE "State: (ACTIVE|ENABLED)"; then
        ENABLED=1
        break
    fi
    sleep 0.2
done
if [[ "$ENABLED" -ne 1 ]]; then
    echo "!! Extension failed to activate after 20 attempts!"
    exit 1
fi
gnome-extensions info "$UUID" || true

if [[ "$SCALE" != "1.0" && "$SCALE" != "1" ]]; then
    BUS_ADDR="$(tr '\0' '\n' < /proc/$!/environ 2>/dev/null | grep '^DBUS_SESSION_BUS_ADDRESS=' | cut -d= -f2-)"
    if [[ -n "$BUS_ADDR" ]]; then
        python3 - "$BUS_ADDR" "$SCALE" << 'PYEOF'
import sys, subprocess, time
bus_addr, scale_str = sys.argv[1], sys.argv[2]
scale = float(scale_str)
if abs(scale - 1.33) < 0.01:
    scale = 4.0 / 3.0
cmd_state = ["gdbus", "call", "--address", bus_addr, "--dest", "org.gnome.Mutter.DisplayConfig",
             "--object-path", "/org/gnome/Mutter/DisplayConfig",
             "--method", "org.gnome.Mutter.DisplayConfig.GetCurrentState"]
res = subprocess.check_output(cmd_state).decode()
serial = res.split("(", 1)[1].split(",", 1)[0].replace("uint32", "").strip()
cmd_apply = [
    "gdbus", "call", "--address", bus_addr, "--dest", "org.gnome.Mutter.DisplayConfig",
    "--object-path", "/org/gnome/Mutter/DisplayConfig",
    "--method", "org.gnome.Mutter.DisplayConfig.ApplyMonitorsConfig",
    str(serial), "1", f'[(0, 0, {scale}, uint32 0, true, [("Meta-0", "1920x1080@60.000", @a{{sv}} {{}})])]', "@a{sv} {}"
]
subprocess.check_call(cmd_apply)
time.sleep(0.5)
PYEOF
    fi
fi

touch "$STATE_DIR/ready"

wait
