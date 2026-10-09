/**
 * Resolves CoglContext for shadow texture baking across GNOME 45-51.
 * Prefers paintContext framebuffer (GNOME 47+), falling back to Clutter.Backend (GNOME 45-46).
 */

/** @returns {object|null} The Clutter namespace, or null outside a shell */
function clutterNamespace() {
    try {
        return globalThis.imports?.gi?.Clutter ?? null;
    } catch {
        return null;
    }
}

/**
 * The backend's context. Separated from the lookup below because `Clutter.get_default_backend()`
 * refuses to answer outside a running shell - a test that reached it would take the process down
 * with it, so only this half is assertable.
 * @param {object|null} backend
 * @returns {object|null}
 */
export function backendCoglContext(backend) {
    return backend?.get_cogl_context?.() ?? null;
}

/**
 * @param {object|null} paintContext - The vfunc's argument, absent on 46
 * @returns {object|null} A context to bake in, or null when there is none
 */
export function coglContextForBake(paintContext) {
    if (paintContext)
        return paintContext.get_framebuffer().get_context();

    return backendCoglContext(clutterNamespace()?.get_default_backend?.() ?? null);
}
