#!/usr/bin/env python3
"""
check-clip-tangent.py - Guards the clip's frame against the box Clutter actually gave it, in pixels.

The rounded clip is evaluated in the offscreen FBO's coordinate space: the shader's texture
coordinates span the whole FBO, so its `p` only means logical pixels if the box it is handed is the
FBO divided by the monitor scale. Two things were once derived from stale constants and both showed
up here:

  * the FBO extent (the old constants encoded a caller that scaled by `ceilf (resource_scale)`), so
    at 1.25x one shader unit was 1.2522 device px instead of 1.25 - the window's corner arc and its
    pixel-snapped straight edge then disagreed by up to half a physical pixel;
  * the float32 rounding of the scaled edge, so at 4/3 the box came out one logical pixel too tall
    and the bottom edge was cut a device pixel short.

Measured on a red bare client over a white backdrop, at whatever scale the session runs:
`get_target_size()` is compared against the derived box exactly, and every straight edge and the two
tangents of every corner arc are compared against the body frame the clip reports, in device px.

The straight edges are a hard cut and the arcs an anti-aliased one, so both are read as coverage
integrals rather than as a 0.5 crossing of a sampled row: a crossing sits half a pixel inside a step
by construction, which is exactly the estimator error this defect can hide in. The tangent samples
sit one and two device rows above the tangent, where the arc has curved in by
`r - sqrt (r**2 - (r - d)**2)` (~0.04 and 0.14 px at r = 18.75) - the tolerance below covers that.

Usage:
  python3 tools/check-clip-tangent.py            # Measure and print
  python3 tools/check-clip-tangent.py --check    # Exit 1 unless every edge and tangent agrees
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
SHOT = "/tmp/window-nativizer-clip-tangent.png"

SUBJECT = (300, 96, 441, 281)

# Healthy is <= 0.09 device px (the arc's own curvature at the sampled rows, plus the shader's 1px
# inner outline shifting every coverage integral outward by ~0.08). The defect this replaces read
# -0.43 at 1.25x and -0.89 at 4/3.
# Straight edges: healthy is <= 0.09 device px (the shader's 1px inner outline shifts every coverage
# integral outward by ~0.08). The defect this replaces read -0.89 at 4/3 and -0.43 at 1.25 arc-vs-edge.
TOLERANCE = 0.15

# Corner tangents, with the arc's curvature and the outline bias removed: healthy is <= 0.01.
TANGENT_TOLERANCE = 0.1


def ensure_session():
    if not os.path.exists(PID_FILE):
        print(">> Starting nested shell via dev.sh...")
        subprocess.check_call([os.path.join(ROOT, "tools", "dev.sh"), "shell"])
        time.sleep(2.0)
    pid = open(PID_FILE).read().strip()
    raw = open(f"/proc/{pid}/environ", "rb").read().split(b"\0")
    bus = [x.decode() for x in raw if x.startswith(b"DBUS_SESSION_BUS_ADDRESS=")][0].split("=", 1)[1]
    return dict(os.environ, DBUS_SESSION_BUS_ADDRESS=bus)


def eval_js(code, env):
    return shell_eval.eval_js(code, env["DBUS_SESSION_BUS_ADDRESS"])


def launch(env, name, extra_env):
    command = [os.path.join(ROOT, "tools", "dev.sh"), "app", "env",
               f"WINDOW_NATIVIZER_APP_ID=dev.windownativizer.{name}",
               f"WINDOW_NATIVIZER_SIZE={SUBJECT[2]}x{SUBJECT[3]}"]
    command += extra_env + ["gjs", os.path.join(ROOT, "tools", "probe-window.js")]
    subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)


def close_existing(env):
    """One run per session: a second run must not measure the first run's windows."""
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


def place_and_read(env):
    """Puts the subject down, waits for its shadow sibling, and returns the clip's own geometry."""
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
        const size = e.get_target_size?.();
        const f = m.get_frame_rect();
        return JSON.stringify({{
            frame: [f.x, f.y, f.width, f.height],
            scale: global.display.get_monitor_scale(m.get_monitor()),
            frameVec: e._frameVec ? Array.from(e._frameVec) : null,
            quadVec: e._quadVec ? Array.from(e._quadVec) : null,
            offsetVec: e._offsetVec ? Array.from(e._offsetVec) : null,
            targetSize: size ? Array.from(size) : null,
        }});
    }})()
    """
    for _ in range(80):
        reply = eval_js(js, env)
        m = re.search(r"\{.*\}", reply.replace("\\", ""), re.S)
        if m and '"wait"' not in m.group(0):
            return json.loads(m.group(0))
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
            break
        time.sleep(0.2)


def redness(path):
    img = np.asarray(Image.open(path).convert("RGB")).astype(float)
    return np.clip((img[:, :, 0] - img[:, :, 1]) / 255.0, 0, 1)


def measure(geom):
    """Every frame line as a coverage integral, plus the box the shader was handed."""
    A = redness(SHOT)
    scale = geom["scale"]
    fx, fy, fw, fh = geom["frame"]
    ux, uy, uw, uh = geom["frameVec"]
    bodyx, bodyy = (fx + ux) * scale, (fy + uy) * scale
    bodyr, bodyb = bodyx + uw * scale, bodyy + uh * scale
    radius = 15.0 * scale
    n = 12
    midx, midy = int((bodyx + bodyr) / 2), int((bodyy + bodyb) / 2)

    def edge_x(y, x_lo, x_hi, from_left=True):
        s = (1.0 - A[y, x_lo:x_hi]).sum()
        return x_lo + s if from_left else x_hi - s

    def edge_y(x, y_lo, y_hi, from_top=True):
        s = (1.0 - A[y_lo:y_hi, x]).sum()
        return y_lo + s if from_top else y_hi - s

    def curvature(distance):
        """How far the arc has already curved in, `distance` px away from its tangent."""
        d = min(distance, radius)
        return radius - math.sqrt(max(radius * radius - d * d, 0.0))

    straight = {
        "left": edge_x(midy, int(bodyx) - n, midx),
        "top": edge_y(midx, int(bodyy) - n, midy),
        "right": edge_x(midy, midx, int(bodyr) + n, False),
        "bottom": edge_y(midx, midy, int(bodyb) + n, False),
    }
    # Each corner arc is sampled one and two device px from the tangent point that meets a straight
    # edge; the arc's curvature there is a known geometric offset, not a frame error, so it is
    # removed. Vertical tangents are sampled along rows, horizontal ones along columns.
    tl_r, tl_c = bodyy + radius, bodyx + radius
    bl_r, bl_c = bodyb - radius, bodyx + radius
    tr_r, tr_c = bodyy + radius, bodyr - radius
    br_r, br_c = bodyb - radius, bodyr - radius
    plan = [
        ("tl left", "row", tl_r, "left"),
        ("tr right", "row", tr_r, "right"),
        ("bl left", "row", bl_r, "left"),
        ("br right", "row", br_r, "right"),
        ("tl top", "col", tl_c, "top"),
        ("tr top", "col", tr_c, "top"),
        ("bl bottom", "col", bl_c, "bottom"),
        ("br bottom", "col", br_c, "bottom"),
    ]
    out_tangents = []
    for label, axis, tangent, side in plan:
        samples = [int(tangent) - 1, int(tangent) - 2]
        if axis == "row":
            values = [edge_x(r, int(bodyx) - n, midx) if side == "left"
                      else edge_x(r, midx, int(bodyr) + n, False) for r in samples]
        else:
            values = [edge_y(c, int(bodyy) - n, midy) if side == "top"
                      else edge_y(c, midy, int(bodyb) + n, False) for c in samples]
        curve = sum(curvature(abs(tangent - (v + 0.5))) for v in samples) / len(samples)
        out_tangents.append((label, sum(values) / len(values), straight[side], curve))
    return {"straight": straight, "tangent": out_tangents, "body": (bodyx, bodyy, bodyr, bodyb)}


def main():
    parser = argparse.ArgumentParser(description="Window Nativizer clip frame vs offscreen box")
    parser.add_argument("--check", action="store_true",
                        help=f"Exit 1 unless every edge and tangent agrees within {TOLERANCE} px")
    args = parser.parse_args()

    env = ensure_session()
    close_existing(env)
    launch(env, "backdrop", ["WINDOW_NATIVIZER_BACKDROP=1"])
    time.sleep(2.0)
    launch(env, "subject", ["WINDOW_NATIVIZER_BODY=#ff0000", "WINDOW_NATIVIZER_TITLE=WN-Tangent"])
    time.sleep(4.0)

    geom = place_and_read(env)
    if geom is None:
        sys.exit("!! [clip-tangent] the subject was never decorated; is the extension enabled?")
    shoot(env)
    m = measure(geom)

    scale = geom["scale"]
    print(f">> scale {scale}  frame {geom['frame']}  uFrame {geom['frameVec']}  "
          f"uQuadSize {geom['quadVec']}  uFboOffset {geom['offsetVec']}")
    bx, by, br, bb = m["body"]
    print(f">> body frame (device px): left {bx:.3f} top {by:.3f} right {br:.3f} bottom {bb:.3f}")

    failures = []
    quad, target = geom["quadVec"], geom["targetSize"]
    if not target or not target[0]:
        failures.append("the clip reports no offscreen target size")
    else:
        for axis, dev in enumerate(target[1:]):
            span = quad[axis]
            if abs(span * scale - dev) > 1e-6:
                failures.append(f"offscreen box {'wh'[axis]}: derived {span} logical units spans "
                                f"{span * scale:.6f} device px, the FBO is {dev}")
        print(f">> FBO {target[1]}x{target[2]} device px = uQuadSize x scale "
              f"({quad[0] * scale:.4f}, {quad[1] * scale:.4f})")

    bx, by, br, bb = m["body"]
    nominal = {"left": bx, "top": by, "right": br, "bottom": bb}
    for side, value in m["straight"].items():
        delta = value - nominal[side]
        print(f"   straight {side:6s} measured {value:8.3f}  frame {nominal[side]:8.3f}  d={delta:+.3f}")
        if abs(delta) > TOLERANCE:
            failures.append(f"straight {side} is {delta:+.3f} px off the body frame")
    # The same 1px inner outline shifts both estimators outward, so the tangent is compared against
    # the straight edge it meets (bias cancels) with the arc's own curvature removed.
    for label, value, edge, curve in m["tangent"]:
        delta = (value - edge) - curve
        print(f"   tangent  {label:9s} measured {value:8.3f}  arc-vs-edge {(value - edge):+.3f}  "
              f"-curvature {curve:.3f}  d={delta:+.3f}")
        if abs(delta) > TANGENT_TOLERANCE:
            failures.append(f"corner arc tangent {label} is {delta:+.3f} px off the frame line")

    if failures:
        for f in failures:
            print(f"!! [clip-tangent] {f}")
        if args.check:
            sys.exit(1)
        print(f">> {len(failures)} disagreement(s) over budget "
              f"({TOLERANCE}px straight, {TANGENT_TOLERANCE}px tangent).")
        return
    print(f">> PASSED: every straight edge is on the body frame within {TOLERANCE}px and every "
          f"corner tangent within {TANGENT_TOLERANCE}px.")


if __name__ == "__main__":
    main()
