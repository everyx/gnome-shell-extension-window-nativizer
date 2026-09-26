/**
 * GTK4 / GSK Grid Snapping Utilities.
 *
 * Implements physical pixel grid alignment directly aligned with GTK 4.24's
 * GskRectSnap, GSK_RECT_SNAP_ROUND, and gsk_rect_snap_to_grid.
 *
 * Rationale:
 * Under fractional scaling or floating-point actor positions, adjacent 9-slice
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

/**
 * Snap direction per edge, matching GTK's GskSnapDirection (gskenums.h).
 * @enum {number}
 */
export const SnapDirection = Object.freeze({
    NONE: 0,
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
    NONE: 0,
    GROW: 0x01020201,   // top: FLOOR, right: CEIL, bottom: CEIL, left: FLOOR
    SHRINK: 0x02010102, // top: CEIL, right: FLOOR, bottom: FLOOR, left: CEIL
    ROUND: 0x03030303,  // top: ROUND, right: ROUND, bottom: ROUND, left: ROUND
});

/**
 * Snap a single 1D scalar value on the grid according to direction.
 * Matches gsk_rect_snap_direction (gskrectprivate.h).
 * @param {number} value
 * @param {number} [direction=SnapDirection.ROUND]
 * @returns {number}
 */
export function snapDirection(value, direction = SnapDirection.ROUND) {
    switch (direction) {
    case SnapDirection.FLOOR:
        return Math.floor(value + SNAP_EPSILON);
    case SnapDirection.CEIL:
        return Math.ceil(value - SNAP_EPSILON);
    case SnapDirection.ROUND:
        return Math.round(value + SNAP_EPSILON);
    case SnapDirection.NONE:
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
    if (scale <= 0 || direction === SnapDirection.NONE)
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
export function snapRuleGetDirection(rule, side) {
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
    if (scale <= 0 || rule === SnapRule.NONE)
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
 * 8-slice quad mapping to a 3x3 grid (excluding center hole).
 * Each tuple defines [col_start, row_start, col_end, row_end].
 * Indices align with shadowSlices in effects/shadowTexture.js:
 * 0: top-left corner
 * 1: top-right corner
 * 2: bottom-left corner
 * 3: bottom-right corner
 * 4: top edge
 * 5: bottom edge
 * 6: left edge
 * 7: right edge
 */
export const SLICE_GRID_INDICES = Object.freeze([
    [0, 0, 1, 1], // 0: top-left
    [2, 0, 3, 1], // 1: top-right
    [0, 2, 1, 3], // 2: bottom-left
    [2, 2, 3, 3], // 3: bottom-right
    [1, 0, 2, 1], // 4: top edge
    [1, 2, 2, 3], // 5: bottom edge
    [0, 1, 1, 2], // 6: left edge
    [2, 1, 3, 2], // 7: right edge
]);

/**
 * Computes snapped 8-slice bounding boxes on the physical device pixel grid.
 * Shared cutlines between adjacent tiles (e.g. corner and edge) snap to the
 * identical coordinate, guaranteeing zero gap and zero overlap.
 *
 * @param {{x: number, y: number, width: number, height: number}} cast - Shadow cast bounding rect
 * @param {number} corner - Corner reach in px (Math.min(corner, width/2, height/2))
 * @param {number} scale - Physical device scale
 * @returns {Array<{x: number, y: number, width: number, height: number}>} 8 snapped slice boxes
 */
export function snapSliceBoxes(cast, corner, scale) {
    const c = Math.min(corner, cast.width / 2, cast.height / 2);

    const x0 = snapCoordToGrid(cast.x, scale, SnapDirection.ROUND);
    const x1 = snapCoordToGrid(cast.x + c, scale, SnapDirection.ROUND);
    const x2 = snapCoordToGrid(cast.x + cast.width - c, scale, SnapDirection.ROUND);
    const x3 = snapCoordToGrid(cast.x + cast.width, scale, SnapDirection.ROUND);

    const y0 = snapCoordToGrid(cast.y, scale, SnapDirection.ROUND);
    const y1 = snapCoordToGrid(cast.y + c, scale, SnapDirection.ROUND);
    const y2 = snapCoordToGrid(cast.y + cast.height - c, scale, SnapDirection.ROUND);
    const y3 = snapCoordToGrid(cast.y + cast.height, scale, SnapDirection.ROUND);

    const X = [x0, x1, x2, x3];
    const Y = [y0, y1, y2, y3];

    return SLICE_GRID_INDICES.map(([c1, r1, c2, r2]) => {
        const bx1 = X[c1];
        const by1 = Y[r1];
        const bx2 = X[c2];
        const by2 = Y[r2];
        return {
            x: bx1,
            y: by1,
            width: Math.max(0, bx2 - bx1),
            height: Math.max(0, by2 - by1),
        };
    });
}
