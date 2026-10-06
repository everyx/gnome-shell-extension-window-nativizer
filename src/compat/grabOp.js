/**
 * Pure helper for compositor window resize grab operations.
 *
 * win.begin_grab_op has three shapes upstream, not two: 45 takes four arguments
 * (op, device, sequence, time); 46-48 takes five, adding pos_hint; 49-51 takes four again
 * (op, sprite, time, pos_hint). Arity separates 46-48 from the other two but cannot separate 45
 * from 49-51 - both report four - so the dispatch asks a second question: whether the backend can
 * hand out a pointer sprite at all. Clutter.Backend gained get_sprite/get_pointer_sprite in 49, the
 * same release the grab started taking one, which is what tells 45 apart from 49-51.
 *
 * Everything here is a pure function over globals the shell provides, with zero global prototype
 * mutation, which is what lets the unit tests cover all three signatures on one machine.
 */

/** The compositor backend, resolved the same way for the sprite and the seat. */
function resolveBackend() {
    const stage = globalThis.global?.stage;
    return stage?.get_context?.()?.get_backend?.() ?? globalThis.global?.backend;
}

/**
 * Whether this shell's backend can produce a pointer sprite. GNOME 49 added
 * Clutter.Backend.get_sprite and get_pointer_sprite, and the grab operation started taking a sprite
 * in the same release.
 */
function backendHasSpriteApi() {
    const backend = resolveBackend();
    return typeof backend?.get_sprite === 'function' || typeof backend?.get_pointer_sprite === 'function';
}

function getPointerDevice() {
    // The seat hangs off the same backend the sprite API does, and this path is only reached on
    // 45-48, where that backend declares get_default_seat and its seat declares get_pointer. Asking
    // the display is not an option: Meta.Display declares no get_default_seat in any of 45-51. Nor
    // is the old globalThis.Clutter.get_default_backend() fallback: the shell never puts Clutter on
    // the JS global namespace - environment.js adds only global/_/C_/ngettext/N_ - so it resolved
    // nothing (the Clutter namespace function itself exists through 50 and is dropped in 51).
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
