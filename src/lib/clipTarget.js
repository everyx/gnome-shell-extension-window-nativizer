/**
 * Resolves the target actor for RoundedClipEffect.
 *
 * Normal path returns MetaWindowActor (Wayland) or first child (X11).
 * When foreign extensions (e.g. Blur my Shell) inject an St.Widget inside MetaWindowActor,
 * attaching RoundedClipEffect (an offscreen effect) directly to MetaWindowActor isolates
 * the blur widget inside an empty FBO with nothing to sample. This shim bypasses injected
 * St.Widgets to attach to the surface container, provided its coordinate space matches the buffer.
 */

import {WindowClientType} from './mutterRules.generated.js';

const CLIENT_TYPE_X11 = WindowClientType.X11;

/**
 * Checks whether an actor is an injected foreign UI widget (e.g. from Blur my Shell).
 * @param {object|null} child
 * @param {object|null} [St]
 * @returns {boolean}
 */
export function isForeignWidget(child, St = null) {
    if (!child)
        return false;

    const StWidget = St?.Widget ?? globalThis?.St?.Widget;
    if (StWidget && child instanceof StWidget)
        return true;

    const constructorName = child.constructor?.name;
    if (constructorName && (constructorName.startsWith('St_') || constructorName === 'StWidget'))
        return true;

    return false;
}

/**
 * Determines whether the window actor contains foreign injected widgets.
 * @param {object|null} actor
 * @param {object|null} [St]
 * @returns {boolean}
 */
export function hasForeignInjectedWidget(actor, St = null) {
    if (!actor)
        return false;

    // Fast path: Blur my Shell typically inserts its blur actor at index 0 (v72 / main)
    const firstChild = actor.get_first_child?.();
    if (isForeignWidget(firstChild, St))
        return true;

    const children = actor.get_children?.();
    if (!children || children.length <= 1)
        return false;

    return children.some(child => isForeignWidget(child, St));
}

/**
 * Verifies that candidate surface container geometry starts at (0,0) and matches buffer dimensions.
 * @param {object|null} candidate
 * @param {object|null} win
 * @returns {boolean}
 */
export function isCompatibleSurfaceGeometry(candidate, win) {
    if (!candidate || !win)
        return false;

    const buffer = win.get_buffer_rect?.();
    // Fail-open: if buffer cannot be queried yet, defer rejection to subsequent reconcile.
    if (!buffer || !(buffer.width > 0) || !(buffer.height > 0))
        return true;

    const candW = candidate.width;
    const candH = candidate.height;
    const candX = candidate.x ?? 0;
    const candY = candidate.y ?? 0;

    // Fail-open: if candidate has not allocated size yet, accept until allocation settles.
    if (candW === undefined || candH === undefined || candW === 0 || candH === 0)
        return true;

    if (Math.round(candX) !== 0 || Math.round(candY) !== 0 ||
        Math.round(candW) !== Math.round(buffer.width) ||
        Math.round(candH) !== Math.round(buffer.height))
        return false;

    return true;
}

/**
 * Resolves the target actor to which RoundedClipEffect should be attached.
 * @param {object|null} win
 * @param {object|null} actor
 * @param {object|null} [St]
 * @returns {object|null}
 */
export function resolveClipTarget(win, actor, St = null) {
    if (!actor)
        return null;

    const isX11 = win?.get_client_type?.() === CLIENT_TYPE_X11;
    const defaultTarget = isX11 ? actor.get_first_child?.() ?? actor : actor;

    if (!hasForeignInjectedWidget(actor, St))
        return defaultTarget;

    const children = actor.get_children?.() ?? [];
    const surfaceContainer = children.find(child => !isForeignWidget(child, St));

    if (surfaceContainer && !isCompatibleSurfaceGeometry(surfaceContainer, win))
        return defaultTarget;

    return surfaceContainer ?? defaultTarget;
}
