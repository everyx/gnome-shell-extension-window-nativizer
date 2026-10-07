/**
 * The Cogl context the shadow bake builds its pipelines in.
 *
 * Inside a paint pass the context comes from the paint context's framebuffer, which is the only place
 * it is handed to us. That argument is younger than the vfunc: `Clutter.Actor::paint_node` gained it
 * in 47, so on 45-46 the bake has to ask the backend instead.
 *
 * It has to ask through the `Clutter` namespace. The same backend object, reached as
 * `global.backend`, answers `get_cogl_context` with undefined - the method is visible on
 * `Clutter.Backend`'s prototype but not on the wrapper GJS hands back for the Meta backend, measured
 * in the nested shell on 50.5. Asking where it works is cheaper than explaining why it differs.
 *
 * No GI import, so the pure half can be unit-tested without a compositor; the namespace is reached
 * the way `lib/window.js` reaches `Shell`, through the importer the shell leaves on `globalThis`.
 * 51 removed `Clutter.get_default_backend`, which is why this degrades: on that line the paint
 * context is always there, so the fallback is only ever reached before 47.
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
 * @param {object|null} paintContext - The vfunc's argument, absent on 45-46
 * @returns {object|null} A context to bake in, or null when there is none
 */
export function coglContextForBake(paintContext) {
    if (paintContext)
        return paintContext.get_framebuffer().get_context();

    return backendCoglContext(clutterNamespace()?.get_default_backend?.() ?? null);
}
