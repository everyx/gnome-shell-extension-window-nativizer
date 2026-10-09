/**
 * Helper for compositor window resize grab operations across GNOME 45-51.
 * Dispatches between 4-arg device (GNOME 45), 5-arg hint (GNOME 46-48), and 4-arg sprite (GNOME 49-51) signatures.
 */

/** The compositor backend, resolved the same way for the sprite and the seat. */
function resolveBackend() {
    const stage = globalThis.global?.stage;
    return stage?.get_context?.()?.get_backend?.() ?? globalThis.global?.backend;
}

/**
 * Whether this shell's backend can produce a pointer sprite (GNOME 49+).
 */
function backendHasSpriteApi() {
    const backend = resolveBackend();
    return typeof backend?.get_sprite === 'function' || typeof backend?.get_pointer_sprite === 'function';
}

function getPointerDevice() {
    // Resolves pointer device from backend default seat for GNOME 45-48 grab operations.
    return resolveBackend()?.get_default_seat?.()?.get_pointer?.() ?? null;
}

/**
 * Resolves the compositor pointer sprite for an event across GNOME 45-51.
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
 * Initiates a window resize grab operation across GNOME 45-51.
 * @param {object} win - Meta.Window instance
 * @param {number} op - Meta.GrabOp
 * @param {object|null} sprite - Pointer sprite (null on 45-48, required on 49+)
 * @param {number} time - Event timestamp
 * @param {object} posHint - Graphene.Point or coordinate object
 * @returns {boolean} True if the grab operation was dispatched
 */
export function beginWindowGrabOp(win, op, sprite, time, posHint) {
    if (!win?.begin_grab_op)
        return false;

    // GNOME 49-51: the grab takes a sprite, and only a backend with the sprite API can produce
    // one. Without a sprite there is nothing to hand it, so no grab is started.
    if (backendHasSpriteApi()) {
        if (!sprite)
            return false;
        win.begin_grab_op(op, sprite, time, posHint);
        return true;
    }

    // GNOME 45-48: the grab takes a device and a sequence. 46 added pos_hint, which is the only
    // thing arity separates here - 45 reports four parameters exactly like 49-51 do.
    const device = getPointerDevice();
    if (!device)
        return false;
    if (win.begin_grab_op.length === 5)
        win.begin_grab_op(op, device, null, time, posHint);
    else
        win.begin_grab_op(op, device, null, time);
    return true;
}
