/** Compositor resize-grab helpers, whose signatures changed across GNOME 50 and 51. */

function resolveBackend() {
    const stage = globalThis.global?.stage;
    return stage?.get_context?.()?.get_backend?.() ?? globalThis.global?.backend;
}

/** `get_sprite` is primary; `get_pointer_sprite` is the fallback when it is unavailable. */
export function getPointerSprite(event) {
    const stage = globalThis.global?.stage;
    const backend = resolveBackend();
    return backend?.get_sprite?.(stage, event) ??
        backend?.get_pointer_sprite?.(stage) ?? null;
}

export function focusWindow(win, time) {
    try {
        win?.focus?.(time);
    } catch {
        // The window went between the press and the focus: nothing left to focus.
    }
}

/** True only when Mutter accepted the grab: a FALSE return must leave the event propagating. */
export function beginWindowGrabOp(win, op, sprite, time, posHint) {
    if (typeof win?.begin_grab_op !== 'function' || !sprite || op === null || op === undefined)
        return false;

    try {
        return win.begin_grab_op(op, sprite, time, posHint) === true;
    } catch {
        // Mutter rejects grabs on windows that unmanaged or lost their surface mid-click.
        return false;
    }
}

/** `GDesktopFocusMode`: 1 sloppy, 2 mouse (gdesktop-enums.h); 0 is click, and 3 is not defined. */
const POINTER_FOCUS_MODES = [1, 2];

/**
 * In the pointer modes Mutter focuses what the pointer is over, so a window whose edge the pointer
 * is on would already have focus - and the band is not part of that window's surface. A value this
 * does not recognise keeps click behaviour: taking focus is the risky side of the guess.
 */
export function focusesOnPointer(meta = metaNamespace()) {
    return POINTER_FOCUS_MODES.includes(meta?.prefs_get_focus_mode?.());
}

export function isRaiseOnClick(meta = metaNamespace()) {
    return meta?.prefs_get_raise_on_click?.() ?? true;
}

export function getMoveGrabOp(meta = metaNamespace()) {
    return meta?.GrabOp?.MOVING_UNCONSTRAINED ?? null;
}

function metaNamespace() {
    try {
        return globalThis.imports?.gi?.Meta ?? null;
    } catch {
        // Absent outside a live GJS GI session (e.g. unit tests).
        return null;
    }
}

/** The Meta namespace is a parameter, so which typelib is used is the caller's choice. */
export function getResizeGrabOp(direction, meta = metaNamespace()) {
    const grabOp = meta?.GrabOp;
    if (!grabOp)
        return null;
    switch (direction) {
    case 'n': return grabOp.RESIZING_N ?? null;
    case 'ne': return grabOp.RESIZING_NE ?? null;
    case 'e': return grabOp.RESIZING_E ?? null;
    case 'se': return grabOp.RESIZING_SE ?? null;
    case 's': return grabOp.RESIZING_S ?? null;
    case 'sw': return grabOp.RESIZING_SW ?? null;
    case 'w': return grabOp.RESIZING_W ?? null;
    case 'nw': return grabOp.RESIZING_NW ?? null;
    default: return null;
    }
}
