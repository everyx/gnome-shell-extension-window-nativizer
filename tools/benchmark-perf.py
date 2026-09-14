#!/usr/bin/env python3
"""
benchmark-perf.py - Measures GNOME Shell CPU and memory footprint with
Window Nativizer enabled vs disabled for a single undecorated window.

Usage:
  python3 tools/benchmark-perf.py            # Run full performance benchmark (3 rounds)
  python3 tools/benchmark-perf.py --quick    # Fast 1-round benchmark
  python3 tools/benchmark-perf.py --check    # Verify metrics satisfy performance budget (exit 1 if violated)
  python3 tools/benchmark-perf.py --json out.json # Save JSON metrics to file
"""

import sys
import os
import time
import argparse
import subprocess
import json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_DIR = "/tmp/window-nativizer-dev"
PID_FILE = os.path.join(STATE_DIR, "shell.pid")
CLIENT_SCRIPT = os.path.join(ROOT, "tools", "perf-client.py")
CLK_TCK = os.sysconf(os.sysconf_names['SC_CLK_TCK'])

# Performance Budgets (Regression Guards for --check)
BUDGET_MAX_IDLE_CPU_DELTA_PCT = 2.0       # Max idle CPU tax: 2%
BUDGET_MAX_STRESS_CPU_DELTA_MS = 100.0    # Max dynamic resize CPU delta: 100ms across 150 frames (<0.7ms/frame)
BUDGET_MAX_PER_WINDOW_PSS_KB = 2048.0     # Max per-window RAM delta: 2.0 MB

def ensure_session():
    if not os.path.exists(PID_FILE):
        print(">> Starting nested shell via dev.sh...")
        subprocess.check_call([os.path.join(ROOT, "tools", "dev.sh"), "shell"])
        time.sleep(2.0)
    pid = int(open(PID_FILE).read().strip())
    raw_env = open(f"/proc/{pid}/environ", "rb").read().split(b"\0")
    bus = [x.decode() for x in raw_env if x.startswith(b"DBUS_SESSION_BUS_ADDRESS=")][0].split("=", 1)[1]
    return pid, bus

def eval_js(code, bus):
    cmd = ["gdbus", "call", "--session", "--dest", "org.gnome.Shell",
           "--object-path", "/org/gnome/Shell", "--method", "org.gnome.Shell.Eval", code]
    return subprocess.check_output(cmd, env=dict(os.environ, DBUS_SESSION_BUS_ADDRESS=bus)).decode()

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

def run_single_test(enabled, round_idx, shell_pid, bus, idle_secs=4.0, stress_steps=150):
    env = dict(os.environ, WAYLAND_DISPLAY="wayland-window-nativizer")

    # Clean previous processes
    subprocess.call(["pkill", "-9", "-f", "perf-client.py"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.3)

    set_extension_state(enabled, bus)
    trigger_gc(bus)

    # 1. Base memory (no test window)
    mem_base = read_memory_kb(shell_pid)

    # 2. Idle Phase (1 window static)
    proc = subprocess.Popen(["python3", CLIENT_SCRIPT], env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        for line in proc.stdout:
            if line.startswith("READY_PID="):
                break
    except Exception:
        stop_process(proc)
        raise

    time.sleep(1.0)
    trigger_gc(bus)

    mem_idle = read_memory_kb(shell_pid)

    cpu_t0 = read_cpu_ticks(shell_pid)
    wall_t0 = time.perf_counter()
    time.sleep(idle_secs)
    cpu_t1 = read_cpu_ticks(shell_pid)
    wall_t1 = time.perf_counter()

    idle_cpu_secs = (cpu_t1 - cpu_t0) / float(CLK_TCK)
    idle_wall_secs = wall_t1 - wall_t0
    idle_cpu_pct = (idle_cpu_secs / idle_wall_secs) * 100.0

    stop_process(proc)
    subprocess.call(["pkill", "-9", "-f", "perf-client.py"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.4)

    # 3. Stress Phase (continuous dynamic resize at 60 FPS)
    proc_stress = subprocess.Popen(
        ["python3", CLIENT_SCRIPT, "--stress", "--steps", str(stress_steps)],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True
    )
    try:
        for line in proc_stress.stdout:
            if line.startswith("READY_PID="):
                break
    except Exception:
        stop_process(proc_stress)
        raise

    time.sleep(0.1)
    stress_cpu_t0 = read_cpu_ticks(shell_pid)
    stress_wall_t0 = time.perf_counter()

    for line in proc_stress.stdout:
        if "STRESS_DONE" in line:
            break

    stress_cpu_t1 = read_cpu_ticks(shell_pid)
    stress_wall_t1 = time.perf_counter()

    stop_process(proc_stress)
    subprocess.call(["pkill", "-9", "-f", "perf-client.py"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    stress_cpu_secs = (stress_cpu_t1 - stress_cpu_t0) / float(CLK_TCK)
    stress_wall_secs = stress_wall_t1 - stress_wall_t0
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
        "stress_cpu_ms": stress_cpu_secs * 1000.0,
        "stress_cpu_pct": stress_cpu_pct,
        "stress_wall_secs": stress_wall_secs,
    }

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
        print(">> Benchmarking with Extension DISABLED...")
        for r in range(1, rounds + 1):
            sys.stdout.write(f"   Round {r}/{rounds}... ")
            sys.stdout.flush()
            res = run_single_test(False, r, shell_pid, bus, idle_secs=idle_secs, stress_steps=stress_steps)
            results_disabled.append(res)
            print(f"Idle CPU: {res['idle_cpu_pct']:.2f}%, Stress CPU: {res['stress_cpu_ms']:.1f}ms ({res['stress_cpu_pct']:.1f}%), Delta PSS: {res['window_delta_pss']:+d}KB")

        print("\n>> Benchmarking with Extension ENABLED...")
        for r in range(1, rounds + 1):
            sys.stdout.write(f"   Round {r}/{rounds}... ")
            sys.stdout.flush()
            res = run_single_test(True, r, shell_pid, bus, idle_secs=idle_secs, stress_steps=stress_steps)
            results_enabled.append(res)
            print(f"Idle CPU: {res['idle_cpu_pct']:.2f}%, Stress CPU: {res['stress_cpu_ms']:.1f}ms ({res['stress_cpu_pct']:.1f}%), Delta PSS: {res['window_delta_pss']:+d}KB")

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
            }
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

            if failed:
                print("\n>> Performance budget check FAILED.")
                sys.exit(1)
            else:
                print("\n>> All performance budgets PASSED.")
    finally:
        subprocess.call(["pkill", "-9", "-f", "perf-client.py"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

if __name__ == "__main__":
    main()
