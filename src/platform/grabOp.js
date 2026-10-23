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

/** True only when Mutter accepted the grab: a FALSE return must leave the event propagating. */
export function beginWindowGrabOp(win, op, sprite, time, posHint) {
    if (typeof win?.begin_grab_op !== 'function' || !sprite || op === null || op === undefined)
        return false;

    try {
        return win.begin_grab_op(op, sprite, time, posHint) === true;
    } catch {
        return false;
    }
}

function metaNamespace() {
    try {
        return globalThis.imports?.gi?.Meta ?? null;
    } catch {
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
