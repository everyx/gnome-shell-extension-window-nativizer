/**
 * Pure helper for compositor window resize grab operations.
 *
 * In GNOME 49–51+, win.begin_grab_op takes 4 arguments: (op, sprite, time, pos_hint).
 * In GNOME 45–48, it takes 5 arguments: (op, device, sequence, time, pos_hint).
 * This module transparently invokes the modern 4-arg signature with zero global prototype mutation.
 */

function getPointerDevice() {
    const display = globalThis.global?.display;
    // On GNOME 45–48, display.get_default_seat() provides the pointer device.
    // Clutter.get_default_backend() is a secondary fallback for headless/legacy 45–48
    // environments (dropped in GNOME 51, safely optional-chained and only reached on 45–48).
    const seat = display?.get_default_seat?.() ?? globalThis?.Clutter?.get_default_backend?.()?.get_default_seat?.();
    return seat?.get_pointer?.() ?? null;
}

/**
 * Resolves the compositor pointer sprite for an event across GNOME 45–51.
 * @param {object|null} event - Clutter.Event
 * @returns {object|null} Pointer sprite or null
 */
export function getPointerSprite(event) {
    const stage = globalThis.global?.stage;
    const backend = stage?.get_context?.()?.get_backend?.() ?? globalThis.global?.backend;
    return backend?.get_sprite?.(stage, event) ??
        backend?.get_pointer_sprite?.(stage) ?? null;
}

/**
 * Initiates a window resize grab operation across GNOME 45–51.
 * @param {object} win - Meta.Window instance
 * @param {number} op - Meta.GrabOp
 * @param {object|null} sprite - Pointer sprite (nullable on 45–48, required on 49+)
 * @param {number} time - Event timestamp
 * @param {object} posHint - Graphene.Point or coordinate object
 * @returns {boolean} True if the grab operation was dispatched
 */
export function beginWindowGrabOp(win, op, sprite, time, posHint) {
    if (!win?.begin_grab_op)
        return false;

    // GNOME 45–48: legacy 5-argument signature (op, device, sequence, time, pos_hint).
    // Mutter typelibs on 45–48 declare 5 parameters. We polyfill device and sequence.
    if (win.begin_grab_op.length === 5) {
        const device = getPointerDevice();
        win.begin_grab_op(op, device, null, time, posHint);
        return true;
    }

    // GNOME 49–51+: modern 4-argument signature (op, sprite, time, pos_hint).
    // Mutter requires a valid pointer sprite on 49+.
    if (!sprite)
        return false;

    win.begin_grab_op(op, sprite, time, posHint);
    return true;
}

