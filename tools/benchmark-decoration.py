#!/usr/bin/env python3
"""
benchmark-decoration.py - Measures this extension's decoration against libadwaita's own, on one frame.

The claim is "a window we decorate is decorated the way libadwaita decorates one", so the reference is
a live libadwaita window - and it is measured in the *same screenshot* as the windows under test, with
all of them in the same focus state, on the same uniform backdrop. Nothing about the machine (colour
management, scale, backdrop colour, animation phase) has to be assumed stable, because none of it
differs between the two sides of the comparison, and no profile is stored for later: a stored copy of
our own earlier output can only ever say that we changed, and a stored copy of upstream's still has to
be trusted as a description of this machine.

Three windows are measured at once, because "we decorate it" is two different jobs with two different
paths through the code:

    native     an Adw.ApplicationWindow, decorated by libadwaita   - the reference
    declared   a GTK4 client whose own decoration is left on, so it declares a shadow margin ring,
               and the extension clears that ring and takes the shadow over
    bare       a GTK4 client with no decoration at all, so the extension draws corners and a shadow
               around a body that reserved nothing

The backdrop is a maximized white window, and it also holds the focus: libadwaita has a focused shadow
and a backdrop one, and two windows cannot both be focused, so the only state three windows can share
is unfocused. The focused half of the claim needs a second run and is not what this measures.

Usage:
  python3 tools/benchmark-decoration.py            # Measure and print all three profiles
  python3 tools/benchmark-decoration.py --check    # Exit 1 unless both decorated windows match the
                                                   # reference within the tolerance below
  python3 tools/benchmark-decoration.py --keep     # Leave the windows up afterwards, to look at
"""

import sys
import os
import re
import json
import time
import subprocess
import argparse
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_DIR = "/tmp/window-nativizer-dev"
PID_FILE = os.path.join(STATE_DIR, "shell.pid")
SHOT_PATH = os.path.join(STATE_DIR, "shot_benchmark.png")

# The standard is what this measurement supports, in gray levels, and not a number carried over from
# the tool it replaced - that one compared against a stored profile and needed a tolerance wide enough
# to absorb two measurements' worth of rounding, which is not what this compares.
#
# Measured here: on one frame the two decorations are identical, both on the bare path and on the
# taken-over one, so the same-frame standard is zero.
#
# The focused reading is one level wide, and it is one level for a reason rather than by observation:
# libadwaita paints the shadow into the window's own buffer, while this extension bakes it into a
# texture first and slices that, so the same curve - the bake runs the GLSL generated from GTK4's own
# gskgpuboxshadow.glsl - passes through one more 8-bit quantisation. It shows on the focused set,
# whose three layers accumulate to about 0.30 near the edge, and not on the backdrop set, whose
# largest layer is transparent; and it is not a fade that had not settled, because that would lighten
# the whole curve instead of moving one step up and two steps down, and because reading the same
# window focused twice gives the same profile (see the focused witness).
SAME_FRAME_TOLERANCE = 0
ALTERNATING_FRAME_TOLERANCE = 1
# The witness is a control, not a claim: the same window in the same state, read from two frames. Any
# difference at all means the two frames are not describing the same machine, and every alternating
# comparison built on them is void.
WITNESS_TOLERANCE = 0

# Where the three subjects sit, in logical px. 400 wide and 80 apart, so that neither the shadows
# (which reach ~28px) nor the windows themselves touch a neighbour's.
SUBJECT_WIDTH = 400
SUBJECT_HEIGHT = 300
SUBJECT_Y = 320
SUBJECT_X = {"native": 80, "declared": 560, "bare": 1040}

PROFILE_ROWS = 18


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


def launch(env, name, extra_env, size=(SUBJECT_WIDTH, SUBJECT_HEIGHT)):
    """One window, with its own application id so several can run at once."""
    command = [os.path.join(ROOT, "tools", "dev.sh"), "app", "env",
               f"WINDOW_NATIVIZER_APP_ID=dev.windownativizer.{name}",
               f"WINDOW_NATIVIZER_SIZE={size[0]}x{size[1]}"]
    command += extra_env + ["gjs", os.path.join(ROOT, "tools", "probe-window.js")]
    subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


FOCUS_HOLDER = {"x": 20, "y": 20, "width": 120, "height": 80}


def place_subjects(env):
    """Puts the subjects where the layout says, leaves the focus on the holder, and reports where each
    subject's frame rect ended up - that rectangle is what the profiles are anchored to.

    The backdrop cannot hold the focus: activating a window raises it, and a raised backdrop is in
    front of the windows whose shadows it is supposed to be behind. A small window in a corner takes
    the focus instead - above the backdrop, and too far from the subjects to be in any profile.
    """
    entries = [{"name": name, "x": SUBJECT_X[name], "y": SUBJECT_Y,
                "width": SUBJECT_WIDTH, "height": SUBJECT_HEIGHT}
               for name in SUBJECT_X]
    entries.append({**FOCUS_HOLDER, "name": "focus"})
    placement = ", ".join(
        '{{id: "dev.windownativizer.{name}", x: {x}, y: {y}, w: {width}, h: {height}}}'.format(**e)
        for e in entries
    )
    js = f"""
    (() => {{
        const layout = [{placement}];
        const windows = global.get_window_actors().map(a => a.meta_window).filter(Boolean);
        const byId = id => windows.find(x => (x.get_gtk_application_id?.() ?? "") === id);
        for (const entry of layout) {{
            const w = byId(entry.id);
            if (w)
                w.move_resize_frame(false, entry.x, entry.y, entry.w, entry.h);
        }}
        const holder = byId("dev.windownativizer.focus");
        if (holder)
            holder.activate(global.get_current_time());
        const rects = {{}};
        for (const name of ["native", "declared", "bare"]) {{
            const w = byId("dev.windownativizer." + name);
            if (w) {{
                const f = w.get_frame_rect();
                rects[name] = {{ x: f.x, y: f.y, width: f.width, height: f.height,
                                 scale: global.display.get_monitor_scale(w.get_monitor()) }};
            }}
        }}
        return JSON.stringify(rects);
    }})()
    """
    return eval_js(js, env)


def wait_for_decoration(env):
    """Our two subjects have to be decorated before the frame means anything.

    Counted by application id, not by a total: the focus holder is a small bare window too, and the
    extension decorates it as well.
    """
    js = """
    (() => {
        const ours = ["dev.windownativizer.declared", "dev.windownativizer.bare"];
        const shadows = global.window_group.get_children()
            .filter(c => c.name === "WindowNativizerShadowActor")
            .map(c => c._windowActor?.meta_window)
            .filter(Boolean);
        const decorated = shadows.filter(w => ours.includes(w.get_gtk_application_id?.() ?? ""));
        return JSON.stringify({ decorated: decorated.length });
    })()
    """
    count = None
    for _ in range(40):
        # The reply is a GVariant string with its own quotes escaped, so the number is read out of it
        # rather than matched against JSON text.
        match = re.search(r"decorated[\\\"':]+\s*(\d+)", eval_js(js, env))
        count = int(match.group(1)) if match else None
        if count == 2:
            return True
        time.sleep(0.25)
    raise RuntimeError(f"expected both subjects decorated, the shell reports {count} of 2")


def profile_from(image, rect, side):
    """Outward from one edge of the frame rect, into whatever the shadow falls on.

    The origin is the compositor's `frame_rect` - the window's visible rectangle - which is the same
    definition for a client that paints its own shadow inside its buffer and for one that has none.
    Trying to find it in the pixels instead lands on whatever each client happens to paint.
    """
    px = image.load()
    width, height = image.size
    scale = rect["scale"]
    left = round(rect["x"] * scale)
    top = round(rect["y"] * scale)
    right = round((rect["x"] + rect["width"] - 1) * scale)
    bottom = round((rect["y"] + rect["height"] - 1) * scale)
    mid_x = (left + right) // 2
    mid_y = (top + bottom) // 2

    values = []
    for offset in range(PROFILE_ROWS):
        if side == "top":
            x, y = mid_x, top - offset
        elif side == "bottom":
            x, y = mid_x, bottom + offset
        elif side == "left":
            x, y = left - offset, mid_y
        else:
            x, y = right + offset, mid_y
        values.append(px[x, y][1] if 0 <= x < width and 0 <= y < height else 255)
    return values


SIDES = ("top", "bottom", "left", "right")
# The frames, and which subject each one focuses: one frame cannot hold two focused windows, so the
# focused half of the claim is measured by alternating which window has the focus. `D` repeats `B`, so
# the same window can be read focused twice and the difference between them is what says whether a
# focused reading is a fact about the decoration or about the frame it was taken in.
FRAMES = (("A", "native"), ("B", "declared"), ("C", "bare"), ("D", "declared"))
FOCUS_ORDER = ("native", "declared", "bare")


def focus_subject(env, name):
    """Focus one subject, and report every subject's frame rect in that moment."""
    js = f"""
    (() => {{
        const windows = global.get_window_actors().map(a => a.meta_window).filter(Boolean);
        const byId = id => windows.find(x => (x.get_gtk_application_id?.() ?? "") === id);
        const rects = {{}};
        for (const n of ["native", "declared", "bare"]) {{
            const w = byId("dev.windownativizer." + n);
            if (w) {{
                const f = w.get_frame_rect();
                rects[n] = {{ x: f.x, y: f.y, width: f.width, height: f.height,
                              scale: global.display.get_monitor_scale(w.get_monitor()) }};
            }}
        }}
        const target = byId("dev.windownativizer.{name}");
        if (target)
            target.activate(global.get_current_time());
        return JSON.stringify(rects);
    }})()
    """
    reply = eval_js(js, env)
    rects = json.loads(re.search(r"\{.*\}", reply.replace("\\", ""), re.S).group(0))
    if len(rects) != 3:
        raise RuntimeError(f"expected three subjects on screen, the shell reports {sorted(rects)}")
    return rects


def measure(env):
    subprocess.call(["pkill", "-9", "-f", "probe-window.js"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.5)

    launch(env, "backdrop", ["WINDOW_NATIVIZER_BACKDROP=1"])
    time.sleep(1.5)
    launch(env, "focus", [], size=(FOCUS_HOLDER["width"], FOCUS_HOLDER["height"]))
    launch(env, "native", ["WINDOW_NATIVIZER_MODE=native"])
    launch(env, "declared", ["WINDOW_NATIVIZER_DECORATED=1"])
    launch(env, "bare", [])
    time.sleep(2.0)

    print(">> Placing the subjects:", place_subjects(env).strip())
    time.sleep(1.0)
    wait_for_decoration(env)

    # One frame per focus, because a frame cannot hold two focused windows. The backdrop transition is
    # libadwaita's 200ms, so each frame is taken well after the focus has settled.
    shots = {}
    for frame, focused in FRAMES:
        rects = focus_subject(env, focused)
        time.sleep(0.8)
        path = f"{SHOT_PATH}.{frame}"
        shoot(path, env)
        image = Image.open(path).convert("RGB")
        shots[frame] = {
            subject: {side: profile_from(image, rects[subject], side) for side in SIDES}
            for subject in FOCUS_ORDER
        }
    return shots


def delta(a, b, start=1):
    """Worst difference over one profile, from `start` on: offset 0 is the boundary pixel, which is the
    client's own content rather than the cast."""
    return max(abs(x - y) for x, y in zip(a[start:], b[start:]))


def worst_delta(shots, frame, subject, reference_frame, reference):
    return max(delta(shots[frame][subject][side], shots[reference_frame][reference][side]) for side in SIDES)


# state, subject, the frame it is read from, the reference, the frame the reference is read from, and
# the standard that comparison is held to.
COMPARISONS = (
    ("unfocused (same frame)", "bare", "B", "native", "B", SAME_FRAME_TOLERANCE),
    ("unfocused (same frame)", "declared", "C", "native", "C", SAME_FRAME_TOLERANCE),
    ("focused (alternating frames)", "declared", "B", "native", "A", ALTERNATING_FRAME_TOLERANCE),
    ("focused (alternating frames)", "bare", "C", "native", "A", ALTERNATING_FRAME_TOLERANCE),
)


def main():
    parser = argparse.ArgumentParser(description="Window Nativizer decoration benchmark")
    parser.add_argument("--check", action="store_true",
                        help="Exit 1 unless both decorated windows match the live libadwaita one, "
                             "focused and unfocused")
    parser.add_argument("--keep", action="store_true", help="Leave the windows up, to look at")
    args = parser.parse_args()

    env = ensure_session()
    try:
        print(">> Measuring three windows, one frame per focus state...")
        shots = measure(env)

        print()
        print("=" * 84)
        print("        WINDOW NATIVIZER DECORATION BENCHMARK (alternating focus, shared backdrop)")
        print("=" * 84)
        for frame, focused in FRAMES:
            states = ", ".join(f"{s} {'focused' if s == focused else 'backdrop'}" for s in FOCUS_ORDER)
            print(f"frame {frame} focused on {focused:<9} {states}")
        print("-" * 84)

        for state, subject, frame, reference, reference_frame, tolerance in COMPARISONS:
            worst = worst_delta(shots, frame, subject, reference_frame, reference)
            print(f"{state:<28} {subject:<9} vs native: {worst} gray level(s), standard {tolerance}")
            # Where the difference sits, so a number that is not zero can be explained rather than
            # tolerated: the top side of each reading, with the reference's.
            print(f"  top reference {shots[reference_frame][reference]['top']}")
            print(f"  top {subject:<9} {shots[frame][subject]['top']}")
            print(f"  top delta     {[a - b for a, b in zip(shots[frame][subject]['top'], shots[reference_frame][reference]['top'])]}")
        print("-" * 84)

        # Same window, same state, two frames: if the machine moved between them, this is where it
        # shows - and it needs no stored profile to say so.
        witnesses = [
            ("native unfocused", "native", "B", "native", "C"),
            ("declared unfocused", "declared", "A", "declared", "C"),
            ("bare unfocused", "bare", "A", "bare", "B"),
            ("declared focused", "declared", "B", "declared", "D"),
        ]
        for label, subject, frame_a, _, frame_b in witnesses:
            worst = worst_delta(shots, frame_a, subject, frame_b, subject)
            print(f"environment witness         {label:<19} between two frames: {worst} gray level(s), "
                  f"standard {WITNESS_TOLERANCE}")
        print("-" * 84)

        failures = []
        for frame, focused in FRAMES:
            for subject in FOCUS_ORDER:
                profiles = shots[frame][subject]
                if not all(profiles[side][1:] == profiles["top"][1:] for side in ("bottom", "left", "right")):
                    failures.append(f"the {subject} window's four sides diverge in frame {frame} "
                                    f"(focused on {focused})")

        for state, subject, frame, reference, reference_frame, tolerance in COMPARISONS:
            worst = worst_delta(shots, frame, subject, reference_frame, reference)
            if worst > tolerance:
                failures.append(f"the {subject} window {state} is {worst} gray levels from libadwaita's "
                                f"(standard {tolerance})")

        witness_worst = max(worst_delta(shots, a, s, b, s) for _, s, a, _, b in witnesses)
        if witness_worst > WITNESS_TOLERANCE:
            failures.append(f"the same window reads {witness_worst} gray levels apart between two frames, "
                            f"so the machine moved and the focused comparison above means nothing")

        if args.check:
            if failures:
                print()
                for failure in failures:
                    print(f"[FAIL] {failure}")
                sys.exit(1)
            print("\n[OK] Both decorated windows wear libadwaita's decoration, focused and unfocused.")
    finally:
        if not args.keep:
            subprocess.call(["pkill", "-9", "-f", "probe-window.js"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
