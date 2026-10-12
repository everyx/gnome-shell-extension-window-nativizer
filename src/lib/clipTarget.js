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
 * exists the window actor is the fallback, never an unverified widget. Every fallback keeps the
 * phase in a child transform, so the clip folds the window's subpixel offset into its geometry
 * (`clipFrameForTarget`) exactly where the shadow actor carries it as a translation.
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
 * Verifies that candidate surface container geometry starts at (0,0) and matches buffer dimensions.
 *
 * The two unreadable cases fail open on purpose. The container is the only target whose own
 * transform carries the phase, so rejecting it on a transient state - a buffer not yet readable,
 * or a Clutter actor not yet allocated - would drop the phase guarantee for as long as the state
 * lasts. The check exists to reject a coordinate space that genuinely differs (a letterboxed
 * container offset, or a size that does not match the buffer), and those are stable; the next
 * reconcile re-runs the check once the window settles.
 *
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
 * @returns {{actor: object, phaseInTransform: boolean}|null}
 */
export function resolveClipTarget(win, actor, St = null) {
    if (!actor)
        return null;

    const isX11 = getWindowClientType(win) === CLIENT_TYPE_X11;
    // On X11 the surface actor is the first non-foreign child, not blindly the first child: a
    // foreign St.Widget injected ahead of it must never take the clip.
    const defaultTarget = isX11 ? getX11SurfaceChild(actor, St) ?? actor : actor;

    const surfaceContainer = getSurfaceContainer(actor, St);
    if (surfaceContainer && isCompatibleSurfaceGeometry(surfaceContainer, win) &&
        isIntegerAlignedSurfaceBox(surfaceContainer))
        return {actor: surfaceContainer, phaseInTransform: true};

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
 * The clip's local body frame for a resolved target.
 *
 * Both cuts derive their local edge from `clipFrameFor`; only the phase term differs by path. On
 * the container path the phase is already in the target's own transform, so the frame is
 * phase-free. On the fallback the phase sits in a child transform, so the clip folds
 * `getWindowSubpixelOffset(win)` into its geometry while the shadow actor carries the same
 * offset as a translation - and the two edges still meet on one physical line.
 *
 * @param {{width: number, height: number}} actorSize - Actor size in logical px
 * @param {import('./frame.js').Insets|null} insets - Ring margins per side
 * @param {number} scale - Physical device scale
 * @param {{phaseInTransform: boolean}|null} target - A resolveClipTarget() result
 * @param {object|null} win - Meta.Window behind the target
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function clipFrameForTarget(actorSize, insets, scale, target, win) {
    const phase = target?.phaseInTransform ? ZERO_PHASE : getWindowSubpixelOffset(win);
    return clipFrameFor(actorSize, insets, scale, phase);
}
