/**
 * Resolves the target actor for RoundedClipEffect and the phase strategy that actor implies.
 *
 * A Wayland window's surface container is the target whenever `getSurfaceContainer` can identify
 * it and its geometry is a plain match for the buffer. That identification has three branches
 * (see its definition in `platform/window.js`): a unique non-foreign child, else the unique
 * buffer-compatible one, else fall back. The container's own transform carries the subpixel phase
 * Mutter applies, and an offscreen effect on the container paints its local content, so the phase
 * stays out of the FBO's box rounding; clipping the window actor instead puts the phase in a child
 * transform the FBO cannot keep, which is what leaves a hairline at 1.25x. Foreign widgets (e.g.
 * Blur my Shell) sit beside the container in the same tree, and Mutter's fullscreen background
 * actor is not an St.Widget either, so a tree the rule cannot resolve falls back to the window
 * actor. On X11 the surface is the window actor's first non-foreign child - a foreign widget
 * injected ahead of it is skipped rather than taking the clip - and when no such child exists the
 * window actor is the fallback, never an unverified widget. A container that has not allocated yet
 * defers the choice (`{defer: true}`) so the last good target is kept; a container whose geometry
 * cannot be verified is refused and the window actor is used. The manager watches the container's
 * `notify::allocation` and re-runs this resolution once it settles. Every fallback keeps the phase
 * in a child transform, so the clip folds the window's subpixel offset into its geometry
 * (`clipFrameForTarget`) exactly where the shadow actor carries it as a translation.
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
 * The X11 window actor's real surface actor: its first child that is not foreign.
 *
 * The first child is not automatically the surface: an external extension (e.g. Blur my Shell)
 * can inject an St.Widget ahead of it. The choice reuses `isForeignWidget`, the same predicate
 * the surface-container and phase readers use, so a widget the clip must not attach to is never
 * picked. Returns null when every child is foreign, letting the caller fall back to the window
 * actor rather than an unverified widget.
 *
 * @param {object|null} actor - The window actor
 * @param {object|null} [St]
 * @returns {object|null} The plain surface child, or null
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
 * Resolves the target actor to which RoundedClipEffect should be attached, and whether that
 * actor's own transform carries the buffer's subpixel phase.
 *
 * The container is identified through `getSurfaceContainer`, the same three-branch rule the phase
 * readers use, so the clip can never attach to an actor that `getWindowSubpixelOffset` would
 * refuse to treat as the container: that rule only offers an actor passing the same
 * `isCompatibleSurfaceGeometry` predicate this resolver re-checks.
 *
 * @param {object|null} win
 * @param {object|null} actor
 * @param {object|null} [St]
 * @returns {{actor: object, phaseInTransform: boolean}|{defer: true}|null} The target, a defer
 *          signal when the container is not allocated yet, or null when there is no actor
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
 * Whether a surface container's local box is integer-aligned, so Clutter's derived offscreen
 * origin and size hold.
 *
 * The clip runs offscreen; Clutter sizes that FBO with `_clutter_actor_box_enlarge_for_effects`,
 * whose 2px top/left origin is what that rule yields only on an integer-aligned box. `width`
 * itself is `CLUTTER_NEARBYINT (box->x2 - box->x1)` there, so a fractional local width changes
 * the rounded width and, through `ceilf (x2 + 0.75)`, can move the origin by a whole logical
 * pixel (at 1.25x a fraction in [0.25, 0.5) yields 1 instead of 2) with no constant the shader's
 * FBO_OFFSET could use. Such a container is refused and the clip falls back to the window actor,
 * the same safe direction as a geometry mismatch. See `src/lib/clutterEffectPadding.generated.js`
 * for the upstream rule and the derivation.
 *
 * @param {object|null} candidate
 * @returns {boolean}
 */
export function isIntegerAlignedSurfaceBox(candidate) {
    if (!candidate)
        return false;
    const {width, height} = candidate;
    return Number.isInteger(width) && Number.isInteger(height);
}

/**
 * The subpixel phase the resolved target's path folds into geometry, or null when the fallback
 * monitor scan cannot complete.
 *
 * The container path never needs the mirror: its own transform carries the phase, so the value
 * is ZERO_PHASE by definition. The fallback folds `getWindowSubpixelOffset(win)` into the frame;
 * that reader answers null when a monitor geometry read failed, and the caller then keeps its
 * last good phase rather than jumping to zero.
 *
 * @param {{phaseInTransform: boolean}|null} target - A resolveClipTarget() result
 * @param {object|null} win - Meta.Window behind the target
 * @param {object|null} [St] - The St namespace the target was resolved with
 * @returns {{x: number, y: number}|null}
 */
export function resolveClipPhase(target, win, St = null) {
    if (target?.phaseInTransform)
        return ZERO_PHASE;
    return getWindowSubpixelOffset(win, St);
}

/**
 * The clip's local body frame for a resolved target.
 *
 * Both cuts derive their local edge from `clipFrameFor`; only the phase term differs by path. On
 * the container path the phase is already in the target's own transform, so the frame is
 * phase-free. On the fallback the phase sits in a child transform, so the clip folds
 * `getWindowSubpixelOffset(win)` into its geometry while the shadow actor carries the same
 * offset as a translation - and the two edges still meet on one physical line. `lastPhase` is
 * the caller's previous good phase, used when the scan cannot complete this pass; null is
 * returned only when even that is unavailable, and the caller must not substitute a zero phase.
 *
 * @param {{width: number, height: number}} actorSize - Actor size in logical px
 * @param {import('./frame.js').Insets|null} insets - Ring margins per side
 * @param {number} scale - Physical device scale
 * @param {{phaseInTransform: boolean}|null} target - A resolveClipTarget() result
 * @param {object|null} win - Meta.Window behind the target
 * @param {{x: number, y: number}|null} [lastPhase=null] - The caller's last good phase
 * @param {object|null} [St] - The St namespace the clip target path uses, for the fallback read
 * @returns {{x: number, y: number, width: number, height: number}|null}
 */
export function clipFrameForTarget(actorSize, insets, scale, target, win, lastPhase = null, St = null) {
    const phase = resolveClipPhase(target, win, St) ?? lastPhase;
    if (!phase)
        return null;
    return clipFrameFor(actorSize, insets, scale, phase);
}
