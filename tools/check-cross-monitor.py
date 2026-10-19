#!/usr/bin/env python3
"""
check-cross-monitor.py - Guards a decorated window that straddles two monitors of different scales.

A window dragged across a monitor seam is sized by the engine at the *highest* resource scale among
the views it touches (`clutter_actor_get_real_resource_scale`, the rule `resolveHighestScaleMonitorIndex`
mirrors), while `win.get_monitor()` reports the one holding the largest share. When the two differed,
the clip declared the lower scale, `offscreenExtent` divided the larger FBO by it, and the body was
squeezed into the top-left of the shader's quad - the right and bottom ~25% never drawn.

This starts a nested session with two virtual monitors, applies a layout with different scales (a
1.0 monitor on the left, a 4/3 monitor on the right), puts a solid-coloured decorated window mostly
on the 1.0 monitor with its right edge across the seam, and asserts two things against the clip's own
body frame (`uFrame`) and the subpixel phase its surface container carries:

  * the body's device extent spans that frame (the whole-body cut), and
  * each straight edge sits on the frame position and each corner arc meets its straight edge
    within a sub-pixel budget, read as coverage integrals so a mask floored onto the wrong device
    grid - which moves the body a fraction of a logical pixel, not a whole band - cannot hide.

The FBO size is deliberately never asserted: it differs between unpatched mutter
(`ceilf (resource_scale)`) and a real-scale mutter.

Usage:
  python3 tools/check-cross-monitor.py            # Measure and print
  python3 tools/check-cross-monitor.py --check    # Exit 1 unless the body spans its frame
"""

import argparse
import json
import math
import os
import re
import subprocess
import sys
import time

import numpy as np
from PIL import Image

# The nested session is one shared resource; queue behind anyone already driving it. The helper
# re-execs this script with WN_SESSION_LOCK_HELD exported, so the guard is skipped coming back in.
if not os.environ.get("WN_SESSION_LOCK_HELD"):
    _HELPER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "with-session-lock.sh")
    os.execv(_HELPER, [_HELPER, os.path.abspath(__file__), *sys.argv[1:]])

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shell_eval  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_DIR = "/tmp/window-nativizer-dev"
PID_FILE = os.path.join(STATE_DIR, "shell.pid")
SHOT = "/tmp/window-nativizer-cross-monitor.png"

LEFT_MODE = "1920x1080@60.000"
RIGHT_MODE = "1920x1200@60.000"
RIGHT_SCALE = 4.0 / 3.0
SEAM = 1920
# The subject's logical frame: mostly on the 1.0 monitor (820 logical px) with its right 80 px over
# the seam, so `win.get_monitor()` is the *lower*-scale monitor while the engine takes 4/3.
SUBJECT = (1100, 200, 900, 600)
BODY_COLOR = "#ff0000"

# The body's device extent sits a device pixel inside its frame (the clip's 1px inner outline paints
# the outermost pixel) and the capture resamples the 1.0 monitor up to 4/3, so allow a few pixels.
TOLERANCE = 4

# A mask floored onto the wrong device grid moves the body by a fraction of a logical pixel, not by
# a whole band: the content check above cannot see it. The straight edges and the corner tangents are
# therefore read as coverage integrals (the estimator check-clip-tangent.py uses), which are
# unbiased through the upscale's bilinear blur, at a sub-pixel budget.
EDGE_TOLERANCE = 0.2
TANGENT_TOLERANCE = 0.2


def get_bus(pid=None):
    pid = pid or int(open(PID_FILE).read().strip())
    raw = open(f"/proc/{pid}/environ", "rb").read().split(b"\0")
    bus = [x.decode() for x in raw if x.startswith(b"DBUS_SESSION_BUS_ADDRESS=")][0].split("=", 1)[1]
    return dict(os.environ, DBUS_SESSION_BUS_ADDRESS=bus)


def eval_js(code, env):
    return shell_eval.eval_js(code, env["DBUS_SESSION_BUS_ADDRESS"])


def start_session():
    """A fresh session started with both virtual monitors; the second must exist before it boots."""
    subprocess.call([os.path.join(ROOT, "tools", "dev.sh"), "stop"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    env = dict(os.environ, WINDOW_NATIVIZER_SECOND_MONITOR="1920x1200",
               WINDOW_NATIVIZER_NO_X11="1")
    subprocess.check_call([os.path.join(ROOT, "tools", "dev.sh"), "shell", "1.0"], env=env)
    return get_bus()


def apply_monitors_config(env):
    cmd = ["gdbus", "call", "--session", "--dest", "org.gnome.Mutter.DisplayConfig",
           "--object-path", "/org/gnome/Mutter/DisplayConfig",
           "--method", "org.gnome.Mutter.DisplayConfig.GetCurrentState"]
    state = subprocess.check_output(cmd, env=env).decode()
    serial = state.split("(", 1)[1].split(",", 1)[0].replace("uint32", "").strip()
    config = (
        f'[(0, 0, 1.0, uint32 0, true, [("Meta-0", "{LEFT_MODE}", @a{{sv}} {{}})]),'
        f' (1920, 0, {RIGHT_SCALE!r}, uint32 0, false, [("Meta-1", "{RIGHT_MODE}", @a{{sv}} {{}})])]'
    )
    subprocess.check_call([
        "gdbus", "call", "--session", "--dest", "org.gnome.Mutter.DisplayConfig",
        "--object-path", "/org/gnome/Mutter/DisplayConfig",
        "--method", "org.gnome.Mutter.DisplayConfig.ApplyMonitorsConfig",
        serial, "1", config, "@a{sv} {}"], env=env, stdout=subprocess.DEVNULL)
    time.sleep(0.8)


def monitor_layout(env):
    """The configured logical monitors, read back from the shell, so the expected scale is the
    shell's own answer rather than a second copy of the config."""
    reply = eval_js("""
    (() => {
        const d = global.display;
        const out = [];
        for (let i = 0; i < d.get_n_monitors(); i++) {
            const g = d.get_monitor_geometry(i);
            out.push({i, scale: d.get_monitor_scale(i), x: g.x, y: g.y, w: g.width, h: g.height});
        }
        return JSON.stringify(out);
    })()
    """, env)
    match = re.search(r"\[.*\]", reply.replace("\\", ""), re.S)
    return json.loads(match.group(0)) if match else []


def close_existing(env):
    eval_js("""
    (() => {
        for (const a of global.get_window_actors()) {
            const id = a.meta_window?.get_gtk_application_id?.() ?? "";
            if (id.startsWith("dev.windownativizer."))
                a.meta_window.delete(global.get_current_time());
        }
        return "ok";
    })()
    """, env)
    time.sleep(0.5)


def launch(env, name, extra_env):
    command = [os.path.join(ROOT, "tools", "dev.sh"), "app", "env",
               f"WINDOW_NATIVIZER_APP_ID=dev.windownativizer.{name}"]
    command += extra_env + ["gjs", os.path.join(ROOT, "tools", "probe-window.js")]
    subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)


def place_and_read(env):
    """Puts the subject down, waits for its decoration, and reads the numbers the check reports."""
    js = f"""
    (() => {{
        const byId = id => global.get_window_actors().map(a => a.meta_window)
            .find(w => (w.get_gtk_application_id?.() ?? "") === id);
        const m = byId("dev.windownativizer.subject");
        if (m) m.move_resize_frame(false, {SUBJECT[0]}, {SUBJECT[1]}, {SUBJECT[2]}, {SUBJECT[3]});
        const decorated = global.window_group.get_children().some(c =>
            c.name === "WindowNativizerShadowActor" && c._windowActor?.meta_window === m);
        if (!m || !decorated) return JSON.stringify({{wait: true}});
        const wa = m.get_compositor_private();
        const walk = a => {{
            for (const e of (a.get_effects?.() || []))
                if ((e.constructor?.$gtype?.name ?? "").includes("Clip"))
                    return {{effect: e, actor: a}};
            for (const k of (a.get_children?.() || [])) {{
                const hit = walk(k);
                if (hit) return hit;
            }}
            return null;
        }};
        const hit = walk(wa);
        if (!hit) return JSON.stringify({{wait: true}});
        const e = hit.effect;
        const t = hit.actor;
        const f = m.get_frame_rect();
        const size = e.get_target_size?.();
        // The container's own transform carries the subpixel phase on this path (the clip does not
        // fold it), so the body's stage position is the layout origin plus that translation. Read
        // the same way the extension reads it: the transform translation less the layout position.
        let applied = null;
        const matrix = t?.get_transform?.();
        if (matrix?.get_x_translation) {{
            applied = [
                matrix.get_x_translation() - ((t.x ?? 0) + (t.translation_x ?? 0)),
                matrix.get_y_translation() - ((t.y ?? 0) + (t.translation_y ?? 0)),
            ];
        }}
        return JSON.stringify({{
            frame: [f.x, f.y, f.width, f.height],
            mainMonitor: m.get_monitor(),
            mainScale: global.display.get_monitor_scale(m.get_monitor()),
            clipScale: e._scale ?? null,
            radius: e._radius ?? null,
            appliedPhase: applied,
            frameVec: e._frameVec ? Array.from(e._frameVec) : null,
            quadVec: e._quadVec ? Array.from(e._quadVec) : null,
            targetSize: size ? Array.from(size) : null,
        }});
    }})()
    """
    previous = None
    for _ in range(80):
        reply = eval_js(js, env)
        match = re.search(r"\{.*\}", reply.replace("\\", ""), re.S)
        if match and '"wait"' not in match.group(0):
            geom = json.loads(match.group(0))
            # Settle on a decoration that has stopped moving: the first paint after the move can
            # still carry the previous scale while the reconcile runs.
            marker = (geom["clipScale"], geom["quadVec"], geom["frame"])
            if marker == previous and geom["frameVec"]:
                return geom
            previous = marker
        time.sleep(0.25)
    return None


def shoot(env):
    subprocess.call(["gdbus", "call", "--session", "--dest", "org.gnome.Shell",
                     "--object-path", "/org/gnome/Shell",
                     "--method", "org.freedesktop.DBus.Properties.Set",
                     "org.gnome.Shell", "OverviewActive", "<false>"],
                    env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.4)
    if os.path.exists(SHOT):
        os.remove(SHOT)
    subprocess.check_output(["gdbus", "call", "--session", "--dest", "org.gnome.Shell",
                             "--object-path", "/org/gnome/Shell/Screenshot",
                             "--method", "org.gnome.Shell.Screenshot.Screenshot", "false", "false",
                             SHOT], env=env)
    for _ in range(40):
        if os.path.exists(SHOT) and os.path.getsize(SHOT) > 1000:
            return
        time.sleep(0.2)


def body_bbox(path, region):
    """The device-pixel extent of the subject's own body colour inside `region` (x0, y0, w, h +
    margin), or None. Scoped to the subject so a red panel icon cannot widen the box."""
    image = np.asarray(Image.open(path).convert("RGB")).astype(int)
    red = (image[:, :, 0] > 150) & (image[:, :, 1] < 110) & (image[:, :, 2] < 110)
    margin = 80
    x0, y0, w, h = region
    sub = red[max(0, y0 - margin):y0 + h + margin, max(0, x0 - margin):x0 + w + margin]
    ys, xs = np.nonzero(sub)
    if len(xs) == 0:
        return None
    left = max(0, x0 - margin) + int(xs.min())
    top = max(0, y0 - margin) + int(ys.min())
    return left, top, left + int(xs.max() - xs.min()), top + int(ys.max() - ys.min())


def red_coverage(path):
    """Body coverage in [0, 1] per pixel: red minus the stronger of green and blue. One inside the
    red body, zero on the white backdrop, a dark desktop, or a blue/green tint, and linear through
    an anti-aliased edge whatever the colour behind it."""
    image = np.asarray(Image.open(path).convert("RGB")).astype(float)
    other = np.maximum(image[:, :, 1], image[:, :, 2])
    return np.clip((image[:, :, 0] - other) / 255.0, 0.0, 1.0)


def measure_frame(coverage, body, radius):
    """Every body edge as a coverage integral, and every corner-arc tangent against the straight
    edge it meets, with the arc's own curvature removed. `body` is (left, top, right, bottom) in
    device px; `radius` is the clip's corner radius in device px."""
    left, top, right, bottom = body
    midx, midy = int((left + right) / 2), int((top + bottom) / 2)
    span = 12

    def edge_x(y, x_lo, x_hi, from_left=True):
        total = (1.0 - coverage[y, x_lo:x_hi]).sum()
        return x_lo + total if from_left else x_hi - total

    def edge_y(x, y_lo, y_hi, from_top=True):
        total = (1.0 - coverage[y_lo:y_hi, x]).sum()
        return y_lo + total if from_top else y_hi - total

    straight = {
        "left": edge_x(midy, int(left) - span, midx),
        "top": edge_y(midx, int(top) - span, midy),
        "right": edge_x(midy, midx, int(right) + span, False),
        "bottom": edge_y(midx, midy, int(bottom) + span, False),
    }

    def curvature(distance):
        d = min(distance, radius)
        return radius - math.sqrt(max(radius * radius - d * d, 0.0))

    tangents = []
    plan = [
        ("tl left", "row", top + radius, "left"),
        ("tr right", "row", top + radius, "right"),
        ("bl left", "row", bottom - radius, "left"),
        ("br right", "row", bottom - radius, "right"),
        ("tl top", "col", left + radius, "top"),
        ("tr top", "col", right - radius, "top"),
        ("bl bottom", "col", left + radius, "bottom"),
        ("br bottom", "col", right - radius, "bottom"),
    ]
    # The tangent point is where the arc meets the straight edge; sampling one and two pixels in
    # lands on the arc, which has curved in by a known amount that is not a frame error.
    for label, axis, tangent, side in plan:
        samples = [int(tangent) - 1, int(tangent) - 2]
        if axis == "row":
            values = [edge_x(r, int(left) - span, midx) if side == "left"
                      else edge_x(r, midx, int(right) + span, False) for r in samples]
        else:
            values = [edge_y(c, int(top) - span, midy) if side == "top"
                      else edge_y(c, midy, int(bottom) + span, False) for c in samples]
        curve = sum(curvature(abs(tangent - (v + 0.5))) for v in samples) / len(samples)
        tangents.append((label, sum(values) / len(values), straight[side], curve))
    return straight, tangents


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true",
                        help=f"Exit 1 unless the body spans its frame and every edge and corner "
                             f"tangent is within {EDGE_TOLERANCE} device px")
    args = parser.parse_args()

    env = start_session()
    apply_monitors_config(env)
    layout = monitor_layout(env)
    print(f">> Logical monitors: {json.dumps(layout)}")
    if len(layout) != 2:
        print(f"!! Expected two logical monitors, got {len(layout)}")
        return 1
    scales = sorted(round(m["scale"], 3) for m in layout)
    capture_scale = max(m["scale"] for m in layout)

    close_existing(env)
    launch(env, "backdrop", ["WINDOW_NATIVIZER_BACKDROP=1", "WINDOW_NATIVIZER_SIZE=800x600"])
    time.sleep(1.0)
    launch(env, "subject", [f"WINDOW_NATIVIZER_BODY={BODY_COLOR}",
                            f"WINDOW_NATIVIZER_SIZE={SUBJECT[2]}x{SUBJECT[3]}"])
    geom = place_and_read(env)
    if not geom:
        print("!! The decorated subject never settled")
        return 1
    print(f">> Subject: frame={geom['frame']} main monitor={geom['mainMonitor']} "
          f"(scale {geom['mainScale']}) clip scale={geom['clipScale']} radius={geom['radius']} "
          f"phase={geom.get('appliedPhase')}")

    # The check only means something when the main monitor is the lower-scale one and its sliver
    # reaches the other: otherwise the defect this guards cannot be present.
    if not (geom["mainScale"] < capture_scale - 1e-3):
        print(f"!! The window's main monitor scale {geom['mainScale']} is not below the highest "
              f"{capture_scale}; the straddle did not land as configured")
        return 1
    problems = []
    if geom["clipScale"] is None or abs(geom["clipScale"] - capture_scale) > 1e-3:
        problems.append(f"the clip declared scale {geom['clipScale']}, not the engine's "
                        f"{capture_scale}")

    shoot(env)
    # The clip's own body frame (`uFrame`) is the window frame less the flat-safe inset the clip
    # uses to erase a client-drawn stroke: it is what the texture must span, so it is the expected
    # extent - not the raw window frame, which would count that deliberate inset as a defect. The
    # surface container's transform carries the subpixel phase, so the body's stage position is the
    # frame plus that phase plus the body frame.
    fx, fy, _, _ = geom["frame"]
    ux, uy, uw, uh = geom["frameVec"]
    phase_x, phase_y = geom.get("appliedPhase") or (0.0, 0.0)
    body_x, body_y = fx + phase_x, fy + phase_y
    expected_w, expected_h = round(uw * capture_scale), round(uh * capture_scale)
    expected_x0, expected_y0 = round((body_x + ux) * capture_scale), round((body_y + uy) * capture_scale)
    box = body_bbox(SHOT, (expected_x0, expected_y0, expected_w, expected_h))
    if not box:
        print("!! No subject body pixels found in the screenshot")
        return 1
    x0, y0, x1, y1 = box
    width, height = x1 - x0 + 1, y1 - y0 + 1
    print(f">> Body device extent {width}x{height} at ({x0},{y0}); expected {expected_w}x{expected_h} "
          f"at ({expected_x0},{expected_y0}) (clip body frame {uw}x{uh} logical at capture scale "
          f"{capture_scale:.6f})")

    dw, dh = abs(width - expected_w), abs(height - expected_h)
    healthy = dw <= TOLERANCE and dh <= TOLERANCE and abs(x0 - expected_x0) <= TOLERANCE \
        and abs(y0 - expected_y0) <= TOLERANCE
    print(f">> Body vs frame: width off {dw}px, height off {dh}px (tolerance {TOLERANCE})")
    if not healthy:
        problems.append(f"the body is {width}x{height} device px against a {expected_w}x"
                        f"{expected_h} frame at ({expected_x0},{expected_y0}) - a missing band on "
                        f"the right or bottom")

    # The content check above cannot see a mask floored onto the wrong device grid, so the edges and
    # corner tangents are measured again as coverage integrals against the same clip frame.
    body = ((body_x + ux) * capture_scale, (body_y + uy) * capture_scale,
            (body_x + ux + uw) * capture_scale, (body_y + uy + uh) * capture_scale)
    radius_dev = (geom["radius"] or 0) * capture_scale
    straight, tangents = measure_frame(red_coverage(SHOT), body, radius_dev)
    nominal = {"left": body[0], "top": body[1], "right": body[2], "bottom": body[3]}
    worst_edge = 0.0
    for side, value in straight.items():
        delta = value - nominal[side]
        worst_edge = max(worst_edge, abs(delta))
        print(f"   straight {side:6s} measured {value:9.3f}  frame {nominal[side]:9.3f}  "
              f"origin d={delta:+.3f}")
        if abs(delta) > EDGE_TOLERANCE:
            problems.append(f"body {side} edge is {delta:+.3f} device px off its frame "
                            f"(budget {EDGE_TOLERANCE})")
    worst_tangent = 0.0
    for label, value, edge, curve in tangents:
        delta = (value - edge) - curve
        worst_tangent = max(worst_tangent, abs(delta))
        print(f"   tangent  {label:9s} measured {value:9.3f}  arc-vs-edge {value - edge:+.3f}  "
              f"-curvature {curve:.3f}  d={delta:+.3f}")
        if abs(delta) > TANGENT_TOLERANCE:
            problems.append(f"corner tangent {label} is {delta:+.3f} device px off its frame line "
                            f"(budget {TANGENT_TOLERANCE})")
    print(f">> Origin: worst straight-edge offset {worst_edge:.3f} device px; worst corner tangent "
          f"{worst_tangent:.3f} device px (budgets {EDGE_TOLERANCE} / {TANGENT_TOLERANCE})")

    if args.check and problems:
        for problem in problems:
            print(f"!! {problem}")
        return 1
    if args.check:
        print(f">> Body spans its frame and every edge and corner tangent is on it at {scales}: "
              f"PASSED (origin <= {EDGE_TOLERANCE} device px, tangent <= {TANGENT_TOLERANCE})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
