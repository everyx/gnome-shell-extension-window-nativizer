/**
 * Resolves the target actor for RoundedClipEffect and the phase strategy that actor implies.
 *
 * A Wayland window's surface container is the target whenever it can be identified uniquely
 * (`getSurfaceContainer`: exactly one non-foreign child) and its geometry is a plain match for
 * the buffer. The container's own transform carries the subpixel phase Mutter applies, and an
 * offscreen effect on the container paints its local content, so the phase stays out of the
 * FBO's box rounding; clipping the window actor instead puts the phase in a child transform the
 * FBO cannot keep, which is what leaves a hairline at 1.25x. Foreign widgets (e.g. Blur my
 * Shell) sit beside the container in the same tree, and Mutter's fullscreen background actor is
 * not an St.Widget either, so an ambiguous tree fails the uniqueness rule and falls back to the
 * window actor. On X11 the surface is the window actor's first non-foreign child - a foreign
 * widget injected ahead of it is skipped rather than taking the clip - and when no such child
 * exists the window actor is the fallback, never an unverified widget. A container that has not
 * allocated yet defers the choice (`{defer: true}`) so the last good target is kept; a container
 * whose geometry cannot be verified is refused and the window actor is used. The manager watches
 * the container's `notify::allocation` and re-runs this resolution once it settles. Every
 * fallback keeps the phase in a child transform, so the clip folds the window's subpixel offset
 * into its geometry (`clipFrameForTarget`) exactly where the shadow actor carries it as a
 * translation.
 */

import {WindowClientType} from './mutterRules.generated.js';
import {
    getSurfaceContainer,
    getWindowBufferRect,
    getWindowClientType,
    getWindowSubpixelOffset,
    isForeignWidget,
} from '../platform/window.js';
import {clipFrameFor, ZERO_PHASE} from './snap.js';

const CLIENT_TYPE_X11 = WindowClientType.X11;

// The surface-container identity and the foreign-widget test live in the platform seam, because
// the subpixel phase reader needs the same answer and platform may not import from lib/. Kept as
// a re-export so this module's callers and specs still find it here.
export {isForeignWidget};

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
 * Whether a surface container has no allocation yet, so its box cannot be verified. Kept separate
 * from `isCompatibleSurfaceGeometry` because the resolver treats it as the "wait" case (keep the
 * last good target) rather than an incompatibility (fall back to the window actor).
 *
 * @param {object|null} candidate
 * @returns {boolean}
 */
function isUnallocatedSurfaceBox(candidate) {
    const width = candidate?.width;
    const height = candidate?.height;
    return width === undefined || height === undefined || width === 0 || height === 0;
}

/**
 * Verifies that candidate surface container geometry starts at (0,0) and matches buffer dimensions.
 *
 * A geometry that cannot be verified is not accepted. An unreadable buffer is an independent read
 * failure, and an unallocated candidate is the "wait" case the resolver defers (`isUnallocatedSurfaceBox`);
 * both used to fail open, so a container whose box genuinely differs from the buffer - a
 * letterboxed or offset container - could be attached whenever the buffer read happened to fail,
 * and the clip then cut the wrong body. The check exists to reject a coordinate space that
 * genuinely differs, and the resolver's caller re-verifies on the container's `notify::allocation`
 * once the state settles.
 *
 * @param {object|null} candidate
 * @param {object|null} win
 * @returns {boolean}
 */
export function isCompatibleSurfaceGeometry(candidate, win) {
    if (!candidate || !win)
        return false;

    const buffer = getWindowBufferRect(win);
    // An unreadable buffer cannot verify the container's coordinate space; the safe target is the
    // window actor, not an unverified container.
    if (!buffer || !(buffer.width > 0) || !(buffer.height > 0))
        return false;

    const candW = candidate.width;
    const candH = candidate.height;
    const candX = candidate.x ?? 0;
    const candY = candidate.y ?? 0;

    // An unallocated box cannot be verified either; the resolver defers this case separately so it
    // keeps the last good target instead of switching to the window actor.
    if (candW === undefined || candH === undefined || candW === 0 || candH === 0)
        return false;

    // The container path's premise is that the container's local space IS the buffer's: the clip
    // derives its frame with ZERO_PHASE, so a real offset in x/y moves the cut against the shadow's
    // hole by exactly that offset - 0.4 logical px is half a physical pixel at 1.25x, the phase the
    // two cuts are most likely to part on. Only float residue may pass, so the origin is compared
    // against a tolerance instead of being rounded to zero; whether the box is integer-aligned is a
    // separate concern (`isIntegerAlignedSurfaceBox`).
    const ORIGIN_EPSILON = 1e-6;
    if (Math.abs(candX) > ORIGIN_EPSILON || Math.abs(candY) > ORIGIN_EPSILON ||
        Math.abs(candW - buffer.width) > ORIGIN_EPSILON ||
        Math.abs(candH - buffer.height) > ORIGIN_EPSILON)
        return false;

    return true;
}

/**
 * Resolves the target actor to which RoundedClipEffect should be attached, and whether that
 * actor's own transform carries the buffer's subpixel phase.
 *
 * The container is identified through the same rule the phase reader uses (`getSurfaceContainer`
 * requires exactly one non-foreign child), so the clip can never attach to an actor that
 * `getWindowSubpixelOffset` would refuse to treat as the container.
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

    const surfaceContainer = getSurfaceContainer(actor, St);
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
