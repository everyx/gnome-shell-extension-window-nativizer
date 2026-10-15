"""Shared screenshot-pixel primitives for the decoration harness.

One home for the pixel reading that benchmark-decoration.py and the test-e2e.sh
rendering checks each carried on their own: extracting the geometry JSON from a
shell Eval reply, loading screenshots, and sampling axis-aligned runs, corner
rays, luma and bilinear reads - plus the frame-rect-anchored G-channel profiles
(profile_from / body_from / corner_from) the bench measures against libadwaita.

Thresholds and budgets stay with the callers; this module only moves values.
A profile that reads clean here reads byte-identical to the inline code it
replaces - the callers' gates decide what the numbers mean.
"""

import json
import math
import re

from PIL import Image

# How far outward from the frame edge a straight-edge cast is read, and how far
# inward the body is read. From benchmark-decoration.py, unchanged.
PROFILE_ROWS = 18
INWARD_ROWS = 4

# The corner arc all three subjects draw (ADWAITA_STYLE.window.radius, logical px).
CORNER_RADIUS = 15
CORNERS = ("tl", "tr", "bl", "br")
# Screen coordinates, y downward: each apex points *away* from the window interior.
CORNER_APEX = {"tl": 225.0, "tr": 315.0, "bl": 135.0, "br": 45.0}
CORNER_RAYS = (0.0, 22.5, -22.5)


def parse_reply(reply):
    """The geometry JSON inside a shell Eval reply.

    GVariant prints the reply string with its quotes backslash-escaped (twice,
    through the Eval wrapper); strip backslashes before reading the JSON object.
    Raises ValueError when there is no object - the caller maps that to its own
    diagnostic, so every check keeps reporting in its own words.
    """
    match = re.search(r"\{.*\}", reply.replace("\\", ""), re.S)
    if not match:
        raise ValueError(f"no JSON object in reply: {reply!r}")
    return json.loads(match.group(0))


def load_rgb(path):
    """A screenshot as RGB pixels."""
    return Image.open(path).convert("RGB")


def run_samples(im, x0, y, x1, channel=0):
    """One channel along an axis-aligned run [x0, x1) at row y."""
    px = im.load()
    width, height = im.size
    return [px[x, y][channel] for x in range(x0, x1) if 0 <= x < width and 0 <= y < height]


def ray_samples(im, cx, cy, ux, uy, d_start, d_end, channel=0, box=0):
    """One channel along a ray from (cx, cy) over integer distances [d_start, d_end).

    box=0 reads the rounded pixel (out-of-bounds distances are skipped);
    box=1 reads the darkest pixel of the 3x3 block around it, which absorbs the
    sub-pixel phase a 45-degree ray rounds differently at every corner.
    """
    px = im.load()
    width, height = im.size
    out = []
    for d in range(d_start, d_end):
        x = int(round(cx + ux * d))
        y = int(round(cy + uy * d))
        if box <= 0:
            if 0 <= x < width and 0 <= y < height:
                out.append(px[x, y][channel])
        else:
            samples = [px[x + dx, y + dy][channel]
                       for dx in (-1, 0, 1) for dy in (-1, 0, 1)
                       if 0 <= x + dx < width and 0 <= y + dy < height]
            if samples:
                out.append(min(samples))
    return out


def luma(pixel):
    """Mean of R, G, B - the contour coordinate for preview-vs-desktop comparisons."""
    return (pixel[0] + pixel[1] + pixel[2]) / 3.0


def bilinear(im, x, y):
    """Luma at fractional screenshot coordinates, for sub-texel contours."""
    x0, y0 = int(x), int(y)
    fx, fy = x - x0, y - y0
    x1, y1 = min(x0 + 1, im.width - 1), min(y0 + 1, im.height - 1)
    return (luma(im.getpixel((x0, y0))) * (1 - fx) * (1 - fy)
            + luma(im.getpixel((x1, y0))) * fx * (1 - fy)
            + luma(im.getpixel((x0, y1))) * (1 - fx) * fy
            + luma(im.getpixel((x1, y1))) * fx * fy)


def alpha_over(foreground, background, alpha):
    """One 8-bit channel of a foreground layer over a background at the given alpha."""
    return round(foreground * alpha + background * (1 - alpha))


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
    """Worst straight-edge shape difference of one subject against a reference frame."""
    return max(delta(shape(shots[frame][subject][side]), shape(shots[reference_frame][reference][side]))
               for side in ("top", "bottom", "left", "right"))


def corner_keys():
    """One key per (corner, ray) reading - the three rays of one corner are three readings."""
    return [f"{corner}@{ray:+.1f}" for corner in CORNERS
            for ray in CORNER_RAYS]


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
