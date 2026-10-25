// Resize band geometry for the compositor grab: the edge a point takes, and the ring's four strips.

import {RESIZE_HANDLE_SIZE, RESIZE_HANDLE_CORNER_SIZE} from './gtkRules.generated.js';

export const RESIZE_BAND = RESIZE_HANDLE_SIZE;

export const RESIZE_CORNER = RESIZE_HANDLE_CORNER_SIZE;

export const MIN_BAND_WINDOW = 2 * RESIZE_BAND;

/** Clockwise catch surfaces; direction comes from edgeForPoint, not from which one was entered. */
export const RESIZE_BAND_REGIONS = ['top', 'right', 'bottom', 'left'];

/** Maximized vertically pins top and bottom, maximized horizontally pins left and right. */
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

/** A stage point as the band sees it: the actor's own origin removed, then the ring decides. */
export function edgeForStagePoint(frame, coords, origin, constrainedEdges = null) {
    const [x, y] = coords ?? [];
    const [originX, originY] = origin ?? [];
    return edgeForPoint(frame, x - originX, y - originY, {constrainedEdges});
}

/** Body points are the client's; a constrained edge yields null, its corner the free edge. */
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

/** Clears one region in place, reporting whether it held a band. */
function clearBand(bands, region) {
    if (!bands[region])
        return false;
    bands[region] = null;
    return true;
}

/** Reuses the region's rect so a steady ring allocates nothing; a constrained edge clears it. */
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

/** @returns Every surface present, all null */
export function emptyBands() {
    const bands = {};
    for (const region of RESIZE_BAND_REGIONS)
        bands[region] = null;
    return bands;
}

/** boundsUnknown drops every strip; at full extent one would land on the neighbouring monitor. */
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
    // Half-open so the crops meet: top and bottom take the full width, left and right the middle.
    let changed = false;
    changed = clipValuesInto(bands, 'top', x - b, y - b, width + 2 * b, b, bounds, constrained.top) || changed;
    changed = clipValuesInto(bands, 'right', x + width, y, b, height, bounds, constrained.right) || changed;
    changed = clipValuesInto(bands, 'bottom', x - b, y + height, width + 2 * b, b, bounds, constrained.bottom) || changed;
    changed = clipValuesInto(bands, 'left', x - b, y, b, height, bounds, constrained.left) || changed;
    return changed;
}

/** @param params - see `computeResizeBandsInto`; one rect per side, null where it is empty. */
export function computeResizeBands(params) {
    const bands = emptyBands();
    computeResizeBandsInto(bands, params);
    return bands;
}

/** Body starts RESIZE_BAND plus the declared inset in; bounds is moved into container space. */
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

/** Allocating wrapper over `bandParamsInto`, for callers that keep no scratch record. */
export function bandParams(containerBox, insets, bounds, scale) {
    return bandParamsInto({frame: null, bounds: null, scale: 1}, containerBox, insets, bounds, scale);
}

/** The live vfunc_allocate mapping plus the ring, so its sign and scale conventions are tested. */
export function bandBoxes(containerBox, insets, bounds, scale, constrainedEdges = null) {
    const params = bandParams(containerBox, insets, bounds, scale);
    return {params, boxes: computeResizeBands({...params, constrainedEdges})};
}
