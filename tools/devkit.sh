#!/bin/bash
# Nested development session (GNOME 50+: --devkit, mutter 50 removed --nested)
#
# Distinct from headless: devkit features a real rendering pipeline (virtual monitor +
# Screencast stream + libei input emulation), properly rendering windowGroup.
#
# Usage:
#   ./tools/devkit.sh            # Run in foreground with filtered logs
#   ./tools/devkit.sh bg         # Run in background (for script automation)
#   mdk client: /usr/lib/mutter-devkit (automatically spawned or run separately to view UI)
#
# Note: Do not pass --virtual-monitor (prevents overriding the MDK client's primary monitor role)
set -e
cd "$(dirname "$0")/.."

ROOT="$(pwd)"
# Sets SRC_DIR, UUID, EXT_DIR and deploy_ext().
source "$ROOT/tools/deploy-ext.sh"
LOG=/tmp/window-nativizer-devkit.log
PIDFILE=/tmp/window-nativizer-devkit.pid

deploy_ext

if [ "$1" = "bg" ]; then
    setsid dbus-run-session gnome-shell --devkit --wayland --unsafe-mode >"$LOG" 2>&1 < /dev/null &
    session_pid=$!
    echo "$session_pid" > "$PIDFILE"
    # Poll rather than sleep a fixed seven seconds: a slow start must not be reported as a failure,
    # and the pid dying is the other way this ends.
    for _ in $(seq 1 30); do
        pgrep -f "gnome-shell --devkit" > /dev/null && break
        kill -0 "$session_pid" 2>/dev/null || break
        sleep 0.5
    done
    if ! pgrep -f "gnome-shell --devkit" > /dev/null; then
        echo "FAILED: Session failed to start, log tail:"; tail -5 "$LOG"
        # Nothing else reaps it, and a pidfile left behind names a pid that will be reused.
        kill -- "-$session_pid" 2>/dev/null || true
        pkill -f "gnome-shell --devkit" 2>/dev/null || true
        rm -f "$PIDFILE"
        exit 1
    fi
    echo "OK: PID $session_pid, log: $LOG"
    grep -a "display name" "$LOG" | tail -1
    exit 0
fi

echo "=== devkit nested session ==="
echo "Log: $LOG (Ctrl+C to exit)"
echo "Connect GUI client in another terminal: /usr/lib/mutter-devkit"
echo ""

dbus-run-session gnome-shell --devkit --wayland --unsafe-mode 2>&1 \
  | tee "$LOG" \
  | grep -v -E '(^$|a11y|dbus-daemon|gvfs|systemd1|fusermount|AT-SPI|XKEYBOARD)' \
  | grep --line-buffered -E '(window-nativizer|Gjs|JS ERROR|libmutter|CRITICAL|Warning|Running GNOME|display name|extension)' \
    || true
