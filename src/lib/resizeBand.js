/**
 * Resize band geometry: the strip around a window where a drag starts a compositor
 * resize grab. Pure, so the eight rectangles can be tested without a session; the
 * model (why 12px, what it costs) is in docs/decoration-model.md § The resize band.
 */

/** GTK4 floors its resize handle at 12 logical px (`RESIZE_HANDLE_SIZE`, gtkwindow.c). */
export const RESIZE_BAND = 12;

/**
 * Thinnest window that gets a band. Below 2×12 the corner regions would meet, which is
 * the degenerate helper surface case (wl-clipboard's 1×1 toplevel), not a window.
 */
export const MIN_BAND_WINDOW = 2 * RESIZE_BAND;

/** Regions, clockwise from the top edge. The order only fixes iteration, not geometry. */
export const RESIZE_BAND_REGIONS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

/**
 * @typedef {{x: number, y: number, width: number, height: number}} Rect
 */

/**
 * @param {Rect|null} rect
 * @param {Rect|null} bounds
 * @returns {Rect|null} Intersection, or null when it is empty
 */
function clipToBounds(rect, bounds) {
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
 * The eight regions tiling `frame` grown by `RESIZE_BAND` on every side, each clipped
 * to `bounds`. Edges run the length of the frame side, corners take the 12×12 diagonal
 * squares, so the four edges and four corners never overlap and never leave a gap.
 *
 * Units: logical pixels on every scale. `frame_rect` and the actor tree are both in
 * stage (logical) units, and GTK's 12 is logical too (`RESIZE_HANDLE_SIZE`), so the
 * monitor scale cancels out and is deliberately not a multiplier. It is still required
 * to be positive — a caller that cannot say which space it measured in gets no band
 * rather than one that silently means something else.
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
    const {x, y, width, height} = frame;
    const rects = {
        n: {x, y: y - b, width, height: b},
        ne: {x: x + width, y: y - b, width: b, height: b},
        e: {x: x + width, y, width: b, height},
        se: {x: x + width, y: y + height, width: b, height: b},
        s: {x, y: y + height, width, height: b},
        sw: {x: x - b, y: y + height, width: b, height: b},
        w: {x: x - b, y, width: b, height},
        nw: {x: x - b, y: y - b, width: b, height: b},
    };

    for (const region of RESIZE_BAND_REGIONS)
        bands[region] = clipToBounds(rects[region], bounds);

    return bands;
}
