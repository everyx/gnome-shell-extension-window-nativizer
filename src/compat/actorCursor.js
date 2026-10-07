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

/** What each name means, in the enum's own spelling. */
const ENUM_MEMBER = Object.freeze({
    default: 'DEFAULT',
    crosshair: 'CROSSHAIR',
    n: 'N_RESIZE',
    ne: 'NE_RESIZE',
    e: 'E_RESIZE',
    se: 'SE_RESIZE',
    s: 'S_RESIZE',
    sw: 'SW_RESIZE',
    w: 'W_RESIZE',
    nw: 'NW_RESIZE',
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
 * @param {string} name - One of the names in ENUM_MEMBER
 * @param {object|null} [types] - The enum, for tests; defaults to this line's `Clutter.CursorType`
 * @returns {number|null} The cursor type, or null where this line has no such enum
 */
export function cursorTypeFor(name, types = clutterNamespace()?.CursorType ?? null) {
    const member = ENUM_MEMBER[name];
    if (!member || !types)
        return null;
    return types[member] ?? null;
}

/**
 * Sets an actor's pointer cursor. A line with no per-actor cursor leaves the pointer alone rather
 * than throwing: the band still resizes, it just does not say so with the cursor.
 * @param {object|null} actor - Clutter.Actor
 * @param {string} name - One of the names in ENUM_MEMBER
 * @param {object|null} [types] - The enum, for tests; defaults to this line's `Clutter.CursorType`
 * @returns {boolean} Whether a cursor was set
 */
export function setActorCursor(actor, name, types = undefined) {
    const cursorType = cursorTypeFor(name, types);
    if (cursorType === null || typeof actor?.set_cursor_type !== 'function')
        return false;
    actor.set_cursor_type(cursorType);
    return true;
}
