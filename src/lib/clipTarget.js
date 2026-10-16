/**
 * Resolves the target actor for RoundedClipEffect and the phase strategy that actor implies: the Wayland
 * surface container when `getSurfaceContainer` can identify it and its geometry matches the buffer, else
 * the window actor. On X11 it is the first non-foreign child. An unresolved container defers rather than
 * guessing.
 */

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

// The surface-container identity and the compatibility and foreign-widget predicates live in the
// platform seam, because the phase readers need the same answers and platform may not import from
// lib/. Re-exported so this module's callers and specs still find them here.
export {isCompatibleSurfaceGeometry, isForeignWidget};

/**
 * The X11 window actor's real surface actor: its first non-foreign child. The first child is not
 * automatically the surface - an external extension can inject an St.Widget ahead of it - so the
 * same `isForeignWidget` predicate the other readers use decides. Null when every child is foreign.
 */
export function getX11SurfaceChild(actor, St = null) {
    const children = actor?.get_children?.() ?? [];
    return children.find(child => !isForeignWidget(child, St)) ?? null;
}

/**
 * Whether a surface container has no allocation yet, so its box cannot be verified. Re-exported
 * from the platform seam so the resolver's "wait" case and the identity rule cannot drift.
 */
export {isUnallocatedSurfaceBox};

/**
 * Resolves the target actor to attach RoundedClipEffect to, and whether its own transform carries
 * the buffer's subpixel phase. The container comes from `getSurfaceContainer`, the same rule the
 * phase readers use, so the clip and the mirror can never name different actors.
 */
export function resolveClipTarget(win, actor, St = null) {
    if (!actor)
        return null;

    const isX11 = getWindowClientType(win) === CLIENT_TYPE_X11;
    // On X11 the surface actor is the first non-foreign child, not blindly the first child: a
    // foreign St.Widget injected ahead of it must never take the clip.
    const defaultTarget = isX11 ? getX11SurfaceChild(actor, St) ?? actor : actor;

    const surfaceContainer = getSurfaceContainer(actor, win, St);
    if (surfaceContainer) {
        // The container has no allocation yet: its box cannot be verified, so defer the choice and
        // keep the last good target rather than attach the clip to an unverified actor. The manager
        // watches this container's notify::allocation and re-runs the resolution once it settles.
        if (isUnallocatedSurfaceBox(surfaceContainer))
            return {defer: true};
        if (isCompatibleSurfaceGeometry(surfaceContainer, win) &&
            isIntegerAlignedSurfaceBox(surfaceContainer))
            return {actor: surfaceContainer, phaseInTransform: true};
    }

    return {actor: defaultTarget, phaseInTransform: false};
}

/**
 * Whether a surface container's local box is integer-aligned, so Clutter's derived offscreen origin
 * and size hold. Clutter's `_clutter_actor_box_enlarge_for_effects` yields the shader's constant
 * origin only on an integer box; a fractional one can move it a logical pixel, which no constant
 * could express. Refused, the clip falls back to the window actor, as for a geometry mismatch.
 */
export function isIntegerAlignedSurfaceBox(candidate) {
    if (!candidate)
        return false;
    const {width, height} = candidate;
    return Number.isInteger(width) && Number.isInteger(height);
}

/**
 * The subpixel phase the resolved target's path folds into geometry. The container path never needs
 * the mirror - its own transform carries the phase, so it is ZERO_PHASE - while the fallback folds
 * `getWindowSubpixelOffset`. Null when that scan cannot complete; the caller keeps its last good
 * phase rather than jumping to zero.
 */
export function resolveClipPhase(target, win, St = null) {
    if (target?.phaseInTransform)
        return ZERO_PHASE;
    return getWindowSubpixelOffset(win, St);
}

/**
 * The clip's local frame for a resolved target. Both cuts derive their edge from `clipFrameFor`;
 * the phase term differs by path - phase-free on the container, the folded mirror on the fallback
 * while the shadow carries the same offset as a translation. `lastPhase` stands in when the scan
 * cannot complete; the caller must never substitute a zero phase.
 */
export function clipFrameForTarget(actorSize, insets, scale, target, win, lastPhase = null, St = null) {
    const phase = resolveClipPhase(target, win, St) ?? lastPhase;
    if (!phase)
        return null;
    return clipFrameFor(actorSize, insets, scale, phase);
}
