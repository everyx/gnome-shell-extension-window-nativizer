/**
 * Helper for compositor window resize grab operations on GNOME 50+.
 */

function resolveBackend() {
    const stage = globalThis.global?.stage;
    return stage?.get_context?.()?.get_backend?.() ?? globalThis.global?.backend;
}

/**
 * Resolves the compositor pointer sprite for an event.
 * @param event - Clutter.Event
 * @returns Pointer sprite or null
 */
export function getPointerSprite(event) {
    const stage = globalThis.global?.stage;
    const backend = resolveBackend();
    return backend?.get_sprite?.(stage, event) ??
        backend?.get_pointer_sprite?.(stage) ?? null;
}

/**
 * Initiates a window resize grab operation using modern sprite signature (GNOME 50+).
 * @param win - Meta.Window instance
 * @param op - Meta.GrabOp
 * @param sprite - Pointer sprite
 * @param time - Event timestamp
 * @param posHint - Graphene.Point or coordinate object
 * @returns True if Mutter accepted the grab
 */
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

/**
 * Resolves the compositor Meta.GrabOp for a directional resize.
 * @param direction - 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'
 * @param [meta] - Optional Meta namespace for testing
 * @returns Meta.GrabOp resize op or null
 */
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
