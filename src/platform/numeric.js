/** Mutter's and GSK's C rounding rules in one home, so the two mirrors cannot drift apart. */

/** `GSK_SNAP_EPSILON` in gskrectprivate.h, as of GTK 4.24. */
export const SNAP_EPSILON = 0.001;

/** How far a scale may drift from a whole number and still read as one; upstream holds scales as float32. */
export const INTEGRAL_EPSILON = 0.001;

/** Matches GTK's `GskSnapDirection`. */
export const SnapDirection = Object.freeze({
    FLOOR: 1,
    CEIL: 2,
    ROUND: 3,
});

/** `Math.round` sends an exact half toward +Infinity, so a negative half differs by one integer. */
export function roundHalfAwayFromZero(value) {
    return value < 0 ? -Math.floor(-value + 0.5) : Math.floor(value + 0.5);
}

/** ROUND departs from GSK's `roundf (value + EPSILON)` to keep f(-x) = -f(x) on both edges. */
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
