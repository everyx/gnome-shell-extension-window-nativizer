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
 *
 * `bounds = null` means "do not clip to a monitor" (the actor's no-surface-clip case).
 * `boundsUnknown = true` is a different state: the monitor rect could not be read, so the
 * strips are dropped rather than written at full extent, where a window flush against an edge
 * would grow a reactive strip onto the neighbouring monitor. The degradation keeps a correct
 * display alone instead of adding a surface we cannot place.
 *
 * @param {Record<string, Rect|null>} bands - mutated in place
 * @param {object} params - see `computeResizeBands`
 * @param {boolean} [params.boundsUnknown=false] - Bounds could not be read; drop every strip
 * @returns {boolean} Whether `bands` differs from what it held
 */
export function computeResizeBandsInto(bands, {
    frame,
    bounds = null,
    boundsUnknown = false,
    scale = 1,
    constrainedEdges = null,
    maximizedHorizontally = false,
    maximizedVertically = false,
} = {}) {
    if (boundsUnknown) {
        let changed = false;
        for (const region of RESIZE_BAND_REGIONS)
            changed = clearBand(bands, region) || changed;
        return changed;
    }

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

/**
 * Writes the container allocation mapping into `out` in place, reusing `out.frame` and
 * `out.bounds`.
 *
 * The band container is the window actor grown by RESIZE_BAND per side, so the body starts
 * RESIZE_BAND + the declared inset in from the container origin. `bounds` is a monitor rect
 * in stage coordinates and is translated into container coordinates so the clip and the
 * frame share one space. This runs every resize frame, so the actor keeps a scratch record
 * and the pure mapping fills it rather than allocating a frame and bounds per pass.
 *
 * @param {{frame:Rect|null, bounds:Rect|null, scale:number}} out - Mutated in place
 * @param {{x1:number,y1:number,x2:number,y2:number}} containerBox - Clutter.ActorBox, read as data
 * @param {import('./frame.js').Insets} insets - Ring between actor and body
 * @param {Rect|null} bounds - Monitor rect in stage coordinates, or null for no clip
 * @param {number} scale - Monitor scale the frame was read at
 * @returns {object} `out`, for chaining
 */
export function bandParamsInto(out, containerBox, insets, bounds, scale) {
    const containerWidth = containerBox.x2 - containerBox.x1;
    const containerHeight = containerBox.y2 - containerBox.y1;

    const frame = out.frame ?? (out.frame = {x: 0, y: 0, width: 0, height: 0});
    frame.x = insets.left + RESIZE_BAND;
    frame.y = insets.top + RESIZE_BAND;
    frame.width = containerWidth - RESIZE_BAND * 2 - insets.left - insets.right;
    frame.height = containerHeight - RESIZE_BAND * 2 - insets.top - insets.bottom;

    if (bounds) {
        const translated = out.bounds ?? (out.bounds = {x: 0, y: 0, width: 0, height: 0});
        translated.x = bounds.x - containerBox.x1;
        translated.y = bounds.y - containerBox.y1;
        translated.width = bounds.width;
        translated.height = bounds.height;
    } else {
        out.bounds = null;
    }

    out.scale = scale;
    return out;
}

/**
 * Allocating wrapper over `bandParamsInto`, for callers that do not keep a scratch record
 * (the spec helper `bandBoxes` and the specs themselves).
 * @param {{x1:number,y1:number,x2:number,y2:number}} containerBox
 * @param {import('./frame.js').Insets} insets
 * @param {Rect|null} bounds
 * @param {number} scale
 * @returns {{frame:Rect, bounds:Rect|null, scale:number}}
 */
export function bandParams(containerBox, insets, bounds, scale) {
    return bandParamsInto({frame: null, bounds: null, scale: 1}, containerBox, insets, bounds, scale);
}

/**
 * The four strip rects one container allocation produces, as plain data.
 *
 * This is the mapping `vfunc_allocate()` uses plus the ring computation, so the sign and
 * scale conventions of the live allocation are spec-covered. A constrained or empty side
 * stays null; the actor writes it as a 0x0 child box.
 *
 * @param {{x1:number,y1:number,x2:number,y2:number}} containerBox
 * @param {import('./frame.js').Insets} insets
 * @param {Rect|null} bounds
 * @param {number} scale
 * @param {{top?: boolean, right?: boolean, bottom?: boolean, left?: boolean}|null} [constrainedEdges=null]
 * @returns {{params:object, boxes:Record<string, Rect|null>}}
 */
export function bandBoxes(containerBox, insets, bounds, scale, constrainedEdges = null) {
    const params = bandParams(containerBox, insets, bounds, scale);
    return {params, boxes: computeResizeBands({...params, constrainedEdges})};
}
