/**
 * GTK4 / GSK Grid Snapping Utilities.
 * Reproduces GTK 4.24 GskRectSnap physical pixel grid alignment; FLOOR and CEIL mirror
 * `gsk_rect_snap_direction` exactly, while ROUND is a deliberate origin-odd adaptation of GSK's
 * raw-value epsilon (see `snapDirection` in `platform/numeric.js`).
 * Snapping rects and cutlines eliminates fractional scaling seams and blur.
 */

import {frameFromInsets, ZERO_INSETS} from './frame.js';
import {snapDirection, SnapDirection} from '../platform/numeric.js';

// Re-exported for the public snap API; the definitions live with the other upstream-numeric
// primitives in platform/numeric.js.
export {SNAP_EPSILON, SnapDirection} from '../platform/numeric.js';

/**
 * Composite 32-bit snap rules, matching GTK's GSK_RECT_SNAP_* macros.
 * Encodes 4 edges: [left (8 bits) | bottom (8 bits) | right (8 bits) | top (8 bits)].
 */
export const SnapRule = Object.freeze({
    GROW: 0x01020201,   // top: FLOOR, right: CEIL, bottom: CEIL, left: FLOOR
    ROUND: 0x03030303,  // top: ROUND, right: ROUND, bottom: ROUND, left: ROUND
});

/**
 * Snap a logical 1D coordinate to the physical device pixel grid.
 * Matches gsk_rect_snap_to_grid scalar projection (the ROUND edge carries snapDirection's
 * deliberate origin-odd deviation from GSK).
 * @param value - Logical coordinate
 * @param scale - Physical scale factor (e.g. 1.0, 1.25, 1.5, 2.0)
 * @returns Snapped logical coordinate
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
 * @param rule - SnapRule bitmask
 * @param side - 0..3
 * @returns SnapDirection
 */
function snapRuleGetDirection(rule, side) {
    return (rule >> (8 * side)) & 0xFF;
}

/**
 * Snap a rectangle to the physical pixel grid.
 * Matches gsk_rect_snap_to_grid in gskrectprivate.h except for the documented ROUND deviation
 * in snapDirection.
 * @param scale - Device scale factor
 * @param [rule=SnapRule.ROUND] - Composite snapping rule
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
 * @param bufferSize - Buffer size in logical px
 * @param [insets] - Ring margins per side
 * @param scale - Physical device scale
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

export const ZERO_PHASE = Object.freeze({x: 0, y: 0});

/**
 * The clip's body frame: `snapActorBodyFrame` folded onto the phase its buffer is drawn at. The cut
 * and the shadow's cutout are the same edge and must land on one physical phase, so the phase is a
 * required input, not a correction a caller may leave unsaid.
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
 * Snaps the eight slice quads to the physical grid as plain rects, so a spec can read the arithmetic
 * as data. The monotonic clamp is part of the contract: rounding a cast narrower than two corners can
 * invert an edge and leave a seam. Position snaps; the span stays exactly `cornerPx`, or the corner
 * texture is rescaled.
 */
export function snapSliceRects(cast, corner, scale) {
    const width = Math.max(0, cast.width);
    const height = Math.max(0, cast.height);
    const cornerPx = Math.max(0, Math.min(corner, width / 2, height / 2));

    const x0 = snapCoordToGrid(cast.x, scale, SnapDirection.ROUND);
    const x3 = snapCoordToGrid(cast.x + width, scale, SnapDirection.ROUND);
    const x1 = x0 + cornerPx;
    const x2 = x3 - cornerPx;

    const y0 = snapCoordToGrid(cast.y, scale, SnapDirection.ROUND);
    const y3 = snapCoordToGrid(cast.y + height, scale, SnapDirection.ROUND);
    const y1 = y0 + cornerPx;
    const y2 = y3 - cornerPx;

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
 * Mutates a pre-allocated array of 8 Clutter.ActorBox instances in place, avoiding hot-path GC
 * allocations during paint or resize. Slice order: 0-3 the four corners (TL, TR, BL, BR), 4-5 top
 * and bottom edges, 6-7 left and right.
 */
export function snapSliceBoxesInto(boxes, cast, corner, scale) {
    const rects = snapSliceRects(cast, corner, scale);

    // Using box.init(x1, y1, x2, y2) guarantees zero 32-bit float ULP rounding seams
    // at slice junctions in Mutter's C engine ((float)a + (float)(b-a) != (float)b).
    for (let i = 0; i < rects.length; i++)
        setActorBox(boxes[i], rects[i].x1, rects[i].y1, rects[i].x2, rects[i].y2);

    return boxes;
}
