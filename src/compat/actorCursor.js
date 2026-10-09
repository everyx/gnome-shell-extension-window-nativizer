/**
 * Resolves per-actor pointer cursors on GNOME 50+ (Clutter.Actor.set_cursor_type).
 */

/**
 * Recognized cursor shapes for window resize bands and inspector picker.
 */
export const CursorShape = Object.freeze({
    DEFAULT: 'default',
    CROSSHAIR: 'crosshair',
    NORTH: 'n',
    NORTH_EAST: 'ne',
    EAST: 'e',
    SOUTH_EAST: 'se',
    SOUTH: 's',
    SOUTH_WEST: 'sw',
    WEST: 'w',
    NORTH_WEST: 'nw',
});

/** What each shape means, in the compositor enum's own spelling. */
const ENUM_MEMBER = Object.freeze({
    [CursorShape.DEFAULT]: 'DEFAULT',
    [CursorShape.CROSSHAIR]: 'CROSSHAIR',
    [CursorShape.NORTH]: 'N_RESIZE',
    [CursorShape.NORTH_EAST]: 'NE_RESIZE',
    [CursorShape.EAST]: 'E_RESIZE',
    [CursorShape.SOUTH_EAST]: 'SE_RESIZE',
    [CursorShape.SOUTH]: 'S_RESIZE',
    [CursorShape.SOUTH_WEST]: 'SW_RESIZE',
    [CursorShape.WEST]: 'W_RESIZE',
    [CursorShape.NORTH_WEST]: 'NW_RESIZE',
});

/** @returns {object|null} The Clutter namespace, or null outside a shell */
function clutterNamespace() {
    try {
        return globalThis.imports?.gi?.Clutter ?? null;
    } catch {
        return null;
    }
}

/**
 * A shape this module does not know is a programming error, not a line that cannot do it: the two are
 * told apart by where they end up - this throws, an absent enum returns null.
 * @param {string} shape - One of the CursorShape values
 * @param {object|null} [types] - The enum, for tests; defaults to this line's `Clutter.CursorType`
 * @returns {number|null} The cursor type, or null where this line has no such enum
 */
export function cursorTypeFor(shape, types = clutterNamespace()?.CursorType ?? null) {
    const member = ENUM_MEMBER[shape];
    if (!member)
        throw new Error(`[window-nativizer] unknown cursor shape: ${shape}`);
    if (!types)
        return null;
    return types[member] ?? null;
}

/**
 * Sets an actor's pointer cursor. A line with no per-actor cursor leaves the pointer alone rather
 * than throwing: the band still resizes, it just does not say so with the cursor.
 * @param {object|null} actor - Clutter.Actor
 * @param {string} shape - One of the CursorShape values
 * @param {object|null} [types] - The enum, for tests; defaults to this line's `Clutter.CursorType`
 * @returns {boolean} Whether a cursor was set
 */
export function setActorCursor(actor, shape, types = undefined) {
    const cursorType = cursorTypeFor(shape, types);
    if (cursorType === null || typeof actor?.set_cursor_type !== 'function')
        return false;
    actor.set_cursor_type(cursorType);
    return true;
}
