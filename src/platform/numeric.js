/**
 * Upstream-numeric primitives.
 *
 * These exist only to reproduce a C rounding rule from Mutter/GSK in JavaScript, and are
 * shared by `lib/snap.js` (GSK grid snapping) and `platform/window.js` (the Mutter subpixel
 * phase). One home so the two mirrors cannot drift apart into subtly different formulas.
 *
 * GI-free: this module is plain math, imported by platform and business code alike.
 */

/**
 * The epsilon GSK allows a coordinate to be off by, `GSK_SNAP_EPSILON` (gskrectprivate.h).
 * Matches GTK 4.24.
 * @type {number}
 */
export const SNAP_EPSILON = 0.001;

/**
 * Composite snap direction, matching GTK's `GskSnapDirection`.
 * @enum {number}
 */
export const SnapDirection = Object.freeze({
    FLOOR: 1,
    CEIL: 2,
    ROUND: 3,
});

/**
 * Rounds to the nearest integer with an exact half resolved away from zero, matching C's
 * `roundf`. `Math.round` cannot stand in: it resolves an exact half toward +Infinity, so on a
 * negative half the two differ by one snapped integer - `roundf(-12.5)` is -13 while
 * `Math.round(-12.5)` is -12. That is a clipped-edge mismatch against the transform Mutter
 * applies, so the subpixel phase has to use this rule.
 *
 * @param {number} value
 * @returns {number}
 */
export function roundHalfAwayFromZero(value) {
    return value < 0 ? -Math.floor(-value + 0.5) : Math.floor(value + 0.5);
}

/**
 * Snap a single 1D scalar value on the grid according to direction.
 * Matches `gsk_rect_snap_direction` (gskrectprivate.h) with strict origin-odd symmetry: the
 * ROUND branch is the sign-split `roundf` form, so an exact half moves away from zero.
 *
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
        return value >= 0
            ? Math.round(value + SNAP_EPSILON)
            : -Math.round(-value + SNAP_EPSILON);
    default:
        return value;
    }
}
