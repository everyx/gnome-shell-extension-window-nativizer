/**
 * Helper for compositor window resize grab operations on GNOME 50+.
 */

function resolveBackend() {
    const stage = globalThis.global?.stage;
    return stage?.get_context?.()?.get_backend?.() ?? globalThis.global?.backend;
}

/**
 * Resolves the compositor pointer sprite for an event.
 * @param {object|null} event - Clutter.Event
 * @returns {object|null} Pointer sprite or null
 */
export function getPointerSprite(event) {
    const stage = globalThis.global?.stage;
    const backend = resolveBackend();
    return backend?.get_sprite?.(stage, event) ??
        backend?.get_pointer_sprite?.(stage) ?? null;
}

/**
 * Initiates a window resize grab operation using modern sprite signature (GNOME 50+).
 * @param {object} win - Meta.Window instance
 * @param {number} op - Meta.GrabOp
 * @param {object|null} sprite - Pointer sprite
 * @param {number} time - Event timestamp
 * @param {object} posHint - Graphene.Point or coordinate object
 * @returns {boolean} True if the grab operation was dispatched
 */
export function beginWindowGrabOp(win, op, sprite, time, posHint) {
    if (!win?.begin_grab_op || !sprite)
        return false;

    win.begin_grab_op(op, sprite, time, posHint);
    return true;
}
