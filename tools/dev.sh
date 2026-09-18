#!/usr/bin/env bash
# window-nativizer development helper: runs GNOME Shell + test applications in headless nested session
# Usage (or equivalent pnpm scripts, see package.json):
#   ./tools/dev.sh shell        # Starts headless nested shell in background (log: /tmp/window-nativizer-dev/shell.log)
#   ./tools/dev.sh log          # Streams nested shell log (Ctrl+C to exit)
#   ./tools/dev.sh app <cmd>    # Launches test application inside nested session (same WAYLAND_DISPLAY)
#   ./tools/dev.sh ext <subcmd> # Runs gnome-extensions command inside nested session D-Bus
#   ./tools/dev.sh stop         # Stops nested shell
#
# Safety principles (never kill the main desktop gnome-shell):
#   - All testing runs in a nested session (--headless + --virtual-monitor), zero contact with main desktop
#   - Enabling extension must go through nested session's own D-Bus (handled inside dev.sh)
#   - No hot-reload: on code change -> ./tools/dev.sh stop && ./tools/dev.sh shell

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"   # Repository root (script is under tools/)
# Sets SRC_DIR, UUID, EXT_DIR and deploy_ext().
source "$ROOT/tools/deploy-ext.sh"
WL_DISPLAY="wayland-window-nativizer"
STATE_DIR="/tmp/window-nativizer-dev"
PIDFILE="$STATE_DIR/shell.pid"
LOG="$STATE_DIR/shell.log"

mkdir -p "$STATE_DIR"

cmd_shell() {
    if [[ -f "$STATE_DIR/ready" ]] && [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        echo ">> Nested shell is already running (PID $(cat "$PIDFILE"))"
        return
    fi
    # Sync latest extension code + compile GSettings schema
    deploy_ext
    rm -f "$PIDFILE" "$LOG" "$STATE_DIR/ready"   # Clear old logs to avoid mixing session outputs

    echo ">> Starting headless nested shell (background, log: $LOG)"
    chmod +x "$ROOT/tools/dev-shell.sh"
    WINDOW_NATIVIZER_UUID="$UUID" setsid nohup dbus-run-session -- bash "$ROOT/tools/dev-shell.sh" > "$LOG" 2>&1 < /dev/null &
    disown
    # Wait until ready
    for i in $(seq 1 30); do
        if [[ -f "$STATE_DIR/ready" ]] && [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
            echo ">> Nested shell ready (PID $(cat "$PIDFILE"))"
            tail -5 "$LOG"
            return
        fi
        sleep 1
    done
    echo "!! Startup timed out, log tail:"
    tail -20 "$LOG"
    exit 1
}

cmd_log() {
    exec tail -f "$LOG"
}

cmd_app() {
    cmd_shell  # Ensure running
    echo ">> [nested] WAYLAND_DISPLAY=$WL_DISPLAY: $*"
    env WAYLAND_DISPLAY="$WL_DISPLAY" "$@"
}

cmd_ext() {
    cmd_shell
    # Run gnome-extensions inside nested session D-Bus (must go through nested shell's own bus)
    echo ">> [nested-dbus] gnome-extensions $*"
    pid="$(cat "$PIDFILE")"
    bus="$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep '^DBUS_SESSION_BUS_ADDRESS=' | cut -d= -f2- || true)"
    if [[ -n "$bus" ]]; then
        env DBUS_SESSION_BUS_ADDRESS="$bus" gnome-extensions "$@"
    else
        echo "!! Cannot find nested session bus address, please verify with ./dev.sh shell"; exit 1
    fi
}

cmd_stop() {
    if [[ -f "$PIDFILE" ]]; then
        echo ">> Stopping nested shell (PID $(cat "$PIDFILE"))"
        # Kill entire process tree (dbus-run-session cleans up along with it)
        pkill -f "wayland-display=$WL_DISPLAY" 2>/dev/null || true
        kill "$(cat "$PIDFILE")" 2>/dev/null || true
        rm -f "$PIDFILE" "$STATE_DIR/ready"
    fi
    echo ">> Cleaned up"
}

case "${1:-}" in
    shell) cmd_shell ;;
    log) cmd_log ;;
    app) shift; cmd_app "$@" ;;
    ext) shift; cmd_ext "$@" ;;
    stop) cmd_stop ;;
    *) echo "Usage: $0 {shell|log|app <cmd>|ext <subcmd>|stop}"; exit 1 ;;
esac
