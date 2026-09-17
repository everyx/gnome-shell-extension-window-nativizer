/**
 * Resize band geometry: the strip around a window where a drag starts a compositor
 * resize grab. Two separate things live here. `edgeForPoint()` answers which direction a
 * pointer resolves to, and it is a direct transcription of GTK's
 * `get_edge_for_coordinates()` (`vendor/gtk/gtkwindow.c`), first match wins.
 * `computeResizeBands()` answers where an event is delivered: four disjoint rectangles
 * that cover the ring, carrying no direction of their own. Pure, so both can be tested
 * without a session; the model is in docs/decoration-model.md § The resize band.
 */

import {RESIZE_HANDLE_SIZE, RESIZE_HANDLE_CORNER_SIZE} from './gtkRules.generated.js';

/** GTK4 floors its resize handle at 12 logical px (`RESIZE_HANDLE_SIZE`, vendor/gtk/gtkwindow.c). */
export const RESIZE_BAND = RESIZE_HANDLE_SIZE;

/** GTK's corner reach, `RESIZE_HANDLE_CORNER_SIZE` (vendor/gtk/gtkwindow.c). */
export const RESIZE_CORNER = RESIZE_HANDLE_CORNER_SIZE;

/**
 * Thinnest window that gets a band, `2 * RESIZE_BAND` (24px). This bounds the ring itself:
 * a window this thin has no middle left once the band is grown on both sides. It has no
 * native meaning, and is not a boundary GTK knows: GTK's input region is the body grown by
 * `RESIZE_HANDLE_SIZE` on every side whatever the window size is
 * (`update_realized_window_properties`, gtkwindow.c), so a native window this small or
 * smaller still has a full grab ring.
 */
export const MIN_BAND_WINDOW = 2 * RESIZE_BAND;

/**
 * The four reactive surfaces of the ring, clockwise. They are only where an event lands;
 * the direction comes from `edgeForPoint()`, never from which one was entered. The top and
 * bottom strips span the full width, so the outward corners belong to them and the left and
 * right strips fill the middle. Half-open, like Clutter's picking.
 */
export const RESIZE_BAND_REGIONS = ['top', 'right', 'bottom', 'left'];

/**
 * @typedef {{x: number, y: number, width: number, height: number}} Rect
 */

/**
 * Which of a window's four edges Mutter holds fixed: `maximized_vertically` fixes the top and
 * bottom, `maximized_horizontally` the left and right, and both together are all four. Why those
 * two flags are the whole reading, and why the frame's geometry is not, is in
 * docs/decoration-model.md § The resize band.
 * @param {object} [params={}]
 * @param {{top?: boolean, right?: boolean, bottom?: boolean, left?: boolean}|null} [params.constrainedEdges=null] - Edges already known
 * @param {boolean} [params.maximizedHorizontally=false]
 * @param {boolean} [params.maximizedVertically=false]
 * @returns {{top: boolean, right: boolean, bottom: boolean, left: boolean}}
 */
export function normalizeConstrainedEdges({
    constrainedEdges = null,
    maximizedHorizontally = false,
    maximizedVertically = false,
} = {}) {
    return {
        top: Boolean(constrainedEdges?.top || maximizedVertically),
        bottom: Boolean(constrainedEdges?.bottom || maximizedVertically),
        left: Boolean(constrainedEdges?.left || maximizedHorizontally),
        right: Boolean(constrainedEdges?.right || maximizedHorizontally),
    };
}

/**
 * Maps a pointer coordinate to the resize direction GTK's own hit-test would resolve.
 *
 * Only the outward ring is ours. GTK also reads an inner 24px corner when the pointer is
 * inside the body (`gsk_rounded_rect_corner_box_contains_point`); that surface belongs to
 * the client, so a point inside the body is null here.
 *
 * A constrained edge resolves to null, and the corner regions beside it to the unconstrained straight
 * edge - the one place this extends GTK, recorded in docs/decoration-model.md § The resize band.
 * @param {Rect} frame - Window body, in the same space as `x`/`y`
 * @param {number} x
 * @param {number} y
 * @param {object} [options={}]
 * @param {{top?: boolean, right?: boolean, bottom?: boolean, left?: boolean}|null} [options.constrainedEdges=null]
 * @param {boolean} [options.maximizedHorizontally=false]
 * @param {boolean} [options.maximizedVertically=false]
 * @returns {'n'|'ne'|'e'|'se'|'s'|'sw'|'w'|'nw'|null}
 */
export function edgeForPoint(frame, x, y, {
    constrainedEdges = null,
    maximizedHorizontally = false,
    maximizedVertically = false,
} = {}) {
    if (!frame || !Number.isFinite(x) || !Number.isFinite(y) ||
        !Number.isFinite(frame.x) || !Number.isFinite(frame.y) ||
        !(frame.width > 0) || !(frame.height > 0))
        return null;

    const left = frame.x;
    const top = frame.y;
    const right = left + frame.width;
    const bottom = top + frame.height;
    const b = RESIZE_BAND;
    const c = RESIZE_CORNER;

    // The half-open 12px ring: as far as GTK's input region reaches, and no further.
    if (x < left - b || x >= right + b || y < top - b || y >= bottom + b)
        return null;

    const constrained = normalizeConstrainedEdges({
        constrainedEdges,
        maximizedHorizontally,
        maximizedVertically,
    });

    // GTK's order, and GTK's first match wins - on a narrow window the earlier band takes the
    // overlap of the two corner reaches (decoration-model.md § The resize band).
    if (x < left && x >= left - b) {
        if (constrained.left)
            return null;
        if (y < top && constrained.top)
            return null;
        if (y > bottom && constrained.bottom)
            return null;
        if (y < top + c && y >= top - b)
            return constrained.top ? 'w' : 'nw';
        if (y > bottom - c && y <= bottom + b)
            return constrained.bottom ? 'w' : 'sw';
        return 'w';
    }
    if (x > right && x <= right + b) {
        if (constrained.right)
            return null;
        if (y < top && constrained.top)
            return null;
        if (y > bottom && constrained.bottom)
            return null;
        if (y < top + c && y >= top - b)
            return constrained.top ? 'e' : 'ne';
        if (y > bottom - c && y <= bottom + b)
            return constrained.bottom ? 'e' : 'se';
        return 'e';
    }
    if (y < top && y >= top - b) {
        if (constrained.top)
            return null;
        if (x < left && constrained.left)
            return null;
        if (x > right && constrained.right)
            return null;
        if (x < left + c && x >= left - b)
            return constrained.left ? 'n' : 'nw';
        if (x > right - c && x <= right + b)
            return constrained.right ? 'n' : 'ne';
        return 'n';
    }
    if (y > bottom && y <= bottom + b) {
        if (constrained.bottom)
            return null;
        if (x < left && constrained.left)
            return null;
        if (x > right && constrained.right)
            return null;
        if (x < left + c && x >= left - b)
            return constrained.left ? 's' : 'sw';
        if (x > right - c && x <= right + b)
            return constrained.right ? 's' : 'se';
        return 's';
    }
    return null;
}

/**
 * @param {Rect|null} rect
 * @param {Rect|null} bounds
 * @returns {Rect|null} Intersection, or null when it is empty
 */
function clipToBounds(rect, bounds) {
    if (!rect || !(rect.width > 0) || !(rect.height > 0))
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
 * @returns {Record<string, Rect|null>} Every surface present, all null
 */
function emptyBands() {
    const bands = {};
    for (const region of RESIZE_BAND_REGIONS)
        bands[region] = null;
    return bands;
}

/**
 * The four rectangles tiling `frame`'s `RESIZE_BAND`-wide outer ring, each clipped to
 * `bounds`. The direction a point resolves to is `edgeForPoint()`; these rectangles only
 * decide where an event is delivered atomically. They are disjoint and cover the ring
 * exactly (half-open, the convention Clutter picks with), so no point is missed or
 * delivered twice.
 *
 * Units are logical px at every scale; a non-positive or non-finite `scale` gets no band,
 * so a caller that cannot say which space it measured in is never silently misread.
 * @param {object} params
 * @param {Rect} params.frame - Window body (`frame_rect`), logical px
 * @param {Rect|null} [params.bounds=null] - Clip rect (`get_monitor_geometry`), logical px
 * @param {number} [params.scale=1] - Monitor scale the frame was read at
 * @param {{top?: boolean, right?: boolean, bottom?: boolean, left?: boolean}|null} [params.constrainedEdges=null]
 * @param {boolean} [params.maximizedHorizontally=false]
 * @param {boolean} [params.maximizedVertically=false]
 * @returns {Record<string, Rect|null>} One rect per side, null where it is empty
 */
export function computeResizeBands({
    frame,
    bounds = null,
    scale = 1,
    constrainedEdges = null,
    maximizedHorizontally = false,
    maximizedVertically = false,
} = {}) {
    const bands = emptyBands();

    if (!Number.isFinite(scale) || scale <= 0)
        return bands;
    if (!frame || !Number.isFinite(frame.x) || !Number.isFinite(frame.y) ||
        !(frame.width > 0) || !(frame.height > 0))
        return bands;

    const constrained = normalizeConstrainedEdges({
        constrainedEdges,
        maximizedHorizontally,
        maximizedVertically,
    });

    const b = RESIZE_BAND;
    const {x, y, width, height} = frame;
    // Half-open, so the crops meet without overlap: the top and bottom take the full width
    // (and with it the outward corners), the left and right fill the middle height.
    // When an edge is constrained (e.g. side-tiled against boundary), that edge has no grab strip.
    const rects = {
        top: constrained.top ? null : {x: x - b, y: y - b, width: width + 2 * b, height: b},
        right: constrained.right ? null : {x: x + width, y, width: b, height},
        bottom: constrained.bottom ? null : {x: x - b, y: y + height, width: width + 2 * b, height: b},
        left: constrained.left ? null : {x: x - b, y, width: b, height},
    };

    for (const region of RESIZE_BAND_REGIONS)
        bands[region] = clipToBounds(rects[region], bounds);

    return bands;
}
