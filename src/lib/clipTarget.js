/** The clip target and the phase strategy it implies: the surface container, else the actor. */

import {WindowClientType} from './mutterRules.generated.js';
import {
    getSurfaceContainer,
    getWindowClientType,
    getWindowSubpixelOffset,
    isCompatibleSurfaceGeometry,
    isForeignWidget,
    isUnallocatedSurfaceBox,
} from '../platform/window.js';
import {clipFrameFor, ZERO_PHASE} from './snap.js';

const CLIENT_TYPE_X11 = WindowClientType.X11;

// Re-exported: the phase readers need these too, and platform may not import from lib/.
export {isCompatibleSurfaceGeometry, isForeignWidget};

/** The first child is not automatically the surface: an extension can inject an St.Widget ahead. */
export function getX11SurfaceChild(actor, St = null) {
    const children = actor?.get_children?.() ?? [];
    return children.find(child => !isForeignWidget(child, St)) ?? null;
}

/** Re-exported from the platform seam, so the resolver's wait case cannot drift from that rule. */
export {isUnallocatedSurfaceBox};

/** The container comes from `getSurfaceContainer`, so clip and phase mirror name one actor. */
export function resolveClipTarget(win, actor, St = null, surfaceContainer = undefined) {
    if (!actor)
        return null;

    const container = surfaceContainer === undefined
        ? getSurfaceContainer(actor, win, St)
        : surfaceContainer;

    const isX11 = getWindowClientType(win) === CLIENT_TYPE_X11;
    // A foreign St.Widget injected ahead of the surface must never take the clip.
    const defaultTarget = isX11 ? getX11SurfaceChild(actor, St) ?? actor : actor;

    if (container) {
        // Unallocated box: defer and keep the last good target; notify::allocation re-runs this.
        if (isUnallocatedSurfaceBox(container))
            return {defer: true};
        if (isCompatibleSurfaceGeometry(container, win) &&
            isIntegerAlignedSurfaceBox(container))
            return {actor: container, phaseInTransform: true};
    }

    return {actor: defaultTarget, phaseInTransform: false};
}

/** Clutter offsets by the parent position, offscreenQuad does not, so only integer boxes agree. */
export function isIntegerAlignedSurfaceBox(candidate) {
    if (!candidate)
        return false;
    const {width, height} = candidate;
    return Number.isInteger(width) && Number.isInteger(height);
}

/** The container transform carries the phase, the fallback folds the mirror; null keeps last. */
export function resolveClipPhase(target, win, St = null) {
    if (target?.phaseInTransform)
        return ZERO_PHASE;
    return getWindowSubpixelOffset(win, St);
}

/** `lastPhase` stands in when the scan cannot complete; never substitute a zero phase. */
export function clipFrameForTarget(actorSize, insets, scale, target, win, lastPhase = null, St = null) {
    const phase = resolveClipPhase(target, win, St) ?? lastPhase;
    if (!phase)
        return null;
    return clipFrameFor(actorSize, insets, scale, phase);
}
