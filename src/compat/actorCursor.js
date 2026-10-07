/**
 * Pointer cursors, asked for by name, on whichever line this is running on.
 *
 * The API moved. `Clutter.Actor.set_cursor_type` and the `ClutterCursorType` enum it takes both
 * arrive in 50; before that there is no per-actor cursor at all. The enum used to be read into a
 * module-level table, which is what stopped the extension loading on 45-49: the module threw while it
 * was being evaluated (`TypeError: (intermediate value).CursorType is undefined`) and the shell
 * reported the whole extension as failed. So it is looked up per call, and a line without it simply
 * gets no cursor.
 *
 * Names rather than enum values, because the caller is a window band whose directions are its own
 * vocabulary (lib/resizeBand.js) and the compositor's enum should not be part of it. Resolving them
 * in one place is also where the 45-49 path would go - `global.display.set_cursor(MetaCursor)`, a
 * display-wide cursor rather than a per-actor one, so owning its reset would come with it - when
 * there is a line to verify that on.
 *
 * No GI import, so the lookup is unit-testable: the namespace is reached through the importer the
 * shell leaves on `globalThis`, as lib/window.js reaches `Shell`.
 */

/**
 * The pointer a caller asks for. A value of this kind rather than a bare string: a misspelt string
 * would resolve to nothing and leave the pointer alone in silence, which is exactly the failure this
 * module just spent a commit removing. The eight directions are the band's own vocabulary - the same
 * tokens `edgeForPoint()` answers and the grab-op table is keyed by - so a direction needs no
 * translation here.
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
