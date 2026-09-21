#!/usr/bin/env python3
"""
benchmark-perf.py - Measures GNOME Shell CPU and memory footprint with
Window Nativizer enabled vs disabled for a single undecorated window, then measures the resize
band on its own by reversing the resize axis for that same window's kind against the heuristic.

Usage:
  python3 tools/benchmark-perf.py            # Run full performance benchmark (3 rounds)
  python3 tools/benchmark-perf.py --quick    # Fast 1-round benchmark
  python3 tools/benchmark-perf.py --check    # Verify metrics satisfy performance budget (exit 1 if violated)
  python3 tools/benchmark-perf.py --json out.json # Save JSON metrics to file

The nested session gets its own XDG_CONFIG_HOME, so the band setting can be flipped freely
without writing the developer's dconf; a shell started without it is restarted (nested only).
"""

import sys
import os
import re
import time
import argparse
import select
import subprocess
import json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_DIR = "/tmp/window-nativizer-dev"
PID_FILE = os.path.join(STATE_DIR, "shell.pid")
CLIENT_SCRIPT = os.path.join(ROOT, "tools", "perf-client.py")
DEV_SH = os.path.join(ROOT, "tools", "dev.sh")
UUID = "window-nativizer@everyx.github.io"
WINDOW_NATIVIZER_DISPLAY = "wayland-window-nativizer"
# The harness' own dconf store. The band is flipped through a `window-rules` axis reversal
# for the perf client's kind, never through the developer's dconf, and dev.sh inherits
# it for the nested session it starts.
BENCH_CONFIG = os.path.join(STATE_DIR, "config")
SCHEMA_DIR = os.path.join(os.path.expanduser("~"), ".local", "share", "gnome-shell",
                          "extensions", UUID, "schemas")
CLK_TCK = os.sysconf(os.sysconf_names['SC_CLK_TCK'])

# Performance Budgets (Regression Guards for --check)
BUDGET_MAX_IDLE_CPU_DELTA_PCT = 2.0       # Max idle CPU tax: 2%
# Max dynamic resize CPU delta: 120ms across 150 frames (<0.8ms/frame).
# Physical baseline breakdown:
# - ~80ms for RoundedClipEffect FBO offscreen shader + ShadowActor 8-slice quads
# - ~10ms for ResizeBand: its four bind constraints, four reactive hit-test actors and the live
#   allocation. Measured on the same windows with the resize axis reversed vs the heuristic (private
#   XDG_CONFIG_HOME, schedstat nanoseconds): 9.7ms over one window's 150 resize steps, 34us per
#   step per window over ten. It costs no idle CPU and holds 6.4KB resident per window.
#   The earlier ~25ms here was an estimate, not a measurement.
# - ~15ms allowance for compositor scheduling jitter across 150 frames
BUDGET_MAX_STRESS_CPU_DELTA_MS = 120.0
BUDGET_MAX_PER_WINDOW_PSS_KB = 2048.0     # Max per-window RAM delta: 2.0 MB
# The band's own share, from the phase that flips only that setting.
BUDGET_MAX_BAND_STRESS_CPU_MS = 30.0      # the band's own share is 5-14ms over 150 resize steps,
                                          # which is inside a single window's round-to-round noise
                                          # (~25ms), so this guards order-of-magnitude growth rather
                                          # than a few milliseconds. Amplified over ten windows it
                                          # measures 34us per step per window. Scaled for --quick,
                                          # which runs fewer steps.
BUDGET_MAX_BAND_IDLE_CPU_PCT = 2.0        # measured 0.0%: nothing moves, nothing reallocates
BUDGET_MAX_BAND_PER_WINDOW_PSS_KB = 256.0  # measured 6.4KB on an idle window (A-B-A); the
                                          # harness reads once per state, so leave it room


def shell_config_home(pid):
    """The XDG_CONFIG_HOME a running shell was started with, so a foreign session is recognisable."""
    for item in open(f"/proc/{pid}/environ", "rb").read().split(b"\0"):
        if item.startswith(b"XDG_CONFIG_HOME="):
            return item.decode().split("=", 1)[1]
    return os.path.expanduser("~/.config")


def ensure_session():
    """A nested shell running on the harness' own config, so nothing here can write your dconf."""
    if os.path.exists(PID_FILE):
        if shell_config_home(int(open(PID_FILE).read().strip())) != BENCH_CONFIG:
            print(">> The running nested shell was started with your own config, so flipping the "
                  "band axis would land in your dconf. Restarting the nested session only...")
            subprocess.check_call([DEV_SH, "stop"],
                                  env=dict(os.environ, XDG_CONFIG_HOME=BENCH_CONFIG))
    if not os.path.exists(PID_FILE):
        print(">> Starting nested shell via dev.sh, with its own config...")
        subprocess.check_call([DEV_SH, "shell"],
                              env=dict(os.environ, XDG_CONFIG_HOME=BENCH_CONFIG))
        time.sleep(2.0)
    pid = int(open(PID_FILE).read().strip())
    raw_env = open(f"/proc/{pid}/environ", "rb").read().split(b"\0")
    bus = [x.decode() for x in raw_env if x.startswith(b"DBUS_SESSION_BUS_ADDRESS=")][0].split("=", 1)[1]
    return pid, bus


def eval_js(code, bus, timeout=30.0):
    cmd = ["gdbus", "call", "--session", "--dest", "org.gnome.Shell",
           "--object-path", "/org/gnome/Shell", "--method", "org.gnome.Shell.Eval", code]
    return subprocess.check_output(
        cmd, env=dict(os.environ, DBUS_SESSION_BUS_ADDRESS=bus, XDG_CONFIG_HOME=BENCH_CONFIG),
        timeout=timeout).decode()


def describe_stage(bus):
    """What each window on stage got, for a failure that would otherwise just read as a count."""
    return eval_js(
        "(() => { global.window_group.show();"
        " const kids = global.window_group.get_children();"
        " const rows = global.get_window_actors().map(a => { const w = a.meta_window;"
        "   const band = kids.find(c => c.name === 'WindowNativizerResizeBand' && c._windowActor === a);"
        "   return (w ? w.get_wm_class() : '?') + '#' + (w ? w.get_pid() : '?') +"
        "     (band ? '+band' : '-band') + '/shadowkids=' + a.get_children().length; });"
        " return 'stage: ' + (rows.join(' ') || 'empty') + ' | shadows=' +"
        "   kids.filter(c => c.name && c.name.indexOf('Shadow') >= 0).length; })()", bus)


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


def window_actors(bus):
    """Window actors on stage. Headless sessions only map windows while the group is shown, so
    every read shows it first - otherwise a live window reads as none."""
    eval_js("global.window_group.show();", bus)
    return number_from(eval_js("global.get_window_actors().length", bus))


def band_actors(bus):
    return number_from(eval_js(
        "(() => { global.window_group.show();"
        " return global.window_group.get_children()"
        ".filter(c => c.name === 'WindowNativizerResizeBand').length; })()", bus))


# The perf client's window kind: undecorated GTK4 on Wayland, no shadow ring.
PERF_RULE_KEY = ("dev.windownativizer.perf:client_type=wayland,window_type=0,"
                 "has_parent=false,allows_resize=true,attached_dialog=false,has_ring=false,has_ssd=false")


def set_band(enabled, bus, verify=True):
    """Reverse the resize axis for the perf client's kind through the nested session's own bus and
    dconf store: the axis reversed when the band is wanted, and no rule (the reading) when it is
    not. The perf client reserves no ring, so the reading leaves it alone. With
    `verify`, wait for the band actors to follow - a rule that never arrived would
    otherwise look like a saving. Without it (no window on stage to carry a band yet)
    only the write is done, and the caller checks the band on the window it measures."""
    rules = "{'%s': 'resize'}" % PERF_RULE_KEY if enabled else "{}"
    subprocess.check_call(
        ["gsettings", "set", "org.gnome.shell.extensions.window-nativizer", "window-rules",
         rules],
        env=dict(os.environ, DBUS_SESSION_BUS_ADDRESS=bus, XDG_CONFIG_HOME=BENCH_CONFIG,
                 GSETTINGS_SCHEMA_DIR=SCHEMA_DIR))
    if not verify:
        # The shell picks the change up over GSettings, which is asynchronous: without this, a
        # window created immediately after is decided from the previous value and keeps it.
        time.sleep(0.5)
        return
    wait_for(lambda: (band_actors(bus) > 0) == enabled)
    bands = band_actors(bus)
    if (bands > 0) != enabled:
        raise RuntimeError(f"band reversal enabled={enabled} did not take effect after 5s: {bands} band(s), "
                           f"{window_actors(bus)} window actor(s)\n   {describe_stage(bus)}")

def trigger_gc(bus):
    try:
        eval_js("imports.system.gc();", bus)
    except Exception:
        pass
    time.sleep(0.3)

def set_extension_state(enabled, bus):
    subcmd = "enable" if enabled else "disable"
    subprocess.check_call(["gnome-extensions", subcmd, "window-nativizer@everyx.github.io"],
                          env=dict(os.environ, DBUS_SESSION_BUS_ADDRESS=bus),
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    is_active = not enabled
    for _ in range(15):
        time.sleep(0.3)
        out = subprocess.check_output(["gnome-extensions", "list", "--enabled"],
                                      env=dict(os.environ, DBUS_SESSION_BUS_ADDRESS=bus)).decode()
        is_active = "window-nativizer@everyx.github.io" in out
        if is_active == enabled:
            return
    raise RuntimeError(f"Failed to set extension state: expected enabled={enabled}, but got active={is_active}")

def read_cpu_ticks(pid):
    with open(f"/proc/{pid}/stat") as f:
        fields = f.read().split()
        utime = int(fields[13])
        stime = int(fields[14])
        return utime + stime


HAS_SCHEDSTAT = os.path.exists("/proc/self/schedstat")


def read_cpu_ns(pid):
    """Nanoseconds spent on CPU. Jiffies are 10ms here and cannot resolve a few milliseconds of
    work, so every CPU figure below is read from schedstat when the kernel offers it."""
    if HAS_SCHEDSTAT:
        return int(open(f"/proc/{pid}/schedstat").read().split()[0])
    return read_cpu_ticks(pid) * (1e9 / CLK_TCK)

def read_memory_kb(pid):
    rss = 0
    pss = 0
    private_dirty = 0
    if os.path.exists(f"/proc/{pid}/smaps_rollup"):
        with open(f"/proc/{pid}/smaps_rollup") as f:
            for line in f:
                parts = line.split()
                if parts[0] == "Rss:":
                    rss = int(parts[1])
                elif parts[0] == "Pss:":
                    pss = int(parts[1])
                elif parts[0] == "Private_Dirty:":
                    private_dirty = int(parts[1])
    else:
        with open(f"/proc/{pid}/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    rss = int(line.split()[1])
    return {
        "rss": rss,
        "pss": pss,
        "private_dirty": private_dirty,
    }

def stop_process(proc):
    if proc and proc.poll() is None:
        try:
            proc.terminate()
            proc.wait(timeout=2.0)
        except Exception:
            proc.kill()
            proc.wait()

def start_client(env, stress=False, steps=150):
    """Launch the perf client and wait until it reports its window is up."""
    args = ["python3", CLIENT_SCRIPT] + (["--stress", "--steps", str(steps)] if stress else [])
    proc = subprocess.Popen(args, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    for line in proc.stdout:
        if line.startswith("READY_PID="):
            return proc
    stop_process(proc)
    raise RuntimeError(f"perf client never reported READY_PID: {proc.stderr.read()[:400]}")


def measure_stress_cpu(shell_pid, env, steps, bus, expect_band=None, stress_deadline=120.0):
    """Shell CPU milliseconds and wall seconds for `steps` dynamic resizes of one window, on a
    window that is checked to carry (or not carry) the band before the clock starts."""
    proc = start_client(env, stress=True, steps=steps)
    try:
        if not wait_for(lambda: window_actors(bus) > 0, timeout=8.0):
            raise RuntimeError("the stress client's window never mapped")
        if expect_band is not None:
            # The band is built by the first reconcile, a moment after the window maps: poll for it
            # rather than reading once, or a window that is simply still being decided reads as one
            # that never got a band at all.
            wait_for(lambda: (window_actors(bus) > 0) and ((band_actors(bus) > 0) == expect_band))
            bands = band_actors(bus)
            if (bands > 0) != expect_band:
                raise RuntimeError(f"stress window has {bands} band(s), expected "
                                   f"band={expect_band}\n   {describe_stage(bus)}")
        time.sleep(0.1)
        ticks0, wall0 = read_cpu_ns(shell_pid), time.perf_counter()
        while True:
            ready, _, _ = select.select([proc.stdout], [], [], 1.0)
            if ready:
                line = proc.stdout.readline()
                if not line or "STRESS_DONE" in line:
                    break
            if time.perf_counter() - wall0 > stress_deadline:
                raise RuntimeError("stress client never reported STRESS_DONE")
        return (read_cpu_ns(shell_pid) - ticks0) / 1e6, time.perf_counter() - wall0
    finally:
        stop_process(proc)
        subprocess.call(["pkill", "-9", "-f", "perf-client.py"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def run_single_test(enabled, round_idx, shell_pid, bus, idle_secs=4.0, stress_steps=150):
    env = dict(os.environ, WAYLAND_DISPLAY=WINDOW_NATIVIZER_DISPLAY)

    # Clean previous processes
    subprocess.call(["pkill", "-9", "-f", "perf-client.py"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.3)

    set_extension_state(enabled, bus)
    trigger_gc(bus)

    # 1. Base memory (no test window)
    mem_base = read_memory_kb(shell_pid)

    # 2. Idle Phase (1 window static)
    proc = start_client(env)
    time.sleep(1.0)
    trigger_gc(bus)

    mem_idle = read_memory_kb(shell_pid)

    cpu_t0 = read_cpu_ns(shell_pid)
    wall_t0 = time.perf_counter()
    time.sleep(idle_secs)
    cpu_t1 = read_cpu_ns(shell_pid)
    wall_t1 = time.perf_counter()

    idle_cpu_secs = (cpu_t1 - cpu_t0) / 1e9
    idle_wall_secs = wall_t1 - wall_t0
    idle_cpu_pct = (idle_cpu_secs / idle_wall_secs) * 100.0

    stop_process(proc)
    subprocess.call(["pkill", "-9", "-f", "perf-client.py"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.4)

    # 3. Stress Phase (continuous dynamic resize at 60 FPS)
    stress_cpu_ms, stress_wall_secs = measure_stress_cpu(shell_pid, env, stress_steps, bus)
    stress_cpu_secs = stress_cpu_ms / 1000.0
    stress_cpu_pct = (stress_cpu_secs / stress_wall_secs) * 100.0

    return {
        "enabled": enabled,
        "round": round_idx,
        "mem_base_rss": mem_base["rss"],
        "mem_base_pss": mem_base["pss"],
        "mem_base_dirty": mem_base["private_dirty"],
        "mem_idle_rss": mem_idle["rss"],
        "mem_idle_pss": mem_idle["pss"],
        "mem_idle_dirty": mem_idle["private_dirty"],
        "window_delta_rss": mem_idle["rss"] - mem_base["rss"],
        "window_delta_pss": mem_idle["pss"] - mem_base["pss"],
        "window_delta_dirty": mem_idle["private_dirty"] - mem_base["private_dirty"],
        "idle_cpu_secs": idle_cpu_secs,
        "idle_cpu_pct": idle_cpu_pct,
        "stress_cpu_ms": stress_cpu_ms,
        "stress_cpu_pct": stress_cpu_pct,
        "stress_wall_secs": stress_wall_secs,
    }


def with_banded_window(env, bus, enabled, work, attempts=3):
    """Run `work()` with one window whose band state is `enabled`. A headless session loses a
    window under a block every so often (the actor is gone while the client lives); retrying the
    whole block keeps that from being read as a band that costs nothing."""
    last = None
    for attempt in range(1, attempts + 1):
        proc = start_client(env)
        try:
            if not wait_for(lambda: window_actors(bus) > 0, timeout=8.0):
                last = "the window never mapped"
            else:
                set_band(enabled, bus)
                if window_actors(bus) == 0:
                    last = "the window vanished while the setting flipped"
                else:
                    return work()
        except RuntimeError as exc:
            last = str(exc)
        finally:
            with_client_cleanup(proc)
        print(f"   (attempt {attempt}: {last}; retrying)")
    raise RuntimeError(f"no window survived a block with band={enabled}: {last}\n"
                       f"   {describe_stage(bus)}")


def run_band_phase(shell_pid, bus, rounds, stress_steps):
    """The band's own cost with everything else held still: only the resize axis moves.
    Memory is read on an idle window in A-B-A order so drift cancels; the idle hold and the resize
    runs each get their own window, so one block's client cannot end another's measurement."""
    env = dict(os.environ, WAYLAND_DISPLAY=WINDOW_NATIVIZER_DISPLAY)
    subprocess.call(["pkill", "-9", "-f", "perf-client.py"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.5)
    set_extension_state(True, bus)

    memory = {label: with_banded_window(env, bus, enabled,
                                        lambda: read_memory_kb(shell_pid))
              for label, enabled in (("off", False), ("on", True), ("off_again", False))}

    idle = {}
    for label, enabled in (("off", False), ("on", True)):
        def hold():
            ticks0, wall0 = read_cpu_ns(shell_pid), time.perf_counter()
            time.sleep(2.0)
            if window_actors(bus) == 0:
                raise RuntimeError("the window vanished during the idle hold")
            return (read_cpu_ns(shell_pid) - ticks0) / 1e9 / (time.perf_counter() - wall0) * 100.0
        idle[label] = with_banded_window(env, bus, enabled, hold)

    # The stress runs: the window is checked to carry the band the setting asks for before its
    # clock starts, and a run whose window came up undecided is retried rather than counted (that
    # happens in a session with heavy client churn, and a run of it would read as a free band).
    stress = {"on": [], "off": []}
    skipped = 0
    for round_idx in range(1, rounds + 1):
        for enabled in ([False, True] if round_idx % 2 == 1 else [True, False]):
            set_band(enabled, bus, verify=False)
            for attempt in range(1, 4):
                try:
                    cpu_ms, _ = measure_stress_cpu(shell_pid, env, stress_steps, bus,
                                                   expect_band=enabled)
                except RuntimeError as exc:
                    print(f"   (stress run with band={enabled}, attempt {attempt}: {exc.splitlines()[0]})")
                    set_band(enabled, bus, verify=False)
                    continue
                stress["on" if enabled else "off"].append(cpu_ms)
                break
            else:
                skipped += 1
    if skipped:
        print(f"   ({skipped} stress run(s) skipped: the band never appeared on their window)")
    if not stress["on"] or not stress["off"]:
        # A guard that silently passes when the thing it guards never arrived is not a guard.
        raise RuntimeError(f"the band never appeared on a stress window: on={len(stress['on'])} "
                           f"off={len(stress['off'])} skipped={skipped}\n   {describe_stage(bus)}")

    off_pss = (memory["off"]["pss"] + memory["off_again"]["pss"]) / 2
    off_dirty = (memory["off"]["private_dirty"] + memory["off_again"]["private_dirty"]) / 2
    set_band(True, bus, verify=False)  # leave the bench session as it was found
    return {
        "idle_off_pct": idle["off"],
        "idle_on_pct": idle["on"],
        "idle_delta_pct": idle["on"] - idle["off"],
        "stress_off_ms": sum(stress["off"]) / len(stress["off"]),
        "stress_on_ms": sum(stress["on"]) / len(stress["on"]),
        "stress_delta_ms": (sum(stress["on"]) / len(stress["on"])
                            - sum(stress["off"]) / len(stress["off"])),
        "stress_skipped": skipped,
        "pss_off_kb": off_pss,
        "pss_on_kb": memory["on"]["pss"],
        "pss_delta_kb": memory["on"]["pss"] - off_pss,
        "dirty_delta_kb": memory["on"]["private_dirty"] - off_dirty,
    }


def with_client_cleanup(proc):
    """Stop a client and complain (with its stderr) if it had already died on its own."""
    if proc.poll() is not None and proc.returncode not in (0, -15, -9):
        print(f"!! perf client exited early ({proc.returncode}): {proc.stderr.read()[:400]}")
    stop_process(proc)
    subprocess.call(["pkill", "-9", "-f", "perf-client.py"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    parser = argparse.ArgumentParser(description="Window Nativizer CPU and Memory Performance Benchmark")
    parser.add_argument("--rounds", type=int, default=3, help="Number of benchmark rounds (default: 3)")
    parser.add_argument("--quick", action="store_true", help="Run quick 1-round benchmark")
    parser.add_argument("--check", action="store_true", help="Enforce performance regression budgets (exit 1 if violated)")
    parser.add_argument("--json", type=str, default=None, help="Save detailed benchmark results to JSON file")
    args = parser.parse_args()

    rounds = 1 if args.quick else args.rounds
    idle_secs = 2.0 if args.quick else 4.0
    stress_steps = 100 if args.quick else 150

    shell_pid, bus = ensure_session()

    print("=" * 76)
    print("       WINDOW NATIVIZER CPU & MEMORY PERFORMANCE BENCHMARK")
    print("=" * 76)
    print(f"Shell PID: {shell_pid} | Clock Ticks: {CLK_TCK}/s | Rounds: {rounds}")
    print(f"1. Idle Phase: {idle_secs:.1f}s static hold")
    print(f"2. Stress Phase: {stress_steps} dynamic resizes at 60 FPS\n")

    results_disabled = []
    results_enabled = []

    try:
        if not args.quick:
            print(">> Warming up session to eliminate JIT and cold-start bias...")
            run_single_test(False, 0, shell_pid, bus, idle_secs=1.0, stress_steps=30)
            run_single_test(True, 0, shell_pid, bus, idle_secs=1.0, stress_steps=30)
            print(">> Warm-up complete.\n")

        print(">> Running counterbalanced interleaved performance benchmark (AB-BA per round)...")
        for r in range(1, rounds + 1):
            print(f"\n>> Round {r}/{rounds}...")
            # Odd rounds: Disabled first, then Enabled (A -> B)
            # Even rounds: Enabled first, then Disabled (B -> A)
            # This counterbalancing mathematically cancels out intra-round order bias in the mean.
            states = [False, True] if (r % 2 == 1) else [True, False]
            for state in states:
                tag = "Enabled" if state else "Disabled"
                sys.stdout.write(f"   [{tag:<8}] ")
                sys.stdout.flush()
                res = run_single_test(state, r, shell_pid, bus, idle_secs=idle_secs, stress_steps=stress_steps)
                if state:
                    results_enabled.append(res)
                else:
                    results_disabled.append(res)
                print(f"Idle: {res['idle_cpu_pct']:.2f}%, Stress: {res['stress_cpu_ms']:.1f}ms ({res['stress_cpu_pct']:.1f}%), Delta PSS: {res['window_delta_pss']:+d}KB")

        def avg(lst, key):
            return sum(x[key] for x in lst) / len(lst)

        dis_idle_cpu = avg(results_disabled, "idle_cpu_pct")
        ena_idle_cpu = avg(results_enabled, "idle_cpu_pct")
        delta_idle_cpu = ena_idle_cpu - dis_idle_cpu

        dis_stress_cpu_ms = avg(results_disabled, "stress_cpu_ms")
        ena_stress_cpu_ms = avg(results_enabled, "stress_cpu_ms")
        delta_stress_cpu_ms = ena_stress_cpu_ms - dis_stress_cpu_ms

        dis_stress_cpu_pct = avg(results_disabled, "stress_cpu_pct")
        ena_stress_cpu_pct = avg(results_enabled, "stress_cpu_pct")
        delta_stress_cpu_pct = ena_stress_cpu_pct - dis_stress_cpu_pct

        dis_win_rss = avg(results_disabled, "window_delta_rss")
        ena_win_rss = avg(results_enabled, "window_delta_rss")
        delta_win_rss = ena_win_rss - dis_win_rss

        dis_win_pss = avg(results_disabled, "window_delta_pss")
        ena_win_pss = avg(results_enabled, "window_delta_pss")
        delta_win_pss = ena_win_pss - dis_win_pss

        dis_win_dirty = avg(results_disabled, "window_delta_dirty")
        ena_win_dirty = avg(results_enabled, "window_delta_dirty")
        delta_win_dirty = ena_win_dirty - dis_win_dirty

        print("\n" + "=" * 76)
        print("                    PERFORMANCE BENCHMARK RESULTS")
        print("=" * 76)
        header = f"{'Metric':<36} | {'Disabled':<14} | {'Enabled':<14} | {'Delta':<12}"
        print(header)
        print("-" * 76)
        print(f"{'Idle CPU Usage':<36} | {dis_idle_cpu:>13.2f}% | {ena_idle_cpu:>13.2f}% | {delta_idle_cpu:>+11.2f}%")
        print(f"{'Stress Active CPU Time':<36} | {dis_stress_cpu_ms:>11.1f} ms | {ena_stress_cpu_ms:>11.1f} ms | {delta_stress_cpu_ms:>+9.1f} ms")
        print(f"{'Stress Active CPU Load':<36} | {dis_stress_cpu_pct:>13.1f}% | {ena_stress_cpu_pct:>13.1f}% | {delta_stress_cpu_pct:>+11.1f}%")
        print("-" * 76)
        print(f"{'Per-Window RAM (RSS Delta)':<36} | {dis_win_rss:>11.1f} KB | {ena_win_rss:>11.1f} KB | {delta_win_rss:>+9.1f} KB")
        print(f"{'Per-Window RAM (PSS Delta)':<36} | {dis_win_pss:>11.1f} KB | {ena_win_pss:>11.1f} KB | {delta_win_pss:>+9.1f} KB")
        print(f"{'Per-Window RAM (Private Dirty)':<36} | {dis_win_dirty:>11.1f} KB | {ena_win_dirty:>11.1f} KB | {delta_win_dirty:>+9.1f} KB")
        print("=" * 76)

        print("\n>> Band phase: the same one window, only the resize axis reversed...")
        band = run_band_phase(shell_pid, bus, rounds, stress_steps)
        print(f"   idle CPU    off {band['idle_off_pct']:>6.2f}%   on {band['idle_on_pct']:>6.2f}%   "
              f"delta {band['idle_delta_pct']:>+6.2f}%")
        print(f"   resize CPU  off {band['stress_off_ms']:>6.1f}ms  on {band['stress_on_ms']:>6.1f}ms  "
              f"delta {band['stress_delta_ms']:>+6.1f}ms per window per {stress_steps} steps")
        print(f"   resident    off {band['pss_off_kb']:>6.0f}KB  on {band['pss_on_kb']:>6.0f}KB  "
              f"delta {band['pss_delta_kb']:>+6.0f}KB per window")

        # Re-enable extension at the end of run so developer session remains active
        set_extension_state(True, bus)

        summary_data = {
            "disabled": results_disabled,
            "enabled": results_enabled,
            "averages": {
                "disabled": {
                    "idle_cpu_pct": dis_idle_cpu,
                    "stress_cpu_ms": dis_stress_cpu_ms,
                    "stress_cpu_pct": dis_stress_cpu_pct,
                    "win_rss_kb": dis_win_rss,
                    "win_pss_kb": dis_win_pss,
                    "win_dirty_kb": dis_win_dirty,
                },
                "enabled": {
                    "idle_cpu_pct": ena_idle_cpu,
                    "stress_cpu_ms": ena_stress_cpu_ms,
                    "stress_cpu_pct": ena_stress_cpu_pct,
                    "win_rss_kb": ena_win_rss,
                    "win_pss_kb": ena_win_pss,
                    "win_dirty_kb": ena_win_dirty,
                },
                "delta": {
                    "idle_cpu_pct": delta_idle_cpu,
                    "stress_cpu_ms": delta_stress_cpu_ms,
                    "stress_cpu_pct": delta_stress_cpu_pct,
                    "win_rss_kb": delta_win_rss,
                    "win_pss_kb": delta_win_pss,
                    "win_dirty_kb": delta_win_dirty,
                }
            },
            "band": band,
        }

        if args.json:
            with open(args.json, "w") as f:
                json.dump(summary_data, f, indent=2)
            print(f"Results saved to {args.json}")

        if args.check:
            print("\n>> Checking Performance Budgets...")
            failed = False
            if delta_idle_cpu > BUDGET_MAX_IDLE_CPU_DELTA_PCT:
                print(f"!! [FAIL] Idle CPU delta ({delta_idle_cpu:+.2f}%) exceeds budget (+{BUDGET_MAX_IDLE_CPU_DELTA_PCT:.1f}%)")
                failed = True
            else:
                print(f"OK [PASS] Idle CPU delta ({delta_idle_cpu:+.2f}%) within budget (+{BUDGET_MAX_IDLE_CPU_DELTA_PCT:.1f}%)")

            if delta_stress_cpu_ms > BUDGET_MAX_STRESS_CPU_DELTA_MS:
                print(f"!! [FAIL] Stress CPU delta ({delta_stress_cpu_ms:+.1f}ms) exceeds budget (+{BUDGET_MAX_STRESS_CPU_DELTA_MS:.1f}ms)")
                failed = True
            else:
                print(f"OK [PASS] Stress CPU delta ({delta_stress_cpu_ms:+.1f}ms) within budget (+{BUDGET_MAX_STRESS_CPU_DELTA_MS:.1f}ms)")

            if delta_win_pss > BUDGET_MAX_PER_WINDOW_PSS_KB:
                print(f"!! [FAIL] Per-window PSS RAM delta ({delta_win_pss:+.1f}KB) exceeds budget (+{BUDGET_MAX_PER_WINDOW_PSS_KB:.1f}KB)")
                failed = True
            else:
                print(f"OK [PASS] Per-window PSS RAM delta ({delta_win_pss:+.1f}KB) within budget (+{BUDGET_MAX_PER_WINDOW_PSS_KB:.1f}KB)")

            band_budget_ms = BUDGET_MAX_BAND_STRESS_CPU_MS * stress_steps / 150.0
            if band["stress_delta_ms"] > band_budget_ms:
                print(f"!! [FAIL] Band resize CPU delta ({band['stress_delta_ms']:+.1f}ms) exceeds budget (+{band_budget_ms:.1f}ms)")
                failed = True
            else:
                print(f"OK [PASS] Band resize CPU delta ({band['stress_delta_ms']:+.1f}ms) within budget (+{band_budget_ms:.1f}ms)")

            if abs(band["idle_delta_pct"]) > BUDGET_MAX_BAND_IDLE_CPU_PCT:
                print(f"!! [FAIL] Band idle CPU delta ({band['idle_delta_pct']:+.2f}%) exceeds budget (±{BUDGET_MAX_BAND_IDLE_CPU_PCT:.1f}%)")
                failed = True
            else:
                print(f"OK [PASS] Band idle CPU delta ({band['idle_delta_pct']:+.2f}%) within budget (±{BUDGET_MAX_BAND_IDLE_CPU_PCT:.1f}%)")

            if band["pss_delta_kb"] > BUDGET_MAX_BAND_PER_WINDOW_PSS_KB:
                print(f"!! [FAIL] Band PSS per window ({band['pss_delta_kb']:+.1f}KB) exceeds budget (+{BUDGET_MAX_BAND_PER_WINDOW_PSS_KB:.1f}KB)")
                failed = True
            else:
                print(f"OK [PASS] Band PSS per window ({band['pss_delta_kb']:+.1f}KB) within budget (+{BUDGET_MAX_BAND_PER_WINDOW_PSS_KB:.1f}KB)")

            if failed:
                print("\n>> Performance budget check FAILED.")
                sys.exit(1)
            else:
                print("\n>> All performance budgets PASSED.")
    finally:
        subprocess.call(["pkill", "-9", "-f", "perf-client.py"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

if __name__ == "__main__":
    main()
