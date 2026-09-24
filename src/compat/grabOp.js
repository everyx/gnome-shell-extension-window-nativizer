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
 * Initiates a window resize grab operation across GNOME 45–51.
 * @param {object} win - Meta.Window instance
 * @param {number} op - Meta.GrabOp
 * @param {object} sprite - Pointer sprite (nullable)
 * @param {number} time - Event timestamp
 * @param {object} posHint - Graphene.Point or coordinate object
 */
export function beginWindowGrabOp(win, op, sprite, time, posHint) {
    if (!win?.begin_grab_op)
        return;

    // GNOME 45–48: legacy 5-argument signature (op, device, sequence, time, pos_hint).
    // Mutter typelibs on 45–48 declare 5 parameters. We polyfill device and sequence.
    if (win.begin_grab_op.length === 5) {
        const device = getPointerDevice();
        win.begin_grab_op(op, device, null, time, posHint);
        return;
    }

    // GNOME 49–51+: modern 4-argument signature (op, sprite, time, pos_hint).
    // Primary default path for current and future GNOME releases.
    win.begin_grab_op(op, sprite, time, posHint);
}
