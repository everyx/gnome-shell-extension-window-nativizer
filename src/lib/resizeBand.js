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
 * The direction GTK's `get_edge_for_coordinates()` resolves for a pointer, or null outside
 * the `RESIZE_BAND` ring.
 *
 * The four side bands are tried in GTK's order - west, east, north, south - and inside each
 * the two corners come before that side's edge, with GTK's strict and non-strict bounds
 * kept exactly. First match wins, which is what a narrow window turns on: on a side shorter
 * than two corner reaches, the earlier band takes the overlap instead of the two halves
 * meeting at the middle.
 *
 * Only the outward ring is ours. GTK also reads an inner 24px corner when the pointer is
 * inside the body (`gsk_rounded_rect_corner_box_contains_point`); that surface belongs to
 * the client, so a point inside the body is null here.
 * @param {Rect} frame - Window body, in the same space as `x`/`y`
 * @param {number} x
 * @param {number} y
 * @returns {'n'|'ne'|'e'|'se'|'s'|'sw'|'w'|'nw'|null}
 */
export function edgeForPoint(frame, x, y) {
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

    if (x < left && x >= left - b) {
        if (y < top + c && y >= top - b)
            return 'nw';
        if (y > bottom - c && y <= bottom + b)
            return 'sw';
        return 'w';
    }
    if (x > right && x <= right + b) {
        if (y < top + c && y >= top - b)
            return 'ne';
        if (y > bottom - c && y <= bottom + b)
            return 'se';
        return 'e';
    }
    if (y < top && y >= top - b) {
        if (x < left + c && x >= left - b)
            return 'nw';
        if (x > right - c && x <= right + b)
            return 'ne';
        return 'n';
    }
    if (y > bottom && y <= bottom + b) {
        if (x < left + c && x >= left - b)
            return 'sw';
        if (x > right - c && x <= right + b)
            return 'se';
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
 * @returns {Record<string, Rect|null>} One rect per side, null where it is empty
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
    // Half-open, so the crops meet without overlap: the top and bottom take the full width
    // (and with it the outward corners), the left and right fill the middle height.
    const rects = {
        top: {x: x - b, y: y - b, width: width + 2 * b, height: b},
        right: {x: x + width, y, width: b, height},
        bottom: {x: x - b, y: y + height, width: width + 2 * b, height: b},
        left: {x: x - b, y, width: b, height},
    };

    for (const region of RESIZE_BAND_REGIONS)
        bands[region] = clipToBounds(rects[region], bounds);

    return bands;
}
