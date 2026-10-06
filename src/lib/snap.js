/**
 * GTK4 / GSK Grid Snapping Utilities.
 *
 * Implements physical pixel grid alignment directly aligned with GTK 4.24's
 * GskRectSnap, GSK_RECT_SNAP_ROUND, and gsk_rect_snap_to_grid.
 *
 * Rationale:
 * Under fractional scaling or floating-point actor positions, adjacent 8-slice
 * quads and compositor clipping effects suffer from subpixel rasterization
 * jitter (±0.5 physical px phase drift). Snapping rects and cutlines to the
 * physical device pixel grid eliminates seams, overlap artifacts, and edge blur.
 *
 * Reference:
 * - research/gtk/gsk/gskrectsnap.h
 * - research/gtk/gsk/gskrectsnapprivate.h
 * - research/gtk/gsk/gskrectprivate.h
 */


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
 * snapping the outer insets margins per side.
 *
 * Rationale:
 * Snapping absolute rect coordinates `x` and `x + width` independently under
 * fractional scaling suffers from parity drift: when bufferWidth and insets
 * have non-matching fractional parts, `round(w * s) - round((w - r) * s)` can
 * differ from `round(r * s)` by 1 physical pixel, breaking 4-way symmetry and
 * leaving subpixel client border stroke residue on one side.
 * Snapping margins symmetrically guarantees that equal declared insets yield
 * identical physical margin cuts on both sides across all fractional scales.
 *
 * @param {{width: number, height: number}} bufferSize - Buffer size in logical px
 * @param {import('./frame.js').Insets|null} [insets] - Ring margins per side
 * @param {number} scale - Physical device scale
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function snapActorBodyFrame(bufferSize, insets, scale) {
    const leftMargin = insets?.left ?? 0;
    const topMargin = insets?.top ?? 0;
    const rightMargin = insets?.right ?? 0;
    const bottomMargin = insets?.bottom ?? 0;

    if (!(scale > 0) || !Number.isFinite(scale)) {
        const w = bufferSize?.width ?? 0;
        const h = bufferSize?.height ?? 0;
        const bodyW = w - leftMargin - rightMargin;
        const bodyH = h - topMargin - bottomMargin;
        if (bodyW > 0 && bodyH > 0)
            return {x: leftMargin, y: topMargin, width: bodyW, height: bodyH};
        return {x: 0, y: 0, width: Math.max(0, w), height: Math.max(0, h)};
    }

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

    // Using box.init(x1, y1, x2, y2) guarantees zero 32-bit float ULP rounding seams
    // at slice junctions in Mutter's C engine ((float)a + (float)(b-a) != (float)b).
    // 0: top-left [snappedX0, snappedY0, snappedX1, snappedY1]
    setActorBox(boxes[0], snappedX0, snappedY0, snappedX1, snappedY1);

    // 1: top-right [snappedX2, snappedY0, snappedX3, snappedY1]
    setActorBox(boxes[1], snappedX2, snappedY0, snappedX3, snappedY1);

    // 2: bottom-left [snappedX0, snappedY2, snappedX1, snappedY3]
    setActorBox(boxes[2], snappedX0, snappedY2, snappedX1, snappedY3);

    // 3: bottom-right [snappedX2, snappedY2, snappedX3, snappedY3]
    setActorBox(boxes[3], snappedX2, snappedY2, snappedX3, snappedY3);

    // 4: top edge [snappedX1, snappedY0, snappedX2, snappedY1]
    setActorBox(boxes[4], snappedX1, snappedY0, snappedX2, snappedY1);

    // 5: bottom edge [snappedX1, snappedY2, snappedX2, snappedY3]
    setActorBox(boxes[5], snappedX1, snappedY2, snappedX2, snappedY3);

    // 6: left edge [snappedX0, snappedY1, snappedX1, snappedY2]
    setActorBox(boxes[6], snappedX0, snappedY1, snappedX1, snappedY2);

    // 7: right edge [snappedX2, snappedY1, snappedX3, snappedY2]
    setActorBox(boxes[7], snappedX2, snappedY1, snappedX3, snappedY2);

    return boxes;
}
