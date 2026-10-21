// Per-actor pointer cursors on GNOME 50+, where Clutter gained Actor.set_cursor_type.

import {PREFIX} from './journal.js';

/** Resize directions plus the picker crosshair, in band terms rather than Clutter enum names. */
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

function clutterNamespace() {
    try {
        return globalThis.imports?.gi?.Clutter ?? null;
    } catch {
        return null;
    }
}

/** An unknown shape throws, an absent Clutter enum returns null: the two failures stay apart. */
export function cursorTypeFor(shape, types = clutterNamespace()?.CursorType ?? null) {
    const member = ENUM_MEMBER[shape];
    if (!member)
        throw new Error(`${PREFIX} unknown cursor shape: ${shape}`);
    if (!types)
        return null;
    return types[member] ?? null;
}

/** An actor with no per-actor cursor leaves the pointer alone: the band still resizes, silently. */
export function setActorCursor(actor, shape, types = undefined) {
    const cursorType = cursorTypeFor(shape, types);
    if (cursorType === null || typeof actor?.set_cursor_type !== 'function')
        return false;
    actor.set_cursor_type(cursorType);
    return true;
}
