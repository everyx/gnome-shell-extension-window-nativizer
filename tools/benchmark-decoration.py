#!/usr/bin/env python3
"""
benchmark-decoration.py - Measures Window Nativizer window decoration profile and
verifies the attenuation gradient against the 1.0x golden baseline.

Usage:
  python3 tools/benchmark-decoration.py            # Run benchmark and print comparison
  python3 tools/benchmark-decoration.py --check    # Exit 1 if deviation from baseline > 1 level
  python3 tools/benchmark-decoration.py --native   # Also measure live native Libadwaita
"""

import sys
import os
import time
import subprocess
import argparse
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_DIR = "/tmp/window-nativizer-dev"
PID_FILE = os.path.join(STATE_DIR, "shell.pid")
SHOT_PATH = os.path.join(STATE_DIR, "shot_benchmark.png")

# Golden Baseline (1.0x Integer Scale, Offsets 0..22)
# Offset 0 is inner outline (G channel), 1..N is shadow attenuation into 255 (white backdrop)
BASELINE_CSD = [
    9, 191, 208, 218, 227, 233, 238, 242, 246, 249, 251, 253, 254, 254, 255
]
BASELINE_NATIVE = [
    18, 199, 216, 221, 227, 231, 235, 238, 241, 243, 245, 247, 248, 250, 251, 252, 252, 253, 254, 254, 254, 254, 255
]

def ensure_session():
    if not os.path.exists(PID_FILE):
        print(">> Starting nested shell via dev.sh...")
        subprocess.check_call([os.path.join(ROOT, "tools", "dev.sh"), "shell"])
        time.sleep(2.0)
    pid = open(PID_FILE).read().strip()
    raw_env = open(f"/proc/{pid}/environ", "rb").read().split(b"\0")
    bus = [x.decode() for x in raw_env if x.startswith(b"DBUS_SESSION_BUS_ADDRESS=")][0].split("=", 1)[1]
    return dict(os.environ, DBUS_SESSION_BUS_ADDRESS=bus)

def eval_js(code, env):
    cmd = ["gdbus", "call", "--session", "--dest", "org.gnome.Shell",
           "--object-path", "/org/gnome/Shell", "--method", "org.gnome.Shell.Eval", code]
    return subprocess.check_output(cmd, env=env).decode()

def hide_overview(env):
    cmd = ["gdbus", "call", "--session", "--dest", "org.gnome.Shell",
           "--object-path", "/org/gnome/Shell", "--method", "org.freedesktop.DBus.Properties.Set",
           "org.gnome.Shell", "OverviewActive", "<false>"]
    subprocess.call(cmd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def shoot(target_path, env):
    if os.path.exists(target_path):
        os.remove(target_path)
    hide_overview(env)
    time.sleep(0.4)
    js = f"""
    const Shell = imports.gi.Shell;
    const Gio = imports.gi.Gio;
    const s = new Shell.Screenshot();
    const file = Gio.File.new_for_path("{target_path}");
    const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
    s.screenshot(false, stream).then(() => {{ stream.close(null); }});
    "shot";
    """
    eval_js(js, env)
    for _ in range(25):
        if os.path.exists(target_path) and os.path.getsize(target_path) > 1000:
            break
        time.sleep(0.2)
    time.sleep(0.4)

def measure_target(is_native, env):
    # Ensure clean state
    subprocess.call(["pkill", "-9", "-f", "probe-window.js"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.5)

    # Launch white backdrop
    subprocess.Popen([
        os.path.join(ROOT, "tools", "dev.sh"), "app", "env", "WINDOW_NATIVIZER_BACKDROP=1",
        "gjs", os.path.join(ROOT, "tools", "probe-window.js")
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)

    # Launch test target
    extra_env = ["WINDOW_NATIVIZER_MODE=native"] if is_native else []
    subprocess.Popen([
        os.path.join(ROOT, "tools", "dev.sh"), "app", "env"
    ] + extra_env + [
        "WINDOW_NATIVIZER_BODY=#ff0000", "WINDOW_NATIVIZER_SIZE=440x280",
        "gjs", os.path.join(ROOT, "tools", "probe-window.js")
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)

    title_needle = "native" if is_native else "probe"
    eval_js(f"""
    const win = global.display.get_tab_list(0, null).find(w => w.get_title().includes('{title_needle}'));
    if (win) {{ win.activate(global.get_current_time()); }}
    """, env)
    time.sleep(0.8)

    shoot(SHOT_PATH, env)
    subprocess.call(["pkill", "-9", "-f", "probe-window.js"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    im = Image.open(SHOT_PATH).convert("RGB")
    w, h = im.size
    px = im.load()

    # Find red window
    min_x, max_x = w, 0
    min_y, max_y = h, 0
    found = False
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            r, g, b = px[x, y]
            if r > 200 and g < 50 and b < 50:
                min_x = min(min_x, x)
                max_x = max(max_x, x)
                min_y = min(min_y, y)
                max_y = max(max_y, y)
                found = True

    if not found:
        raise RuntimeError("Could not find red test window in screenshot")

    mid_x = (min_x + max_x) // 2
    mid_y = (min_y + max_y) // 2

    # Refine boundaries
    top_y, bottom_y = min_y, max_y
    left_x, right_x = min_x, max_x

    for y in range(min_y - 15, min_y + 15):
        if 0 <= y < h and px[mid_x, y][0] > 150 and px[mid_x, y][0] > px[mid_x, y][1] + 50:
            top_y = y
            break
    for y in range(max_y + 15, max_y - 15, -1):
        if 0 <= y < h and px[mid_x, y][0] > 150 and px[mid_x, y][0] > px[mid_x, y][1] + 50:
            bottom_y = y
            break
    for x in range(min_x - 15, min_x + 15):
        if 0 <= x < w and px[x, mid_y][0] > 150 and px[x, mid_y][0] > px[x, mid_y][1] + 50:
            left_x = x
            break
    for x in range(max_x + 15, max_x - 15, -1):
        if 0 <= x < w and px[x, mid_y][0] > 150 and px[x, mid_y][0] > px[x, mid_y][1] + 50:
            right_x = x
            break

    max_len = 25
    bottom = [px[mid_x, bottom_y + off][1] if bottom_y + off < h else 255 for off in range(max_len)]
    top = [px[mid_x, top_y - off][1] if top_y - off >= 0 else 255 for off in range(max_len)]
    left = [px[left_x - off, mid_y][1] if left_x - off >= 0 else 255 for off in range(max_len)]
    right = [px[right_x + off, mid_y][1] if right_x + off < w else 255 for off in range(max_len)]

    return {
        "bottom": bottom,
        "top": top,
        "left": left,
        "right": right,
        "width": right_x - left_x + 1,
        "height": bottom_y - top_y + 1,
    }

def main():
    parser = argparse.ArgumentParser(description="Window Nativizer Decoration Benchmark Tool")
    parser.add_argument("--check", action="store_true", help="Verify Window Nativizer against baseline with zero regression")
    parser.add_argument("--native", action="store_true", help="Also run live measurement of native Libadwaita")
    args = parser.parse_args()

    env = ensure_session()

    try:
        print(">> Measuring Window Nativizer decoration profile...")
        csd = measure_target(False, env)

        # Check symmetry
        is_symmetric = (csd["bottom"] == csd["top"] == csd["left"] == csd["right"])
        measured_profile = csd["bottom"]

        print("\n" + "=" * 76)
        print("                WINDOW NATIVIZER DECORATION BENCHMARK REPORT")
        print("=" * 76)
        print(f"Window Geometry : {csd['width']}x{csd['height']} (expected 440x280)")
        print(f"Symmetry Status : {'PASS (100% 4-way symmetric)' if is_symmetric else 'FAIL (edges diverge)'}")
        print("-" * 76)

        header = f"{'Offset':<7} | {'Current CSD':<12} | {'Baseline CSD':<13} | {'Baseline Native':<15} | {'CSD Delta':<9}"
        print(header)
        print("-" * 76)

        max_rows = 18
        max_dev = 0
        for off in range(max_rows):
            cur = measured_profile[off]
            base_csd = BASELINE_CSD[off] if off < len(BASELINE_CSD) else 255
            base_nat = BASELINE_NATIVE[off] if off < len(BASELINE_NATIVE) else 255
            delta = cur - base_csd
            if abs(delta) > max_dev:
                max_dev = abs(delta)
            delta_str = f"{delta:+d}" if delta != 0 else "0"
            print(f"{off:<7d} | {cur:<12d} | {base_csd:<13d} | {base_nat:<15d} | {delta_str:<9}")

        print("-" * 76)
        print(f"Max Deviation from CSD Baseline: {max_dev} gray level(s)")

        if args.native:
            print("\n>> Measuring live Native Libadwaita decoration profile...")
            nat = measure_target(True, env)
            nat_symmetric = (nat["bottom"] == nat["top"] == nat["left"] == nat["right"])
            print(f"Native Symmetry : {'PASS (100% 4-way symmetric)' if nat_symmetric else 'FAIL'}")
            print(f"Native Profile  : {nat['bottom'][:18]}")

        if args.check:
            if not is_symmetric:
                print("\n[FAIL] Four-side symmetry check failed!")
                sys.exit(1)
            if max_dev > 1:
                print(f"\n[FAIL] Max deviation ({max_dev}) exceeded tolerance (<= 1)!")
                sys.exit(1)
            print("\n[OK] Benchmark verification passed: zero regression.")
    finally:
        subprocess.call(["pkill", "-9", "-f", "probe-window.js"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

if __name__ == "__main__":
    main()
