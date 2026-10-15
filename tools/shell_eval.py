"""Shared nested-session bus access for the decoration harness.

One home for the three idioms check-decoration.py and benchmark-perf.py each
carried on their own: resolving the nested session's bus address off the live
shell, calling org.gnome.Shell.Eval, polling a predicate instead of sleeping a
fixed delay, and reading a count out of an Eval reply. Thresholds, budgets and
session policies (when to boot, when to reuse) stay with the callers; this
module only moves values.
"""

import os
import re
import subprocess
import time


def bus_from_pid(pid):
    """The DBUS_SESSION_BUS_ADDRESS of a running nested shell."""
    raw_env = open(f"/proc/{pid}/environ", "rb").read().split(b"\0")
    return [x.decode() for x in raw_env
            if x.startswith(b"DBUS_SESSION_BUS_ADDRESS=")][0].split("=", 1)[1]


def eval_js(code, bus, xdg_config=None, timeout=30.0):
    """Eval JS in the nested shell. xdg_config selects the session's own dconf
    store when the caller drives settings through the same bus."""
    env = dict(os.environ, DBUS_SESSION_BUS_ADDRESS=bus)
    if xdg_config is not None:
        env["XDG_CONFIG_HOME"] = xdg_config
    cmd = ["gdbus", "call", "--session", "--dest", "org.gnome.Shell",
           "--object-path", "/org/gnome/Shell", "--method", "org.gnome.Shell.Eval", code]
    return subprocess.check_output(cmd, env=env, timeout=timeout).decode()


def wait_for(predicate, timeout=5.0, interval=0.25):
    """Poll until `predicate` is truthy, so a slow reconcile or map is waited out, not counted as
    a result. Returns the value, or None on timeout."""
    deadline = time.time() + timeout
    while True:
        value = predicate()
        if value:
            return value
        if time.time() > deadline:
            return None
        time.sleep(interval)


def number_from(reply):
    """The shell prints whatever Eval returns as a string, so a number comes back as '(true, '3')'
    while a string keeps its own quotes. Read digits inside either quote style, or none at all."""
    match = re.search(r"""['"]?(\d+)['"]?""", reply.split(",", 1)[-1])
    return int(match.group(1)) if match else 0
