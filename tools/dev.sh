#!/usr/bin/env bash
# window-nativizer development helper: runs GNOME Shell + test applications in headless nested session
# Usage (or equivalent pnpm scripts, see package.json):
#   ./tools/dev.sh shell        # Starts headless nested shell in background (log: /tmp/window-nativizer-dev/shell.log)
#   ./tools/dev.sh log          # Streams nested shell log (Ctrl+C to exit)
#   ./tools/dev.sh app <cmd>    # Launches test application inside nested session (same WAYLAND_DISPLAY)
#   ./tools/dev.sh xapp <cmd>   # Launches an X11 (Xwayland) application inside the nested session
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
# The nested session is one shared resource; queue behind anyone already driving it. Re-entrant
# within this tree, so a holder that calls back into dev.sh (test-e2e.sh does this) does not
# deadlock. `log` only reads the log file and never touches the session, and `stop` is the teardown
# for a session that may *be* the current lock holder, so neither queues: a contended or wedged
# session can always be observed and always be taken down.
case "${1:-}" in
    log|stop) ;;
    *)
        if [ -z "${WN_SESSION_LOCK_HELD:-}" ]; then
            exec "$ROOT/tools/with-session-lock.sh" "$ROOT/tools/dev.sh" "$@"
        fi
        ;;
esac
# Sets SRC_DIR, UUID, EXT_DIR and deploy_ext().
source "$ROOT/tools/deploy-ext.sh"
# The extension's own compiled schema lives in its install directory, not in the system schema
# directories. GSETTINGS_SCHEMA_DIR is additive, so naming it here keeps every schema - system and
# extension - visible to the nested session and to every client this script starts. Without it a
# `Gio.Settings.new('org.gnome.shell.extensions.window-nativizer')` in an Eval snippet (which runs
# inside the shell process) has no such schema and takes the shell down with it.
export GSETTINGS_SCHEMA_DIR="$EXT_DIR/schemas"
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

    local scale="${1:-${WINDOW_NATIVIZER_SCALE:-1.0}}"
    echo ">> Starting headless nested shell (background, log: $LOG, scale: $scale)"
    chmod +x "$ROOT/tools/dev-shell.sh"
    # The marker is set explicitly, not merely inherited: everything the session spawns runs under
    # a lock its own tree already holds, and a tool started from inside the session (a client, an
    # Eval-driven helper, a terminal opened on the nested display) must run straight through
    # instead of queueing behind the session it belongs to.
    #
    # fd 9 is the session lock this script holds. The session outlives this script, so it must not
    # inherit that fd: an inherited fd keeps the flock held for as long as the nested shell lives,
    # which makes the lock look permanently held and turns every later `dev.sh app` - and `stop` -
    # into a wait on a session that is not driving anything. Closed here, the lock is held for the
    # startup (so two `dev.sh shell` runs still serialize) and released when this script exits.
    WN_SESSION_LOCK_HELD=1 WINDOW_NATIVIZER_UUID="$UUID" WINDOW_NATIVIZER_SCALE="$scale" \
        XDG_CONFIG_HOME="$XDG_CONFIG_HOME" \
        setsid nohup dbus-run-session -- bash "$ROOT/tools/dev-shell.sh" \
        9>&- > "$LOG" 2>&1 < /dev/null &
    local session_pid=$!
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
    # The session was setsid'd, so nothing here will reap it. Without this the half-started session
    # keeps the wayland display and the next `dev.sh shell` sees a live pidfile - reporting "already
    # running" - while the stale ready marker makes it look usable. `$session_pid` is the session
    # leader, so its process group is exactly this session (dbus-run-session, dev-shell.sh and any
    # gnome-shell it reached). A `pkill -f` on the display name cannot say that: the display name is
    # fixed, so it is a substring of every leg's command line and of a developer's nested shell too.
    kill -- "-$session_pid" 2>/dev/null || kill "$session_pid" 2>/dev/null || true
    rm -f "$STATE_DIR/ready" "$PIDFILE"
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

# The nested Xwayland runs inside a bwrap PID namespace (Mutter sandboxes it), so `pgrep
# Xwayland` cannot find it. Its display is in the shell's own log (cleared per run) and its
# auth file is the newest one the shell just wrote into the runtime dir.
nested_x11_display() {
    grep -oE 'Using public X11 display :[0-9]+' "$LOG" 2>/dev/null | tail -1 | grep -oE ':[0-9]+' || true
}

nested_xauthority() {
    local runtime="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
    ls -t "$runtime"/.mutter-Xwaylandauth.* 2>/dev/null | head -1 || true
}

# An X11 client against the nested compositor: exercises the X11 code paths a Wayland client
# never touches (the clip target's X11 branch, the X11 surface structure).
cmd_xapp() {
    cmd_shell
    local display auth
    display="$(nested_x11_display)"
    auth="$(nested_xauthority)"
    if [[ -z "$display" || -z "$auth" ]]; then
        echo "!! Could not resolve the nested XWayland display/auth (display='$display' auth='$auth')"
        exit 1
    fi
    echo ">> [nested-x11] DISPLAY=$display XAUTHORITY=$auth: $*"
    env DISPLAY="$display" XAUTHORITY="$auth" GDK_BACKEND=x11 "$@"
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

# The nested gnome-shell pids. The pidfile is trusted only while it still names this harness's
# shell, so a reused pid cannot become a target; otherwise the session's own command line is
# matched. The pattern is bracketed so it cannot match the pgrep invocation itself, and it pins
# --headless plus the fixed Wayland display, which is this harness's session shape: the desktop
# shell or a devkit session does not match it.
session_pids() {
    local pid cmd
    if [[ -f "$PIDFILE" ]]; then
        pid="$(cat "$PIDFILE")"
        if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
            cmd="$( { tr '\0' ' ' < "/proc/$pid/cmdline"; } 2>/dev/null || true)"
            if [[ "$cmd" == *gnome-shell*"wayland-display=$WL_DISPLAY"* ]]; then
                printf '%s\n' "$pid"
                return
            fi
        fi
    fi
    pgrep -f "gnome-shel[l] --headless --wayland --wayland-display=$WL_DISPLAY" 2>/dev/null || true
}

# Teardown, safe to run at any time and any number of times: it never takes the session lock (it
# may well be held by the session it is here to stop, or by a tool driving it), it accepts a
# missing or stale pidfile, and it always leaves the state directory ready for a fresh start.
cmd_stop() {
    local pids pid waited
    pids="$(session_pids)"
    if [[ -n "$pids" ]]; then
        for pid in $pids; do
            echo ">> Stopping nested shell (PID $pid)"
            # The exact process this harness identified, never the shared display name: `pkill -f`
            # on the display name is a substring match against every command line, so one leg's
            # teardown also killed the shell the next leg - or the developer - had just started.
            # dbus-run-session reaps the rest of the session when the shell exits.
            kill "$pid" 2>/dev/null || true
        done
        # Wait for the session to actually be gone, so the wayland display and the pidfile are
        # free before the next `dev.sh shell` runs.
        for waited in $(seq 1 50); do
            pids="$(session_pids)"
            [[ -z "$pids" ]] && break
            sleep 0.1
        done
    fi
    rm -rf "$PIDFILE" "$STATE_DIR/ready" "$XDG_CONFIG_HOME"
    echo ">> Cleaned up"
}

case "${1:-}" in
    shell) shift; cmd_shell "$@" ;;
    log) cmd_log ;;
    app) shift; cmd_app "$@" ;;
    xapp) shift; cmd_xapp "$@" ;;
    ext) shift; cmd_ext "$@" ;;
    dconf) shift; cmd_dconf "$@" ;;
    stop) cmd_stop ;;
    *) echo "Usage: $0 {shell|log|app <cmd>|xapp <cmd>|ext <subcmd>|dconf <args>|stop}"; exit 1 ;;
esac
