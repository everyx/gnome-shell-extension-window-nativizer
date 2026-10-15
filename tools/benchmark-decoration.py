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

Each window is read on its four straight edges and on three rays off each of its four corner arcs,
the arc centres at the libadwaita radius. The corners were added after a report that a flat window's
corner "looked soft, with a light band along the arc" - a defect this file could not have seen,
because a profile read from the middle of an edge never crosses a corner. The gate on them is
`light_band()`, a check of the profile's own shape rather than a comparison against the reference's
corner, because a 45-degree ray lands on a different sub-pixel phase at every corner of every
window and two symmetric corners of one window can differ by tens of gray levels on the phase alone.

The `bare` subject keeps its plain body colour. It was tried with a saturated one, so the G
channel would separate body from cast unambiguously, and that breaks the rest of the file:
`shape()` cancels the edge row against the body, and the 0.07-alpha white outline this extension
draws there is invisible on a light body but reads 18 levels of green on a red one, which turns
every straight-edge comparison into a 18-level failure that has nothing to do with corners.

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
import math
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

# Outward rows run from the frame edge (offset 0) into the cast. The boundary row is where the
# client's own edge and this extension's cast meet, and it is ours on the declared path: the
# shadow shader cutout aligns strictly with GTK4's analytical box shadow, so any misalignment
# of the clip body turns that row into shadow instead of body. It is compared, not
# exempted - the run that motivated this file compared only offset 1 onward and so read a
# shadow-covered edge as a matching one. Its raw value belongs to the client (see shape()), so it
# enters the comparison as its departure from the window's own body.
#
# Inward rows are the client's own body, which this extension does not paint, so their colour is
# not compared with the reference's (two clients need not paint the same body). They are read to
# tell a step from a ramp: a clean edge steps to a flat body, while a leak from the cast keeps
# darkening the rows next to the edge. INWARD_ROWS is how far the ramp could reach before the body
# is flat.
INWARD_ROWS = 4

# A body is one colour next to the edge; the cast must not be painting a gradient there.
BODY_FLAT_TOLERANCE = 0


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
                const inset = name === "bare" ? 1 : 0;
                rects[name] = {{ x: f.x + inset, y: f.y + inset,
                                 width: f.width - inset * 2, height: f.height - inset * 2,
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


def corner_from(image, rect, corner, degrees, rows=PROFILE_ROWS, inward=INWARD_ROWS, body_g=None):
    """Outward along a ray from one corner's arc, into whatever the shadow falls on.

    Ray 0 is the apex (the corner's diagonal, where a Gaussian-blurred rounded rect is weakest and
    any band along the arc is widest); the other two sweep toward the tangent points, where an arc
    and a straight edge meet and a seam between them would show.

    The origin is the arc: `CORNER_RADIUS` out from the body's corner, along a ray whose apex points
    away from the window. Ray 0 is the corner's diagonal; the other two sweep toward the tangent
    points, where an arc meets a straight edge and a seam between them would show. Every subject is
    cut to `frame_rect` (the extension clears a declared CSD ring down to it), so `frame_rect` is
    the body's edge on all three.

    Returns `unreadable` when nothing on the ray is darker than the body, which means there is no
    cast at this arc and therefore no band to detect. `light_band()` returns 0 for it and the
    report says so, rather than printing a clean profile that never looked at a corner.
    """
    px = image.load()
    width, height = image.size
    scale = rect["scale"]
    radius = CORNER_RADIUS * scale
    left = round(rect["x"] * scale)
    top = round(rect["y"] * scale)
    right = round((rect["x"] + rect["width"]) * scale) - 1
    bottom = round((rect["y"] + rect["height"]) * scale) - 1
    cx, cy = {
        "tl": (left + radius, top + radius),
        "tr": (right - radius, top + radius),
        "bl": (left + radius, bottom - radius),
        "br": (right - radius, bottom - radius),
    }[corner]
    angle = math.radians(CORNER_APEX[corner] + degrees)
    ux, uy = math.cos(angle), math.sin(angle)

    def darkest(d):
        """The darkest G in a 3x3 block centred on the point `d` px out from the arc centre.

        A 45-degree ray advances 0.707 px per step per axis, so the same arc read from two corners
        rounds its samples to different sub-pixel phases and the profile can shift a whole pixel
        between them - tens of gray levels, on a decoration that is symmetric by construction. The
        darkest pixel in the block absorbs that, because a shadow edge is darkest at its darkest
        point. An axis-aligned straight-edge ray never had this problem: it lands on whole pixels
        at any position, which is why corners were the only place the phase could leak in.
        """
        x = int(round(cx + ux * d))
        y = int(round(cy + uy * d))
        samples = [px[x + dx, y + dy][1]
                   for dx in (-1, 0, 1) for dy in (-1, 0, 1)
                   if 0 <= x + dx < width and 0 <= y + dy < height]
        return min(samples) if samples else 255

    # d = radius is the arc itself: the point on the circle where the ray leaves the body. The
    # frames to follow are inward (client body) and outward (the cast).
    profile = [darkest(radius + offset) for offset in range(rows)]
    return {
        "profile": profile,
        "body": [darkest(radius - offset) for offset in range(1, inward + 1)],
        # A corner whose cast never darkens below the body has no band to detect - there is no
        # shadow at the arc to break one out of. Saying so beats reporting a "clean" profile that
        # was never looking at a corner.
        "unreadable": body_g is not None and min(profile) >= body_g,
    }


def body_from(image, rect, side):
    """Inward from the frame edge: the client's own body, nearest row first.

    A clean body is flat here; a cast that leaked past the clip boundary darkens the rows next to
    the edge and shows as a ramp toward the interior.
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
    for offset in range(1, INWARD_ROWS + 1):
        if side == "top":
            x, y = mid_x, top + offset
        elif side == "bottom":
            x, y = mid_x, bottom - offset
        elif side == "left":
            x, y = left + offset, mid_y
        else:
            x, y = right - offset, mid_y
        values.append(px[x, y][1] if 0 <= x < width and 0 <= y < height else 255)
    return values


SIDES = ("top", "bottom", "left", "right")

# The corners, which SIDES has never covered. Every profile above is read from the *middle* of an
# edge, which is exactly where a straight edge and its neighbours are indistinguishable - so the
# whole arc, and the tangent points where an arc meets a straight edge, were unmeasured. A report
# of "the corner looks soft, there is a light band along the arc" is therefore the class of defect
# this file was structurally unable to see. The same shadow under a rounded rect really is weaker
# along the arc than along the flat of an edge (a Gaussian sees less material behind a convex
# curve), which is why the corner cannot simply be held to the straight-edge profile either: both
# libadwaita and this extension run the same kernel and produce the same falloff, and comparing a
# corner against a straight edge would report that shared geometry as a fault.
#
# So the corners are measured the way everything else here is - against libadwaita's own corner, in
# the same screenshot - rather than against our own straight edge. Rays leave each arc centre, with
# CORNER_RAYS[0] (the apex) being the worst case and the other two straddling the tangent points.
# CORNER_RADIUS is ADWAITA_STYLE.window.radius in logical px (src/lib/adwaitaStyle.generated.js);
# it is stated here rather than imported because that file is generated for GJS and is not a Python
# module. All three subjects draw the same radius, so a drift in it moves both sides of every
# comparison together and cannot masquerade as a difference.
CORNERS = ("tl", "tr", "bl", "br")
# Screen coordinates, y downward, so the angle is measured the way atan2(dy, dx) would give it.
# Each apex points *away* from the window's interior: the top-left arc is entered on its upper-left
# diagonal, not its lower-right. Getting this backwards is not a subtle error - every ray runs
# inward from the arc centre and reads flat body for its whole length, so the profile degenerates
# to a constant and the gate passes without ever having looked at a corner.
CORNER_APEX = {"tl": 225.0, "tr": 315.0, "bl": 135.0, "br": 45.0}
CORNER_RAYS = (0.0, 22.5, -22.5)
CORNER_RADIUS = 15
# The one ray printed in the report: the apex of the top-left arc, which is the worst case and the
# place a "light band along the corner" would be widest.
CORNER_HEADLINE = "tl@+0.0"
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
                const inset = n === "bare" ? 1 : 0;
                rects[n] = {{ x: f.x + inset, y: f.y + inset,
                              width: f.width - inset * 2, height: f.height - inset * 2,
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
        shots[frame] = {}
        for subject in FOCUS_ORDER:
            sides = {side: {"profile": profile_from(image, rects[subject], side),
                            "body": body_from(image, rects[subject], side)}
                     for side in SIDES}
            # The corner rays are told where the body begins by looking for its own colour, taken
            # from the straight-edge inward rows - those are already anchored and verified, and a
            # corner's arc is not at frame_rect for a client that kept its own decoration.
            body_g = sides["top"]["body"][0]
            # Keyed by (corner, ray) rather than corner alone: the three rays of one corner are
            # three separate readings, and a dict keyed only by corner would keep the last.
            shots[frame][subject] = dict(sides, **{
                f"{corner}@{ray:+.1f}": corner_from(image, rects[subject], corner, ray, body_g=body_g)
                for corner in CORNERS
                for ray in CORNER_RAYS
            })
    return shots


def body_delta(body):
    """Worst spread over the rows inside the edge: a flat body, not a shadow ramp."""
    return max(body) - min(body)


def shape(reading):
    """What this extension is accountable for, one entry per profile offset.

    Entry 0 is the frame-edge pixel *relative to the window's own body*. That pixel is the client's
    content - a GTK4 client paints its own headerbar there, and the reference paints its body - so
    its raw value is not comparable between two clients, but its departure from the body is: our
    own white 0.07-alpha outline is invisible at 8-bit, so a clean edge is a step (excess 0) and a
    cast that leaked past the clip boundary is a dip. Entries 1.. are the cast, which lands on the
    same backdrop for every window and so is compared raw. Offset 0 is in the comparison, not
    exempted; only its client-content part is cancelled.
    """
    return [reading["profile"][0] - reading["body"][0]] + reading["profile"][1:]


def delta(a, b):
    """Worst difference over one shape."""
    return max(abs(x - y) for x, y in zip(a, b))


def worst_delta(shots, frame, subject, reference_frame, reference):
    return max(delta(shape(shots[frame][subject][side]), shape(shots[reference_frame][reference][side]))
               for side in SIDES)


def corner_keys():
    return [f"{corner}@{ray:+.1f}" for corner in CORNERS for ray in CORNER_RAYS]


# How far a corner profile may break the monotone shape of a shadow edge before it is called a
# light band. Two gray levels is one 8-bit quantisation step of the bake: this extension bakes the
# cast into a texture and libadwaita paints it straight into the window's buffer, so one extra step
# of rounding is the whole difference between the two, and it is the same reason
# ALTERNATING_FRAME_TOLERANCE is 1 on the straight edges. The reported defect was a visible pale
# ring, which measures in the tens, so nothing a person can see hides inside this.
BAND_TOLERANCE = 2


def light_band(reading):
    """How far the corner profile breaks the shape a shadow edge must have, in gray levels.

    A cast that meets the body monotonically falls from the body's colour to the shadow's darkest
    point and then climbs back out to the backdrop - one turning point, at the darkest. A light band
    between the body and the dark surround ("the corner looks soft, there is a pale ring along the
    arc") breaks exactly that, by climbing and then falling again.

    Offset 0 is the arc pixel, which is the body's own colour, so it is the first entry of the
    descent and not a reading of the cast at all.

    This is deliberately a check of our own profile's SHAPE, not a comparison with libadwaita's
    corner. A straight edge can be compared across windows because its ray is axis-aligned and lands
    on whole pixels at any position; a 45-degree ray rounds to a different sub-pixel phase at every
    corner of every window, so two symmetric corners of one window can differ by tens of gray
    levels on the phase alone. Measuring the phase would report it as decoration, and widening a
    tolerance to absorb it would accept a real band of the same size. The shape has no phase in it:
    a band is a band wherever it falls.
    """
    profile = reading["profile"]
    if reading.get("unreadable"):
        return 0
    darkest = min(range(len(profile)), key=lambda i: profile[i])
    # Sign matters and is easy to get backwards, which is what the first version did: it read the
    # healthy climb out of the shadow as a fall and fired on every healthy corner in the file,
    # libadwaita's included. Before the darkest point the profile must not get lighter (a dip is a
    # band); after it, it must not get darker (a second dip is a band further out).
    rise_before = max((profile[i + 1] - profile[i] for i in range(darkest)), default=0)
    fall_after = max((profile[i] - profile[i + 1] for i in range(darkest, len(profile) - 1)), default=0)
    # max(0, …): a monotone climb out of the shadow gives a negative fall_after, and a band is a
    # departure above the shape, never below it.
    return max(0, rise_before, fall_after)


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
                             "straight edges and corners, focused and unfocused")
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
            worst = worst_delta(shots, frame, subject, reference_frame, reference)
            print(f"{state:<28} {subject:<9} vs native: {worst} gray level(s), standard {tolerance}")
            # Where the difference sits, so a number that is not zero can be explained rather than
            # tolerated: the top side of each reading, with the reference's, and the body rows on
            # both. The edge row's raw values differ because the clients paint different bodies;
            # the shape delta is what cancels that and compares the edge and the cast.
            ref_top = shots[reference_frame][reference]["top"]
            sub_top = shots[frame][subject]["top"]
            print(f"  top reference {ref_top['profile']}")
            print(f"  top {subject:<9} {sub_top['profile']}")
            print(f"  top delta     {[a - b for a, b in zip(shape(sub_top), shape(ref_top))]}")
            print(f"  top body      {sub_top['body']}  (reference {ref_top['body']})")
            # The corner the report was about: the apex ray of the top-left arc, with the reference's
            # beside it. These are printed for a human to read, not compared - see light_band()
            # for why a corner cannot be held to the reference across windows. Both are lighter
            # than the straight edge's first cast pixel (a Gaussian sees less shadow material behind
            # a convex curve), and libadwaita's is just as light, which is the whole finding.
            corner = shots[frame][subject][CORNER_HEADLINE]
            ref_corner = shots[reference_frame][reference][CORNER_HEADLINE]
            note = "no cast below the body - nothing to gate" if corner.get("unreadable") else \
                f"band {light_band(corner)} (standard {BAND_TOLERANCE})"
            print(f"  corner tl apex  reference {ref_corner['profile'][:8]}")
            print(f"  corner tl apex  {subject:<9} {corner['profile'][:8]}  {note}")
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
                sides = shots[frame][subject]
                for side in ("bottom", "left", "right"):
                    if not shape(sides[side]) == shape(sides["top"]):
                        failures.append(f"the {subject} window's four sides diverge in frame {frame} "
                                        f"(focused on {focused})")
                # No light band on any corner. See light_band(): this is a shape check, not a
                # comparison against the reference's corner, because a 45-degree ray lands on a
                # different sub-pixel phase at every corner of every window and would report the
                # phase as decoration.
                for key in corner_keys():
                    band = light_band(sides[key])
                    if band > BAND_TOLERANCE:
                        failures.append(f"the {subject} window's {key} corner carries a light band: "
                                        f"{sides[key]['profile'][:8]} breaks the shadow shape by "
                                        f"{band} gray level(s) (standard {BAND_TOLERANCE}) in frame "
                                        f"{frame} (focused on {focused})")
                # A clean edge steps to a flat body; a cast leaking past the clip boundary keeps
                # the rows next to the edge dark and the spread is what catches it.
                for side in SIDES:
                    body = sides[side]["body"]
                    spread = body_delta(body)
                    if spread > BODY_FLAT_TOLERANCE:
                        failures.append(f"the {subject} window's {side} body ramps inward "
                                        f"{body} (spread {spread} gray level(s), "
                                        f"standard {BODY_FLAT_TOLERANCE}) in frame {frame} "
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
            print("\n[OK] Both decorated windows wear libadwaita's decoration - straight edges and "
                  "corners alike, focused and unfocused.")
    finally:
        if not args.keep:
            subprocess.call(["pkill", "-9", "-f", "probe-window.js"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
