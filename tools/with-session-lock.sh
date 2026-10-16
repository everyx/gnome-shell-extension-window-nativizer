#!/usr/bin/env bash
# Serialize the one shared nested session across every tool that drives it.
#
# The nested gnome-shell, the installed extension path and /tmp/window-nativizer-dev are a single
# shared resource. Two overlapping runs corrupt each other's session, and the damage reads as a
# real defect: a pixel-fidelity check failed with "environment witness ... 28 gray level(s)" while
# another nested session rendered over it, and the pre-push e2e failed only because a second
# session was up. Both passed on a quiet re-run, which is the signature of a collision rather than
# a bug. A queue fixes it: a held lock makes the second run wait for the first instead of driving
# the session underneath it.
#
# Usage: tools/with-session-lock.sh <command> [args...]
#
# Re-entrant within one process tree: the marker below says this tree already holds the lock, so a
# tool started by a holder (test-e2e.sh starting dev.sh, dev.sh starting dev-shell.sh) runs
# straight through instead of deadlocking against its own parent.
#
# WN_SESSION_LOCK_TIMEOUT is the wait in whole seconds. 0 fails immediately instead of queueing.
set -euo pipefail

LOCK="${XDG_RUNTIME_DIR:-/tmp}/window-nativizer-session.lock"

if [ "$#" -eq 0 ]; then
    echo "usage: $0 <command> [args...]" >&2
    exit 2
fi

# Same process tree already holds it: run the command directly.
if [ -n "${WN_SESSION_LOCK_HELD:-}" ]; then
    exec "$@"
fi

# A generous finite default, so a wedged holder makes the waiter fail after a bounded wait rather
# than hang forever; 0 means do not wait at all.
TIMEOUT="${WN_SESSION_LOCK_TIMEOUT:-1800}"
case "$TIMEOUT" in
    ''|*[!0-9]*)
        echo "[session-lock] WN_SESSION_LOCK_TIMEOUT must be a whole number of seconds, got '$TIMEOUT'" >&2
        exit 2
        ;;
esac

mkdir -p "$(dirname "$LOCK")"
# `exec 9<>` opens the lock file without truncating it, and survives the exec below, so the lock
# is held for the command's whole life and released whatever its exit status.
exec 9<>"$LOCK"
if ! flock -n 9; then
    holder="$(cat "$LOCK" 2>/dev/null || true)"
    echo "[session-lock] waiting for the nested session (held by PID ${holder:-unknown})"
    if [ "$TIMEOUT" -eq 0 ]; then
        echo "[session-lock] WN_SESSION_LOCK_TIMEOUT=0: not waiting (held by PID ${holder:-unknown})" >&2
        exit 1
    fi
    if ! flock -w "$TIMEOUT" 9; then
        echo "[session-lock] timed out after ${TIMEOUT}s waiting for the nested session (held by PID ${holder:-unknown})" >&2
        exit 1
    fi
fi

# Name the holder for the next waiter. We hold the lock now, so rewriting the file is safe.
printf '%s\n' "$$" > "$LOCK"
export WN_SESSION_LOCK_HELD=1
exec "$@"
