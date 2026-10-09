/**
 * Resize band geometry for compositor resize grab.
 * `edgeForPoint()` resolves direction (first match wins, matching GTK semantics).
 * `computeResizeBands()` calculates the four disjoint outer ring hit rectangles.
 */

import {RESIZE_HANDLE_SIZE, RESIZE_HANDLE_CORNER_SIZE} from './gtkRules.generated.js';

/** GTK-compatible handle width (input region grown around CSD window). */
export const RESIZE_BAND = RESIZE_HANDLE_SIZE;

/** GTK-compatible corner reach. */
export const RESIZE_CORNER = RESIZE_HANDLE_CORNER_SIZE;

/** Thinnest window that gets a band (2 * RESIZE_BAND). */
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
 * bottom, `maximized_horizontally` the left and right, and both together are all four.
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
 * Maps pointer coordinate to resize direction.
 * Points inside window body resolve to null (handled by client).
 * Constrained edges resolve to null, and adjacent corners resolve to unconstrained edge.
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

    // First match wins: earlier edge claims corner overlap on narrow windows.
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
 * Clears one region in place, reporting whether it held a band.
 * @returns {boolean}
 */
function clearBand(bands, region) {
    if (!bands[region])
        return false;
    bands[region] = null;
    return true;
}

/**
 * Writes one region of the ring into `bands` in place, reusing the region's own rect object
 * when it already has one, and returns whether the written value differs from what was there.
 * A `constrained` edge is held fixed and gets no strip.
 * @returns {boolean}
 */
function clipValuesInto(bands, region, rx, ry, rw, rh, bounds, constrained) {
    if (constrained || !(rw > 0) || !(rh > 0))
        return clearBand(bands, region);

    let x = rx;
    let y = ry;
    let w = rw;
    let h = rh;
    if (bounds) {
        const x1 = Math.max(rx, bounds.x);
        const y1 = Math.max(ry, bounds.y);
        const x2 = Math.min(rx + rw, bounds.x + bounds.width);
        const y2 = Math.min(ry + rh, bounds.y + bounds.height);
        if (!(x2 > x1) || !(y2 > y1))
            return clearBand(bands, region);
        x = x1;
        y = y1;
        w = x2 - x1;
        h = y2 - y1;
    }

    const out = bands[region] ?? (bands[region] = {x: 0, y: 0, width: 0, height: 0});
    const changed = out.x !== x || out.y !== y || out.width !== w || out.height !== h;
    out.x = x;
    out.y = y;
    out.width = w;
    out.height = h;
    return changed;
}

/**
 * @returns {Record<string, Rect|null>} Every surface present, all null
 */
export function emptyBands() {
    const bands = {};
    for (const region of RESIZE_BAND_REGIONS)
        bands[region] = null;
    return bands;
}

/**
 * Writes the four disjoint outer ring rectangles into `bands` in place, clipped to `bounds`.
 * Reuses existing rect objects in `bands` to avoid GC allocation on hot path.
 * Direction is resolved separately via `edgeForPoint()`.
 * @param {Record<string, Rect|null>} bands - mutated in place
 * @param {object} params - see `computeResizeBands`
 * @returns {boolean} Whether `bands` differs from what it held
 */
export function computeResizeBandsInto(bands, {
    frame,
    bounds = null,
    scale = 1,
    constrainedEdges = null,
    maximizedHorizontally = false,
    maximizedVertically = false,
} = {}) {
    if (!Number.isFinite(scale) || scale <= 0 ||
        !frame || !Number.isFinite(frame.x) || !Number.isFinite(frame.y) ||
        !(frame.width > 0) || !(frame.height > 0)) {
        let changed = false;
        for (const region of RESIZE_BAND_REGIONS)
            changed = clearBand(bands, region) || changed;
        return changed;
    }

    const constrained = normalizeConstrainedEdges({
        constrainedEdges,
        maximizedHorizontally,
        maximizedVertically,
    });

    const b = RESIZE_BAND;
    const {x, y, width, height} = frame;
    // Half-open, so the crops meet without overlap: the top and bottom take the full width
    // (and with it the outward corners), the left and right fill the middle height. A
    // constrained edge (e.g. side-tiled against a boundary) has no grab strip.
    let changed = false;
    changed = clipValuesInto(bands, 'top', x - b, y - b, width + 2 * b, b, bounds, constrained.top) || changed;
    changed = clipValuesInto(bands, 'right', x + width, y, b, height, bounds, constrained.right) || changed;
    changed = clipValuesInto(bands, 'bottom', x - b, y + height, width + 2 * b, b, bounds, constrained.bottom) || changed;
    changed = clipValuesInto(bands, 'left', x - b, y, b, height, bounds, constrained.left) || changed;
    return changed;
}

/**
 * @param {object} params - see `computeResizeBandsInto`
 * @returns {Record<string, Rect|null>} One rect per side, null where it is empty
 */
export function computeResizeBands(params) {
    const bands = emptyBands();
    computeResizeBandsInto(bands, params);
    return bands;
}
