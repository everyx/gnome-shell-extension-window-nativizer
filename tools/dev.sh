#!/usr/bin/env bash
# window-nativizer development helper: runs GNOME Shell + test applications in headless nested session
# Usage (or equivalent pnpm scripts, see package.json):
#   ./tools/dev.sh shell        # Starts headless nested shell in background (log: /tmp/window-nativizer-dev/shell.log)
#   ./tools/dev.sh log          # Streams nested shell log (Ctrl+C to exit)
#   ./tools/dev.sh app <cmd>    # Launches test application inside nested session (same WAYLAND_DISPLAY)
#   ./tools/dev.sh ext <subcmd> # Runs gnome-extensions command inside nested session D-Bus
#   ./tools/dev.sh dconf <args> # Runs dconf against the nested session's own settings database
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
export XDG_CONFIG_HOME="$STATE_DIR/config"

mkdir -p "$STATE_DIR" "$XDG_CONFIG_HOME"

cmd_shell() {
    if [[ -f "$STATE_DIR/ready" ]] && [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        echo ">> Nested shell is already running (PID $(cat "$PIDFILE"))"
        return
    fi
    # Sync latest extension code + compile GSettings schema
    deploy_ext
    rm -rf "$PIDFILE" "$LOG" "$STATE_DIR/ready" "$XDG_CONFIG_HOME"   # Clear old logs to avoid mixing session outputs
    mkdir -p "$XDG_CONFIG_HOME"

    echo ">> Starting headless nested shell (background, log: $LOG)"
    chmod +x "$ROOT/tools/dev-shell.sh"
    WINDOW_NATIVIZER_UUID="$UUID" XDG_CONFIG_HOME="$XDG_CONFIG_HOME" setsid nohup dbus-run-session -- bash "$ROOT/tools/dev-shell.sh" > "$LOG" 2>&1 < /dev/null &
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

# The nested session's own bus address, read from the shell process. Anything that has
# to reach the nested session rather than the developer's desktop needs this.
nested_bus() {
    local pid
    pid="$(cat "$PIDFILE")"
    tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep '^DBUS_SESSION_BUS_ADDRESS=' | cut -d= -f2- || true
}

cmd_ext() {
    cmd_shell
    # Run gnome-extensions inside nested session D-Bus (must go through nested shell's own bus)
    echo ">> [nested-dbus] gnome-extensions $*"
    local bus
    bus="$(nested_bus)"
    if [[ -n "$bus" ]]; then
        env XDG_CONFIG_HOME="$XDG_CONFIG_HOME" DBUS_SESSION_BUS_ADDRESS="$bus" gnome-extensions "$@"
    else
        echo "!! Cannot find nested session bus address, please verify with $0 shell"; exit 1
    fi
}

# A plain `dconf write` lands in the real desktop settings - see docs/development.md.
cmd_dconf() {
    cmd_shell
    echo ">> [nested-dconf] dconf $*"
    local bus
    bus="$(nested_bus)"
    if [[ -n "$bus" ]]; then
        env XDG_CONFIG_HOME="$XDG_CONFIG_HOME" DBUS_SESSION_BUS_ADDRESS="$bus" dconf "$@"
    else
        echo "!! Cannot find nested session bus address, please verify with $0 shell"; exit 1
    fi
}

cmd_stop() {
    if [[ -f "$PIDFILE" ]]; then
        echo ">> Stopping nested shell (PID $(cat "$PIDFILE"))"
        # Kill entire process tree (dbus-run-session cleans up along with it)
        pkill -f "wayland-display=$WL_DISPLAY" 2>/dev/null || true
        kill "$(cat "$PIDFILE")" 2>/dev/null || true
        rm -rf "$PIDFILE" "$STATE_DIR/ready" "$XDG_CONFIG_HOME"
    fi
    echo ">> Cleaned up"
}

case "${1:-}" in
    shell) cmd_shell ;;
    log) cmd_log ;;
    app) shift; cmd_app "$@" ;;
    ext) shift; cmd_ext "$@" ;;
    dconf) shift; cmd_dconf "$@" ;;
    stop) cmd_stop ;;
    *) echo "Usage: $0 {shell|log|app <cmd>|ext <subcmd>|dconf <args>|stop}"; exit 1 ;;
esac
