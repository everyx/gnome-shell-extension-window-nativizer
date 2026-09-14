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

gnome-shell --headless --wayland --wayland-display="$WL_DISPLAY" \
    --virtual-monitor 1920x1080 --unsafe-mode &
echo $! > "$PIDFILE"
sleep 4

# Workaround for headless mode: without GDM activation flow, window_group remains hidden,
# window actors are never mapped (visual testing distorts). Force show via Eval.
for i in $(seq 1 15); do
    BUS_ADDR="$(tr '\0' '\n' < /proc/$!/environ 2>/dev/null | grep '^DBUS_SESSION_BUS_ADDRESS=' | cut -d= -f2-)"
    if [[ -n "$BUS_ADDR" ]]; then
        if gdbus call --address "$BUS_ADDR" --dest org.gnome.Shell \
            --object-path /org/gnome/Shell \
            --method org.gnome.Shell.Eval \
            'global.window_group.show()' >/dev/null 2>&1; then
            echo "window_group.show() OK (attempt $i)"
            break
        fi
    fi
    sleep 1
done

# Enable extension and print status (via nested session's own D-Bus)
gnome-extensions enable "$UUID" || true
gnome-extensions info "$UUID" || true

wait
