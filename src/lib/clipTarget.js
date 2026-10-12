/**
 * Resolves target actor for RoundedClipEffect.
 *
 * A Wayland window's surface container is the target whenever its geometry is a plain match for
 * the buffer. The container's own transform carries the subpixel phase Mutter applies, and an
 * offscreen effect on the container paints its local content, so the phase stays out of the
 * FBO's box rounding; clipping the window actor instead puts the phase in a child transform the
 * FBO cannot keep, which is what leaves a hairline at 1.25x. Foreign widgets (e.g. Blur my
 * Shell) sit beside the container in the same tree, so the same non-foreign child is chosen
 * either way; an X11 surface is already the window actor's first child and is returned by the
 * default path. Anything unreadable or geometrically incompatible falls back to the window
 * actor, which still rounds the corners, just without the subpixel guarantee.
 */

import {WindowClientType} from './mutterRules.generated.js';
import {getWindowBufferRect, getWindowClientType, isForeignWidget} from '../platform/window.js';

const CLIENT_TYPE_X11 = WindowClientType.X11;

// The surface-container identity and the foreign-widget test live in the platform seam, because
// the subpixel phase reader needs the same answer and platform may not import from lib/. Kept as
// a re-export so this module's callers and specs still find it here.
export {isForeignWidget};

/**
 * Verifies that candidate surface container geometry starts at (0,0) and matches buffer dimensions.
 * @param {object|null} candidate
 * @param {object|null} win
 * @returns {boolean}
 */
export function isCompatibleSurfaceGeometry(candidate, win) {
    if (!candidate || !win)
        return false;

    const buffer = getWindowBufferRect(win);
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

    const isX11 = getWindowClientType(win) === CLIENT_TYPE_X11;
    const defaultTarget = isX11 ? actor.get_first_child?.() ?? actor : actor;

    const children = actor.get_children?.();
    if (!children || children.length === 0)
        return defaultTarget;

    const surfaceContainer = children.find(child => !isForeignWidget(child, St));
    if (!surfaceContainer || !isCompatibleSurfaceGeometry(surfaceContainer, win))
        return defaultTarget;

    return surfaceContainer;
}
