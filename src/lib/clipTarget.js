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
 * window actor; an X11 surface is already the window actor's first child and is returned by the
 * default path. Every fallback keeps the phase in a child transform, so the clip folds the
 * window's subpixel offset into its geometry (`clipFrameForTarget`) exactly where the shadow
 * actor carries it as a translation.
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

    if (Math.round(candX) !== 0 || Math.round(candY) !== 0 ||
        Math.round(candW) !== Math.round(buffer.width) ||
        Math.round(candH) !== Math.round(buffer.height))
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
    const defaultTarget = isX11 ? actor.get_first_child?.() ?? actor : actor;

    const surfaceContainer = getSurfaceContainer(actor, St);
    if (surfaceContainer && isCompatibleSurfaceGeometry(surfaceContainer, win))
        return {actor: surfaceContainer, phaseInTransform: true};

    return {actor: defaultTarget, phaseInTransform: false};
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
