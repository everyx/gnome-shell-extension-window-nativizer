/**
 * Resize band geometry: the strip around a window where a drag starts a compositor
 * resize grab. Pure, so the twelve rectangles can be tested without a session; the
 * model (why 12px, and why a corner reaches 24px along an edge but only 12px outward)
 * is in docs/decoration-model.md § The resize band.
 */

/** GTK4 floors its resize handle at 12 logical px (`RESIZE_HANDLE_SIZE`, gtkwindow.c). */
export const RESIZE_BAND = 12;

/** GTK's corner reach, `RESIZE_HANDLE_CORNER_SIZE` (gtkwindow.c); see the regions below. */
export const RESIZE_CORNER = 24;

/** Thinnest window that gets a band; below it is a helper surface (wl-clipboard's 1×1), not a window. */
export const MIN_BAND_WINDOW = 2 * RESIZE_BAND;

/**
 * Regions, clockwise from the top edge. The four edges are named for their direction;
 * each corner contributes two regions named `<corner>_<edge>`, the part of that edge's
 * band the corner takes over (a corner reaches 24px along the edge from the frame
 * corner). The order only fixes iteration, not geometry.
 */
export const RESIZE_BAND_REGIONS = [
    'n', 'ne_n', 'ne_e', 'e', 'se_e', 'se_s',
    's', 'sw_s', 'sw_w', 'w', 'nw_w', 'nw_n',
];

/**
 * The compass direction each region resolves to. A corner's two halves share one
 * direction, so they share one cursor and one grab op and the eight-way mapping never
 * degrades to a straight edge. Keys are the eight directions `Meta.GrabOp` understands.
 */
export const REGION_DIRECTION = {
    n: 'n',
    ne_n: 'ne', ne_e: 'ne',
    e: 'e',
    se_e: 'se', se_s: 'se',
    s: 's',
    sw_s: 'sw', sw_w: 'sw',
    w: 'w',
    nw_w: 'nw', nw_n: 'nw',
};

/**
 * @typedef {{x: number, y: number, width: number, height: number}} Rect
 */

/**
 * @param {Rect|null} rect
 * @param {Rect|null} bounds
 * @returns {Rect|null} Intersection, or null when it is empty
 */
function clipToBounds(rect, bounds) {
    if (!(rect.width > 0) || !(rect.height > 0))
        return null;
    if (!bounds)
        return rect;

    const x1 = Math.max(rect.x, bounds.x);
    const y1 = Math.max(rect.y, bounds.y);
    const x2 = Math.min(rect.x + rect.width, bounds.x + bounds.width);
    const y2 = Math.min(rect.y + rect.height, bounds.y + bounds.height);
    if (!(x2 > x1) || !(y2 > y1))
        return null;

    return {x: x1, y: y1, width: x2 - x1, height: y2 - y1};
}

/**
 * @returns {Record<string, Rect|null>} Every region present, all null
 */
function emptyBands() {
    const bands = {};
    for (const region of RESIZE_BAND_REGIONS)
        bands[region] = null;
    return bands;
}

/**
 * The twelve regions tiling `frame` grown by `RESIZE_BAND`, each clipped to `bounds`.
 *
 * GTK decides a corner by proximity alone: a pointer inside an edge's band is the corner
 * whenever the other axis is within `RESIZE_HANDLE_CORNER_SIZE` of the frame's edge
 * (`get_edge_for_coordinates`, gtkwindow.c, where the comment on the constant reads "How
 * resize corners extend"). So a corner owns 24px of each edge next to it, not just the
 * 24×24 square outside the frame. We cannot spend that reach inward - inside the frame the
 * surface is the client's - so each corner is two regions: `<corner>_<edge>` for the edge
 * band it takes over (24px along the edge), which merges with the corner's outward 24×24
 * quadrant, and the region on the other edge (24px along, 12px outward, the band's depth).
 * The eight regions are therefore split into twelve that are pairwise disjoint, so a point
 * has at most one direction.
 *
 * Units are logical px on every scale. `frame` and the actor tree are both logical, and
 * GTK's 12/24 are logical too, so the monitor scale cancels and is never a multiplier —
 * but it must be positive, so a caller that cannot say which space it measured in gets no
 * band rather than one that silently means something else.
 *
 * @param {object} params
 * @param {Rect} params.frame - Window body (`frame_rect`), logical px
 * @param {Rect|null} [params.bounds=null] - Clip rect (`get_monitor_geometry`), logical px
 * @param {number} [params.scale=1] - Monitor scale the frame was read at
 * @returns {Record<string, Rect|null>} One rect per region, null where it is empty
 */
export function computeResizeBands({frame, bounds = null, scale = 1} = {}) {
    const bands = emptyBands();

    if (!Number.isFinite(scale) || scale <= 0)
        return bands;
    if (!frame || !Number.isFinite(frame.x) || !Number.isFinite(frame.y) ||
        !(frame.width > 0) || !(frame.height > 0))
        return bands;

    const b = RESIZE_BAND;
    const c = RESIZE_CORNER;
    const {x, y, width, height} = frame;
    // A corner reaches c px along an edge from the frame corner; two opposite corners
    // would meet and overlap on a side shorter than 2c, so the reach is halved there.
    // The edge that remains between them then has zero width and is dropped as empty.
    const rx = Math.min(c, width / 2);
    const ry = Math.min(c, height / 2);
    const rects = {
        n: {x: x + rx, y: y - b, width: width - 2 * rx, height: b},
        ne_n: {x: x + width - rx, y: y - c, width: rx + c, height: c},
        ne_e: {x: x + width, y, width: b, height: ry},
        e: {x: x + width, y: y + ry, width: b, height: height - 2 * ry},
        se_e: {x: x + width, y: y + height - ry, width: b, height: ry},
        se_s: {x: x + width - rx, y: y + height, width: rx + c, height: c},
        s: {x: x + rx, y: y + height, width: width - 2 * rx, height: b},
        sw_s: {x: x - c, y: y + height, width: rx + c, height: c},
        sw_w: {x: x - b, y: y + height - ry, width: b, height: ry},
        w: {x: x - b, y: y + ry, width: b, height: height - 2 * ry},
        nw_w: {x: x - b, y, width: b, height: ry},
        nw_n: {x: x - c, y: y - c, width: rx + c, height: c},
    };

    for (const region of RESIZE_BAND_REGIONS)
        bands[region] = clipToBounds(rects[region], bounds);

    return bands;
}
