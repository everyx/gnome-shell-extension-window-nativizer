/**
 * Resolves the target actor for RoundedClipEffect.
 *
 * Normal Mutter path (zero overhead & zero side effects for standard windows):
 * - Wayland: returns MetaWindowActor (actor)
 * - X11: returns actor's first child (surface actor)
 *
 * Pluggable compatibility shim for foreign extensions (e.g. Blur my Shell):
 * When another extension injects an St.Widget inside MetaWindowActor (e.g. at index 0),
 * attaching an offscreen effect (Shell.GLSLEffect) to MetaWindowActor isolates the
 * blur widget in an empty offscreen FBO with no desktop background to sample, breaking blur.
 * On X11, the blur widget at index 0 is also mistaken for the surface child.
 *
 * When foreign widgets are detected, this shim bypasses injected St.Widgets to locate
 * the actual window surface container, allowing blur and rounding to cleanly coexist.
 * If anything fails or the surface cannot be found, it gracefully falls back to the default target.
 */

import {WindowClientType} from './mutterRules.generated.js';

const CLIENT_TYPE_X11 = WindowClientType.X11;

/**
 * Checks whether an actor is an injected foreign UI widget (e.g. from Blur my Shell).
 * @param {object|null} child
 * @param {object|null} [St] - Optional St namespace
 * @returns {boolean}
 */
export function isForeignWidget(child, St = null) {
    if (!child)
        return false;

    // 1. Exact or subclass check against St.Widget if St namespace is available
    const StWidget = St?.Widget ?? globalThis?.St?.Widget;
    if (StWidget && child instanceof StWidget)
        return true;

    // 2. GJS type name or constructor name heuristic
    const constructorName = child.constructor?.name;
    if (constructorName && (constructorName.startsWith('St_') || constructorName === 'StWidget'))
        return true;

    // 3. Explicit flag (useful for testing mocks)
    if (child.isForeignWidget || child.isWidget)
        return true;

    return false;
}

/**
 * Determines whether the window actor contains foreign injected widgets.
 * Standard Mutter window actors never contain St.Widgets.
 * @param {object|null} actor
 * @param {object|null} [St]
 * @returns {boolean}
 */
export function hasForeignInjectedWidget(actor, St = null) {
    if (!actor)
        return false;

    // Fast path: Blur my Shell always inserts its blur actor at index 0 (first_child)
    const firstChild = actor.get_first_child?.();
    if (isForeignWidget(firstChild, St))
        return true;

    // Only inspect remaining children if there are multiple children
    const children = actor.get_children?.();
    if (!children || children.length <= 1)
        return false;

    return children.some(child => isForeignWidget(child, St));
}

/**
 * Resolves the target actor to which RoundedClipEffect should be attached.
 *
 * @param {object|null} win - Meta.Window
 * @param {object|null} actor - Clutter.Actor (MetaWindowActor)
 * @param {object|null} [St] - Optional St namespace for widget identification
 * @returns {object|null} The resolved target Clutter.Actor
 */
export function resolveClipTarget(win, actor, St = null) {
    if (!actor)
        return null;

    const isX11 = win?.get_client_type?.() === CLIENT_TYPE_X11;
    const defaultTarget = isX11 ? actor.get_first_child?.() ?? actor : actor;

    // Fast path (Zero Side Effects):
    // If no foreign widgets are present, strictly return the normal Mutter target.
    if (!hasForeignInjectedWidget(actor, St))
        return defaultTarget;

    // Compatibility path: Locate the window surface container, skipping injected widgets
    const children = actor.get_children?.() ?? [];
    const surfaceContainer = children.find(child => !isForeignWidget(child, St));

    // Graceful fallback: If surfaceContainer is not found or not ready, fallback to defaultTarget
    return surfaceContainer ?? defaultTarget;
}
