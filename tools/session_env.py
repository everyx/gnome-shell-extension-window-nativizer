"""Shared nested-session liveness, ownership and bus access for the Python harness tools.

`tools/dev.sh shell` starts the nested shell in the background and records it as a pid file plus
a `ready` marker; `tools/dev.sh stop` is the only teardown that removes them. A session that dies
on its own - a crash, the OOM killer, a reboot - leaves both files behind, so the pid file is a
claim about a process rather than a process. Every read here goes through that check, and the
files a dead session left are cleared so the next start is not told it is already running.

A session found running is borrowed and stays up for whoever started it; only one this process
started is stopped when the run ends, so a check cannot leave a headless shell behind.
"""

import contextlib
import os
import subprocess

STATE_DIR = os.environ.get("WN_STATE_DIR", "/tmp/window-nativizer-dev")
PID_FILE = os.path.join(STATE_DIR, "shell.pid")
READY_FILE = os.path.join(STATE_DIR, "ready")
DEV_SH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                      "tools", "dev.sh")
# WN_SESSION_OWNED marks the tree that started the session, for anything it starts in turn.
# Stopping is per process, so an inherited marker never authorises a teardown; WN_SESSION_KEEP
# leaves the session up to be looked at after a run.
OWNED_ENV = "WN_SESSION_OWNED"
KEEP_ENV = "WN_SESSION_KEEP"

_ours = False


def live_pid():
    """The nested shell's pid, or None when the session it names is gone.

    `tools/dev.sh id` owns the identity check, and this asks it rather than repeating it: a pid file
    outlives a session that died, and the pid it names can then be reused by anything - the desktop's
    own shell included - so liveness alone would hand back a stranger's bus.
    """
    pid = None
    try:
        out = subprocess.run([DEV_SH, "id"], capture_output=True, text=True, timeout=60)
        pid = int(out.stdout.strip())
    except (OSError, ValueError, subprocess.SubprocessError):
        pid = None
    if pid is not None:
        return pid
    # Left in place, the pair reads as a running session to anything that only asks whether the file
    # exists, so the answer "there is none" also clears them.
    for path in (PID_FILE, READY_FILE):
        try:
            os.remove(path)
        except OSError:
            pass
    return None


def ensure_session(dev_sh_args=(), dev_sh_env=None):
    """The live nested shell's pid, starting one through `dev.sh shell` when there is none.

    A session found running is borrowed: it belongs to whoever started it and is left up. One
    started here is this process's own, and `session()` is what takes it down again.
    """
    global _ours
    pid = live_pid()
    if pid is not None:
        return pid
    print(">> Starting nested shell via dev.sh...")
    subprocess.check_call([DEV_SH, "shell", *dev_sh_args], env=dev_sh_env)
    pid = live_pid()
    if pid is None:
        raise RuntimeError(f"dev.sh shell returned, but {PID_FILE} does not name a live process")
    _ours = True
    os.environ[OWNED_ENV] = "1"
    return pid


def stop_session():
    """Stop the session this run started. A borrowed one, or one asked to be kept, stays up."""
    global _ours
    if not _ours or os.environ.get(KEEP_ENV):
        return
    _ours = False
    os.environ.pop(OWNED_ENV, None)
    subprocess.call([DEV_SH, "stop"])


@contextlib.contextmanager
def session():
    """A run's scope: the nested session it started, if any, is stopped on the way out.

    Nothing is started here - a run that never needs the session (--help, a usage error) must not
    pay for booting one - so this only holds the teardown.
    """
    try:
        yield
    finally:
        stop_session()


def _environ(pid):
    path = f"/proc/{pid}/environ"
    try:
        with open(path, "rb") as f:
            return f.read().split(b"\0")
    except OSError as error:
        # The pid was live when it was read and this is the read that lost the race, so name the
        # pid and the file: a bare FileNotFoundError from here reads as a bug in the caller.
        raise RuntimeError(f"nested shell pid {pid} is gone: cannot read {path} "
                           f"({error})") from None


def session_var(pid, name):
    """One variable out of a running shell's environment, or None when it does not set it."""
    prefix = name.encode() + b"="
    for item in _environ(pid):
        if item.startswith(prefix):
            return item.split(b"=", 1)[1].decode()
    return None


def session_env(pid=None):
    """os.environ plus the nested session's bus address, so a call reaches that shell's bus."""
    pid = pid if pid is not None else live_pid()
    if pid is None:
        raise RuntimeError(f"no live nested shell: {PID_FILE} is missing or stale")
    bus = session_var(pid, "DBUS_SESSION_BUS_ADDRESS")
    if bus is None:
        raise RuntimeError(f"nested shell pid {pid} has no DBUS_SESSION_BUS_ADDRESS")
    return dict(os.environ, DBUS_SESSION_BUS_ADDRESS=bus)
