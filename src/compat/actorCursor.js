/**
 * Pure helper for setting hover cursor on Clutter actors.
 *
 * In Clutter 50–51+, Clutter.Actor provides `set_cursor_type(cursorType)`.
 * On older Clutter (< 50), per-actor cursor type is not available and gracefully no-ops.
 * Zero global prototype mutation.
 */

/**
 * Sets the cursor type on an actor if supported.
 * @param {object|null} actor - Clutter.Actor instance
 * @param {number} cursorType - Clutter.CursorType enum value
 */
export function setActorCursor(actor, cursorType) {
    actor?.set_cursor_type?.(cursorType);
}
