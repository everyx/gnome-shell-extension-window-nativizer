/**
 * Upstream-numeric primitives.
 *
 * These reproduce C rounding rules from Mutter/GSK in JavaScript, and are shared by
 * `lib/snap.js` (GSK grid snapping) and `platform/window.js` (the Mutter subpixel phase). One
 * home so the two mirrors cannot drift apart into subtly different formulas.
 *
 * `roundHalfAwayFromZero` and `snapDirection`'s FLOOR/CEIL branches are exact mirrors of their
 * upstream. `snapDirection`'s ROUND branch is a deliberate adaptation: GSK evaluates
 * `roundf (value + GSK_SNAP_EPSILON)` on the raw value, which biases negative coordinates
 * toward zero, while we need f(-x) = -f(x) so the two edges of a body snap alike. See the
 * JSDoc below and docs/decoration-alignment.md.
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
 *
 * FLOOR and CEIL are exact mirrors of `gsk_rect_snap_direction` (gskrectprivate.h):
 * `floorf (value + GSK_SNAP_EPSILON)` and `ceilf (value - GSK_SNAP_EPSILON)`.
 *
 * ROUND deliberately departs from GSK, whose branch is `roundf (value + GSK_SNAP_EPSILON)`:
 * the epsilon lands on the raw value, so for value = -1.5 it yields `roundf(-1.499)` = -1,
 * biasing negative coordinates toward zero and making the rule asymmetric. We round the
 * magnitude and reapply the sign instead, so f(-x) = -f(x) holds and the two edges of a body
 * snap alike. tests/snap.test.js pins both the deviation and the symmetry property; see
 * docs/decoration-alignment.md for the A/B decision and its reopen trigger.
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
