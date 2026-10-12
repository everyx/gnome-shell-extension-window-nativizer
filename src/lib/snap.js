/**
 * GTK4 / GSK Grid Snapping Utilities.
 * Implements physical pixel grid alignment matching GTK 4.24 GskRectSnap.
 * Snapping rects and cutlines eliminates fractional scaling seams and blur.
 */

import {frameFromInsets, ZERO_INSETS} from './frame.js';

export const SNAP_EPSILON = 0.001;

export const SnapDirection = Object.freeze({
    FLOOR: 1,
    CEIL: 2,
    ROUND: 3,
});

/**
 * Composite 32-bit snap rules, matching GTK's GSK_RECT_SNAP_* macros.
 * Encodes 4 edges: [left (8 bits) | bottom (8 bits) | right (8 bits) | top (8 bits)].
 * @enum {number}
 */
export const SnapRule = Object.freeze({
    GROW: 0x01020201,   // top: FLOOR, right: CEIL, bottom: CEIL, left: FLOOR
    ROUND: 0x03030303,  // top: ROUND, right: ROUND, bottom: ROUND, left: ROUND
});

/**
 * Snap a single 1D scalar value on the grid according to direction.
 * Matches gsk_rect_snap_direction (gskrectprivate.h) with strict origin-odd symmetry.
 * @param {number} value
 * @param {number} [direction=SnapDirection.ROUND]
 * @returns {number}
 */
function snapDirection(value, direction = SnapDirection.ROUND) {
    switch (direction) {
    case SnapDirection.FLOOR:
        return Math.floor(value + SNAP_EPSILON);
    case SnapDirection.CEIL:
        return Math.ceil(value - SNAP_EPSILON);
    case SnapDirection.ROUND:
        return value >= 0
            ? Math.round(value + SNAP_EPSILON)
            : -Math.round(-value + SNAP_EPSILON);
    default:
        return value;
    }
}

/**
 * Snap a logical 1D coordinate to the physical device pixel grid.
 * Matches gsk_rect_snap_to_grid scalar projection.
 * @param {number} value - Logical coordinate
 * @param {number} scale - Physical scale factor (e.g. 1.0, 1.25, 1.5, 2.0)
 * @param {number} [direction=SnapDirection.ROUND]
 * @returns {number} Snapped logical coordinate
 */
export function snapCoordToGrid(value, scale, direction = SnapDirection.ROUND) {
    if (!(scale > 0) || !Number.isFinite(scale))
        return value;
    return snapDirection(value * scale, direction) / scale;
}

/**
 * Query a specific side's direction from a SnapRule bitmask.
 * Matches gsk_rect_snap_get_direction (gskrectsnapprivate.h).
 * Sides: 0: TOP, 1: RIGHT, 2: BOTTOM, 3: LEFT.
 * @param {number} rule - SnapRule bitmask
 * @param {number} side - 0..3
 * @returns {number} SnapDirection
 */
function snapRuleGetDirection(rule, side) {
    return (rule >> (8 * side)) & 0xFF;
}

/**
 * Snap a rectangle to the physical pixel grid.
 * Matches gsk_rect_snap_to_grid in gskrectprivate.h.
 * @param {{x: number, y: number, width: number, height: number}} rect
 * @param {number} scale - Device scale factor
 * @param {number} [rule=SnapRule.ROUND] - Composite snapping rule
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function snapRectToGrid(rect, scale, rule = SnapRule.ROUND) {
    if (!(scale > 0) || !Number.isFinite(scale))
        return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};

    const topDir = snapRuleGetDirection(rule, 0);
    const rightDir = snapRuleGetDirection(rule, 1);
    const bottomDir = snapRuleGetDirection(rule, 2);
    const leftDir = snapRuleGetDirection(rule, 3);

    const left = snapCoordToGrid(rect.x, scale, leftDir);
    const top = snapCoordToGrid(rect.y, scale, topDir);
    const right = snapCoordToGrid(rect.x + rect.width, scale, rightDir);
    const bottom = snapCoordToGrid(rect.y + rect.height, scale, bottomDir);

    return {
        x: left,
        y: top,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
    };
}

/**
 * Snaps a buffer actor's body frame to the physical device grid by symmetrically
 * snapping outer insets margins per side, preventing fractional parity drift.
 * @param {{width: number, height: number}} bufferSize - Buffer size in logical px
 * @param {import('./frame.js').Insets|null} [insets] - Ring margins per side
 * @param {number} scale - Physical device scale
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function snapActorBodyFrame(bufferSize, insets, scale) {
    if (!(scale > 0) || !Number.isFinite(scale)) {
        const size = {
            width: bufferSize?.width ?? 0,
            height: bufferSize?.height ?? 0,
        };
        const frame = frameFromInsets(size, insets ?? ZERO_INSETS);
        if (frame.width > 0 && frame.height > 0)
            return frame;
        return {x: 0, y: 0, width: Math.max(0, size.width), height: Math.max(0, size.height)};
    }

    const leftMargin = insets?.left ?? 0;
    const topMargin = insets?.top ?? 0;
    const rightMargin = insets?.right ?? 0;
    const bottomMargin = insets?.bottom ?? 0;

    const physW = Math.round(bufferSize.width * scale);
    const physH = Math.round(bufferSize.height * scale);

    const mLeft = Math.round(leftMargin * scale);
    const mTop = Math.round(topMargin * scale);
    const mRight = Math.round(rightMargin * scale);
    const mBottom = Math.round(bottomMargin * scale);

    const left = mLeft / scale;
    const top = mTop / scale;
    const right = Math.max(mLeft, physW - mRight) / scale;
    const bottom = Math.max(mTop, physH - mBottom) / scale;

    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);

    if (width > 0 && height > 0)
        return {x: left, y: top, width, height};

    return {
        x: 0,
        y: 0,
        width: Math.max(0, bufferSize?.width ?? 0),
        height: Math.max(0, bufferSize?.height ?? 0),
    };
}

/** The body already sits on its buffer's phase; no subpixel correction applies. */
export const ZERO_PHASE = Object.freeze({x: 0, y: 0});

/**
 * The clip's body frame: `snapActorBodyFrame` folded onto the phase its buffer is drawn at.
 *
 * The clip's cut and the shadow's cutout are the same body edge and must land on the same
 * physical phase, so the phase is a required input, not a correction a caller may leave unsaid.
 *
 * @param {{width: number, height: number}} actorSize - Actor size in logical px
 * @param {import('./frame.js').Insets|null} [insets] - Ring margins per side
 * @param {number} scale - Physical device scale
 * @param {{x: number, y: number}} phase - Buffer's subpixel phase, logical px
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function clipFrameFor(actorSize, insets, scale, phase) {
    const frame = snapActorBodyFrame(actorSize, insets, scale);
    return {
        x: frame.x + phase.x,
        y: frame.y + phase.y,
        width: frame.width,
        height: frame.height,
    };
}


/**
 * Writes a Clutter.ActorBox in place. Prefers `init()` (the real box API) and falls
 * back to `set_origin`/`set_size` with sizes clamped to zero. A box offering neither
 * is left untouched, so callers must pass a real actor box.
 *
 * @param {object} box
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 */
export function setActorBox(box, x1, y1, x2, y2) {
    if (typeof box.init === 'function') {
        box.init(x1, y1, x2, y2);
        return;
    }
    box.set_origin?.(x1, y1);
    box.set_size?.(Math.max(0, x2 - x1), Math.max(0, y2 - y1));
}

/**
 * Snaps the eight slice quads to the physical grid as plain rects.
 *
 * The arithmetic lives here rather than next to its box-writing caller so a spec can read the
 * coordinates as data; `snapSliceBoxesInto` is the Clutter-shaped wrapper over it. The monotonic
 * clamp is part of the contract: rounding on a cast narrower than two corners can otherwise invert
 * an edge, and Mutter's float composition would leave a seam.
 *
 * @param {{x: number, y: number, width: number, height: number}} cast - Shadow cast bounding rect
 * @param {number} corner - Corner reach in px (Math.min(corner, width/2, height/2))
 * @param {number} scale - Physical device scale
 * @returns {Array<{x1:number,y1:number,x2:number,y2:number}>} The eight rects, in slice order
 */
export function snapSliceRects(cast, corner, scale) {
    const width = Math.max(0, cast.width);
    const height = Math.max(0, cast.height);
    const cornerPx = Math.max(0, Math.min(corner, width / 2, height / 2));

    const x0 = snapCoordToGrid(cast.x, scale, SnapDirection.ROUND);
    const x1 = snapCoordToGrid(cast.x + cornerPx, scale, SnapDirection.ROUND);
    const x2 = snapCoordToGrid(cast.x + width - cornerPx, scale, SnapDirection.ROUND);
    const x3 = snapCoordToGrid(cast.x + width, scale, SnapDirection.ROUND);

    const y0 = snapCoordToGrid(cast.y, scale, SnapDirection.ROUND);
    const y1 = snapCoordToGrid(cast.y + cornerPx, scale, SnapDirection.ROUND);
    const y2 = snapCoordToGrid(cast.y + height - cornerPx, scale, SnapDirection.ROUND);
    const y3 = snapCoordToGrid(cast.y + height, scale, SnapDirection.ROUND);

    // Enforce monotonic non-decreasing coordinate invariant (snappedX0 <= snappedX1 <= snappedX2 <= snappedX3).
    // Floating-point non-associativity on degenerate sizes (e.g. closing animations width < 2*corner)
    // can cause 1-device-pixel inversion around 0.5 rounding boundaries (x1 > x2).
    const snappedX0 = x0;
    const snappedX1 = Math.max(snappedX0, x1);
    const snappedX2 = Math.max(snappedX1, x2);
    const snappedX3 = Math.max(snappedX2, x3);

    const snappedY0 = y0;
    const snappedY1 = Math.max(snappedY0, y1);
    const snappedY2 = Math.max(snappedY1, y2);
    const snappedY3 = Math.max(snappedY2, y3);

    return [
        {x1: snappedX0, y1: snappedY0, x2: snappedX1, y2: snappedY1},
        {x1: snappedX2, y1: snappedY0, x2: snappedX3, y2: snappedY1},
        {x1: snappedX0, y1: snappedY2, x2: snappedX1, y2: snappedY3},
        {x1: snappedX2, y1: snappedY2, x2: snappedX3, y2: snappedY3},
        {x1: snappedX1, y1: snappedY0, x2: snappedX2, y2: snappedY1},
        {x1: snappedX1, y1: snappedY2, x2: snappedX2, y2: snappedY3},
        {x1: snappedX0, y1: snappedY1, x2: snappedX1, y2: snappedY2},
        {x1: snappedX2, y1: snappedY1, x2: snappedX3, y2: snappedY2},
    ];
}

/**
 * Mutates an existing array of 8 Clutter.ActorBox instances in-place to avoid
 * hot-path GC allocations during window paint or resize.
 *
 * Slices are arranged as:
 *   0: top-left corner     1: top-right corner
 *   2: bottom-left corner  3: bottom-right corner
 *   4: top edge            5: bottom edge
 *   6: left edge           7: right edge
 *
 * @param {Array<object>} boxes - Pre-allocated array of 8 Clutter.ActorBox objects
 * @param {{x: number, y: number, width: number, height: number}} cast - Shadow cast bounding rect
 * @param {number} corner - Corner reach in px (Math.min(corner, width/2, height/2))
 * @param {number} scale - Physical device scale
 * @returns {Array<object>} The mutated boxes
 */
export function snapSliceBoxesInto(boxes, cast, corner, scale) {
    const rects = snapSliceRects(cast, corner, scale);

    // Using box.init(x1, y1, x2, y2) guarantees zero 32-bit float ULP rounding seams
    // at slice junctions in Mutter's C engine ((float)a + (float)(b-a) != (float)b).
    for (let i = 0; i < rects.length; i++)
        setActorBox(boxes[i], rects[i].x1, rects[i].y1, rects[i].x2, rects[i].y2);

    return boxes;
}
