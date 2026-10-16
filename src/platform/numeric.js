/**
 * Upstream-numeric primitives: the C rounding rules of Mutter and GSK reproduced in JavaScript, in one
 * home so the two mirrors cannot drift into different formulas. `snapDirection`'s ROUND branch is a
 * deliberate adaptation for sign symmetry. GI-free: plain math, imported by platform and business code
 * alike.
 */

/**
 * The epsilon GSK allows a coordinate to be off by, `GSK_SNAP_EPSILON` (gskrectprivate.h).
 * Matches GTK 4.24.
 */
export const SNAP_EPSILON = 0.001;

/**
 * Composite snap direction, matching GTK's `GskSnapDirection`.
 */
export const SnapDirection = Object.freeze({
    FLOOR: 1,
    CEIL: 2,
    ROUND: 3,
});

/**
 * Rounds to the nearest integer with an exact half resolved away from zero, matching C's `roundf`.
 * `Math.round` sends an exact half toward +Infinity instead, so on a negative half the two differ by
 * one snapped integer - a clipped-edge mismatch against Mutter's transform.
 */
export function roundHalfAwayFromZero(value) {
    return value < 0 ? -Math.floor(-value + 0.5) : Math.floor(value + 0.5);
}

/**
 * Snaps a 1D scalar on the grid by direction. FLOOR and CEIL mirror `gsk_rect_snap_direction`
 * exactly. ROUND deliberately departs from GSK's `roundf (value + GSK_SNAP_EPSILON)`, which biases
 * negative coordinates toward zero: we round the magnitude and reapply the sign so f(-x) = -f(x),
 * and the two edges of a body snap alike. `tests/snap.test.js` pins both.
 */
export function snapDirection(value, direction = SnapDirection.ROUND) {
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
