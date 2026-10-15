#!/usr/bin/env python3
"""Minimal reproduction for issue #129: flat ringless border excision.

Two flat ringless subjects over the white backdrop, identical except for the client's own edge:
body `#ff0000`, stroke `#0000ff`, so a residue cannot hide. The run prints the raw pixel colours
across each edge in three phases - client alone, extension on unfocused, extension on focused -
and reads the pixels, not a derived anchor: an earlier version derived the body edge from
`frame_rect` and landed a row off at 1.3333.

The bordered subject needs the `WINDOW_NATIVIZER_BORDER` probe option (`tools/probe-window.js`),
which draws the 1px ring with cairo into a full-window DrawingArea. An inset `box-shadow` on
`window.background` looks like the same thing and is not: GTK4 does not honour it, and a probe
that silently paints nothing would "measure" a clean edge.

Usage:
  python3 tools/flat-border-runs.py [scale]            # print the runs, to look at
  python3 tools/flat-border-runs.py [scale] --check    # exit 1 unless the clip excised the
                                                       # client's stroke on every edge

  scale is the nested session scale (1.0, 1.25, 1.3333, 1.5, 2.0). At 1.0 the cut is exactly one
  device pixel per side and --check passes; at fractional scales a fixed one-logical-px
  FLAT_SAFE_INSET cannot cover a 1px client border by construction (1px logical is 1.33 device px
  at 1.3333), and --check goes red. That red is issue #129.

  The flat path's cut is a device-pixel operation, so whether residue lands depends on the
  sub-pixel phase - which only the window's position sets. Re-run with SUBJECT_OFFSET_X moved
  (0..3) to tell a one-off reading apart from a property of the path.

The --check gates are anchor-free on purpose: they count blue-dominant pixels inside the subject's
own region instead of deriving "the first body row" from frame_rect arithmetic, which is the
row-off trap above. The clean subject (no client stroke) is the negative control: it must pass
everywhere, so a red bordered run next to a green clean run is the flat path, not the harness.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PID_FILE = "/tmp/window-nativizer-dev/shell.pid"
OUT = "/tmp/opencode"

SUBJECT_W, SUBJECT_H = 400, 300
SUBJECT_Y = 320
SUBJECT_X = {"clean": 300, "bordered": 800}


def apply_layout(scale):
    """Fits the subjects on the logical stage, which shrinks as the scale grows: the virtual
    monitor is always a 1920x1080 framebuffer, so at 2.0 the stage is only 960x540 logical and
    the standard layout would fall off-screen (the 2.0 IndexError). Compact keeps two subjects
    plus the focus holder and both shadow reaches on-stage at any scale this file runs."""
    global SUBJECT_W, SUBJECT_H, SUBJECT_Y, SUBJECT_X
    if 1920.0 / scale >= 1300:
        SUBJECT_W, SUBJECT_H = 400, 300
        SUBJECT_Y = 320
        SUBJECT_X = {"clean": 300, "bordered": 800}
    else:
        SUBJECT_W, SUBJECT_H = 240, 180
        SUBJECT_Y = 200
        SUBJECT_X = {"clean": 80, "bordered": 400}
# A logical-pixel offset in x. The flat path's cut is a device-pixel operation, so whether it
# lands on one side, both sides or neither depends on the sub-pixel phase - which only the
# window's position sets. Re-running with this moved is how a one-off reading is told apart
# from a property of the path.
OFFSET_X = int(os.environ.get("SUBJECT_OFFSET_X", "0"))
OFFSET_Y = int(os.environ.get("SUBJECT_OFFSET_Y", "0"))
SUBJECT_X = {k: v + OFFSET_X for k, v in SUBJECT_X.items()}
BODY, BORDER = "#ff0000", "#0000ff"
FOCUS_HOLDER = {"x": 20, "y": 20, "width": 120, "height": 80}
SPAN = 8                       # pixels printed outside and inside each edge
DEV = os.path.join(ROOT, "tools", "dev.sh")

NAMES = {(0, 0, 255): "BORDER", (255, 0, 0): "body", (255, 255, 255): "white"}


def bus_env():
    pid = open(PID_FILE).read().strip()
    raw = open(f"/proc/{pid}/environ", "rb").read().split(b"\0")
    bus = [x.decode() for x in raw if x.startswith(b"DBUS_SESSION_BUS_ADDRESS=")][0].split("=", 1)[1]
    return dict(os.environ, DBUS_SESSION_BUS_ADDRESS=bus)


def session_scale(env):
    """The live nested session's monitor scale, or None when it cannot be read."""
    try:
        return float(eval_js("global.display.get_monitor_scale(0);", env))
    except (RuntimeError, ValueError, TypeError):
        return None


def session_env(scale):
    wanted = float(scale)
    if os.path.exists(PID_FILE):
        env = bus_env()
        live = session_scale(env)
        if live is not None and abs(live - wanted) < 0.0001:
            return env
        print(f">> nested session runs at scale {live}, want {wanted}: restarting it")
        subprocess.call([DEV, "stop"])
        time.sleep(1.0)
        if os.path.exists(PID_FILE):
            os.remove(PID_FILE)
    subprocess.check_call([DEV, "shell", scale])
    time.sleep(2.0)
    return bus_env()


def eval_js(code, env):
    out = subprocess.check_output(
        ["gdbus", "call", "--session", "--dest", "org.gnome.Shell",
         "--object-path", "/org/gnome/Shell", "--method", "org.gnome.Shell.Eval", code],
        env=env).decode()
    m = re.search(r"\(\s*true,\s*'(.*)'\s*\)\s*$", out, re.S)
    if not m:
        raise RuntimeError(f"eval failed: {out[:400]}")
    inner = m.group(1).encode().decode("unicode_escape")
    if inner.startswith('"'):
        inner = json.loads(inner)
    return json.loads(inner) if isinstance(inner, str) and inner.lstrip().startswith(("{", "[")) else inner


def launch(env, name, extra, size=(SUBJECT_W, SUBJECT_H)):
    cmd = [DEV, "app", "env",
           f"WINDOW_NATIVIZER_APP_ID=dev.windownativizer.{name}",
           f"WINDOW_NATIVIZER_SIZE={size[0]}x{size[1]}",
           f"WINDOW_NATIVIZER_BODY={BODY}"] + extra + \
          ["gjs", os.path.join(ROOT, "tools", "probe-window.js")]
    subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def extension(env, state):
    subprocess.check_call([DEV, "ext", state, "window-nativizer@everyx.github.io"],
                          env=env, stdout=subprocess.DEVNULL)


def wait_for(env):
    js = """
    (() => {
        const wins = global.get_window_actors().map(a => a.meta_window).filter(Boolean);
        const counts = {};
        for (const n of ["clean", "bordered"])
            counts[n] = wins.filter(w => (w.get_gtk_application_id?.() ?? "") === "dev.windownativizer." + n).length;
        return JSON.stringify(counts);
    })()
    """
    for _ in range(60):
        c = eval_js(js, env)
        if all(v == 1 for v in c.values()):
            return
        time.sleep(0.25)
    raise RuntimeError("subjects never settled")


def wait_for_decoration(env):
    """The bordered subject must be wearing our shadow before an ON frame means anything."""
    js = """
    (() => {
        const shadows = global.window_group.get_children()
            .filter(c => c.name === "WindowNativizerShadowActor")
            .map(c => c._windowActor?.meta_window?.get_gtk_application_id?.() ?? "");
        return JSON.stringify({ bordered: shadows.filter(id => id === "dev.windownativizer.bordered").length });
    })()
    """
    for _ in range(40):
        reply = eval_js(js, env)
        if isinstance(reply, dict):
            count = reply.get("bordered", 0)
        else:
            match = re.search(r"bordered[\\\"':]+\s*(\d+)", reply)
            count = int(match.group(1)) if match else 0
        if count == 1:
            return
        time.sleep(0.25)
    raise RuntimeError("the bordered subject never got decorated")


def place(env, focused=None):
    entries = [{"name": n, "x": SUBJECT_X[n], "y": SUBJECT_Y + OFFSET_Y} for n in SUBJECT_X]
    entries.append({**FOCUS_HOLDER, "name": "focus"})
    layout = ", ".join(
        '{{id: "dev.windownativizer.{name}", x: {x}, y: {y}, w: {w}, h: {h}}}'.format(
            name=e["name"], x=e["x"], y=e["y"], w=SUBJECT_W, h=SUBJECT_H) for e in entries)
    target = focused or "focus"
    eval_js(f"""
    (() => {{
        const layout = [{layout}];
        const wins = global.get_window_actors().map(a => a.meta_window).filter(Boolean);
        const byId = id => wins.find(x => (x.get_gtk_application_id?.() ?? "") === id);
        for (const e of layout) {{ const w = byId(e.id); if (w) w.move_resize_frame(false, e.x, e.y, e.w, e.h); }}
        const t = byId("dev.windownativizer.{target}");
        if (t) t.activate(global.get_current_time());
        return 'placed';
    }})()
    """, env)
    time.sleep(0.9)


def rects(env):
    js = """
    (() => {
        const wins = global.get_window_actors().map(a => a.meta_window).filter(Boolean);
        const out = {};
        for (const n of ["clean", "bordered"]) {
            const w = wins.find(x => (x.get_gtk_application_id?.() ?? "") === "dev.windownativizer." + n);
            if (!w) { out[n] = null; continue; }
            const f = w.get_frame_rect();
            out[n] = {x: f.x, y: f.y, w: f.width, h: f.height,
                      scale: global.display.get_monitor_scale(w.get_monitor()),
                      focused: w.appears_focused};
        }
        return JSON.stringify(out);
    })()
    """
    return eval_js(js, env)


def shoot(path, env):
    if os.path.exists(path):
        os.remove(path)
    eval_js(f"""
    (() => {{
        const Shell = imports.gi.Shell, Gio = imports.gi.Gio;
        const s = new Shell.Screenshot();
        const f = Gio.File.new_for_path("{path}");
        const st = f.replace(null, false, Gio.FileCreateFlags.NONE, null);
        s.screenshot(false, st).then(() => st.close(null));
        return 'shot';
    }})()
    """, env)
    for _ in range(30):
        if os.path.exists(path) and os.path.getsize(path) > 1000:
            time.sleep(0.5)
            return Image.open(path).convert("RGB")
        time.sleep(0.2)
    raise RuntimeError("no screenshot")


def run(image, rect):
    """Runs of colour across the middle of each edge. The scan line is at the window's centre, far
    from the corners, so a corner artefact cannot be mistaken for a straight edge."""
    px = image.load()
    s = rect["scale"]
    # A pixel is 'ours' if it carries any red or blue: the client, the extension's own edge
    # artefacts and the resize band all show up, and the white backdrop does not.
    def tag(c):
        if NAMES.get(c):
            return NAMES[c]
        r, g, b = c
        if b > 120 and r < 140:
            return f"blue-ish({r},{g},{b})"     # residue, or the client's own stroke
        if r > 120 and b < 140:
            return f"red-ish({r},{g},{b})"
        return f"other({r},{g},{b})"

    left = round(rect["x"] * s)
    top = round(rect["y"] * s)
    right = round((rect["x"] + rect["w"]) * s) - 1
    bottom = round((rect["y"] + rect["h"]) * s) - 1
    mx, my = (left + right) // 2, (top + bottom) // 2
    lines = []
    lines.append(("left  ", [tag(px[x, my]) for x in range(left - SPAN, left + SPAN + 1)]))
    lines.append(("right ", [tag(px[x, my]) for x in range(right - SPAN, right + SPAN + 1)]))
    lines.append(("top   ", [tag(px[mx, y]) for y in range(top - SPAN, top + SPAN + 1)]))
    lines.append(("bottom", [tag(px[mx, y]) for y in range(bottom - SPAN, bottom + SPAN + 1)]))
    return lines


def is_blue(c):
    """A pixel carrying the client's stroke: blue-dominant, which neither the red body, the white
    backdrop, the grey shadow nor our white 0.07 outline can produce."""
    r, g, b = c
    return b > 120 and r < 140


def count_blue(image, rect):
    """Blue-dominant pixels inside the subject's own region (frame_rect grown by a margin for the
    edge, far inside the shadow's reach so the cast cannot contribute one).

    Anchor-free by construction: it counts what the pixels say, never "the first body row" derived
    from frame_rect arithmetic - that derivation is the row-off trap this file exists to avoid.
    """
    px = image.load()
    s = rect["scale"]
    margin = 4
    x0 = max(0, round(rect["x"] * s) - margin)
    y0 = max(0, round(rect["y"] * s) - margin)
    x1 = min(image.size[0], round((rect["x"] + rect["w"]) * s) + margin)
    y1 = min(image.size[1], round((rect["y"] + rect["h"]) * s) + margin)
    return sum(1 for y in range(y0, y1) for x in range(x0, x1) if is_blue(px[x, y]))


def bbox(image, rect):
    """Device-pixel extent of the CLIENT's own pixels - anything carrying red or blue.

    With the extension off this is the surface itself. With it on, whatever the clip kept. The
    difference between the two is the cut, measured rather than derived from any anchor.
    """
    px = image.load()
    s = rect["scale"]
    x0, y0 = max(0, round(rect["x"] * s) - 50), max(0, round(rect["y"] * s) - 50)
    x1 = min(image.size[0], round((rect["x"] + rect["w"]) * s) + 50)
    y1 = min(image.size[1], round((rect["y"] + rect["h"]) * s) + 50)
    hit = [(x, y) for y in range(y0, y1) for x in range(x0, x1)
           if (px[x, y][0] > 100 and px[x, y][2] < 100) or (px[x, y][2] > 100 and px[x, y][0] < 100)]
    if not hit:
        return None
    xs = [p[0] for p in hit]
    ys = [p[1] for p in hit]
    return min(xs), min(ys), max(xs), max(ys)


def show(title, image, rs):
    print(f"\n--- {title}   (scan at the window centre, {SPAN}px outside .. {SPAN}px inside)")
    for name, rect in rs.items():
        if not rect:
            print(f"  {name}: (no window)")
            continue
        print(f"  {name:<9} focused={rect['focused']!s:<5} scale={rect['scale']:.4f}  "
              f"frame edge px L={round(rect['x']*rect['scale'])} "
              f"T={round(rect['y']*rect['scale'])} "
              f"R={round((rect['x']+rect['w'])*rect['scale'])-1} "
              f"B={round((rect['y']+rect['h'])*rect['scale'])-1}   client px {bbox(image, rect)}")
        for label, tags in run(image, rect):
            print(f"    {label} " + " ".join(f"{t:<9}" for t in tags))


def check(title, image, rs, failures):
    """The --check gates: blue counts per subject region, printed next to the runs above."""
    print(f"\n--- {title}   (blue-dominant pixels inside each subject's region)")
    for name, rect in rs.items():
        if not rect:
            failures.append(f"{title}: the {name} window is not on screen")
            print(f"  {name:<9} MISSING")
            continue
        count = count_blue(image, rect)
        print(f"  {name:<9} blue pixels: {count}")
        if title.startswith("OFF"):
            # Ground truth: the bordered probe must actually be painting its stroke, or every ON
            # gate below would pass against a probe that paints nothing (the silent CSS trap).
            if name == "bordered" and count == 0:
                failures.append(f"{title}: the bordered probe paints no stroke - the repro is blind")
            if name == "clean" and count != 0:
                failures.append(f"{title}: the clean subject carries blue - the harness is broken")
        else:
            # Extension on: the clip must have excised the stroke outright, in both focus states
            # (the clip's uniforms are focus-invariant, so any ON residue is the flat path).
            if count != 0:
                failures.append(f"{title}: the {name} window keeps {count} stroke pixels - issue #129")


def main():
    parser = argparse.ArgumentParser(description="Flat ringless border excision repro (issue #129)")
    parser.add_argument("scale", nargs="?", default="1.0", help="nested session scale")
    parser.add_argument("--check", action="store_true",
                        help="exit 1 unless the clip excised the client stroke on every edge")
    args = parser.parse_args()
    apply_layout(float(args.scale))

    env = session_env(args.scale)
    subprocess.call(["pkill", "-f", "probe-window.js"])
    time.sleep(0.6)
    print(f">> nested session at scale {args.scale}")
    launch(env, "backdrop", ["WINDOW_NATIVIZER_BACKDROP=1"])
    time.sleep(1.5)
    # The focus holder: a small window in the corner that takes the focus, so the subjects share
    # the unfocused state (two windows cannot both be focused). The backdrop cannot hold it -
    # activating a window raises it, and a raised backdrop would cover the subjects.
    launch(env, "focus", [], size=(FOCUS_HOLDER["width"], FOCUS_HOLDER["height"]))
    launch(env, "clean", [])
    launch(env, "bordered", [f"WINDOW_NATIVIZER_BORDER={BORDER}"])
    extension(env, "enable")
    wait_for(env)
    extension(env, "disable")
    time.sleep(1.5)
    place(env)
    off_image = shoot(f"{OUT}/runs-client-alone.png", env)
    off_rects = rects(env)
    show("PHASE 3: extension OFF, client alone (ground truth)", off_image, off_rects)
    extension(env, "enable")
    time.sleep(1.5)
    wait_for_decoration(env)
    place(env)
    un_image = shoot(f"{OUT}/runs-unfocused.png", env)
    un_rects = rects(env)
    show("PHASE 1: extension ON, both UNFOCUSED", un_image, un_rects)
    place(env, focused="bordered")
    wait_for_decoration(env)
    fo_image = shoot(f"{OUT}/runs-focused.png", env)
    fo_rects = rects(env)
    show("PHASE 2: extension ON, bordered FOCUSED", fo_image, fo_rects)

    if args.check:
        failures = []
        check("OFF: client alone (ground truth)", off_image, off_rects, failures)
        check("ON unfocused", un_image, un_rects, failures)
        check("ON bordered focused", fo_image, fo_rects, failures)
        print()
        if failures:
            for failure in failures:
                print(f"[FAIL] {failure}")
            sys.exit(1)
        print("[OK] The flat path excised the client stroke outright - straight edges, both states.")


if __name__ == "__main__":
    main()
