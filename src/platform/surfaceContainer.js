/** Which actor under a window paints its surface: an inference over the actor tree, not an accessor. */

import {getWindowActor, getWindowBufferRect} from './window.js';

/** Every preview clone paints through this container; a clone overrides only actor opacity. */
export function getWindowSurfaceContainer(win) {
    return getSurfaceContainer(getWindowActor(win), win, null);
}

/** Whether an actor is an injected foreign widget (the platform layer may not import `lib/`). */
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

/** Whether a container has no allocation yet; the resolver reads that as wait, not incompatible. */
export function isUnallocatedSurfaceBox(candidate) {
    if (!candidate)
        return false;
    const width = candidate.width;
    const height = candidate.height;
    // Only an actor exposing a box is a candidate; an unnamed injected widget has no width/height.
    if (width === undefined && height === undefined)
        return false;
    return width === undefined || height === undefined || width === 0 || height === 0;
}

/** Whether a box matches the buffer's dimensions, ignoring where it sits. */
function hasBufferDimensions(candidate, win) {
    if (!candidate || !win)
        return false;

    const buffer = getWindowBufferRect(win);
    if (!buffer || !(buffer.width > 0) || !(buffer.height > 0))
        return false;

    const candW = candidate.width;
    const candH = candidate.height;
    if (candW === undefined || candH === undefined || candW === 0 || candH === 0)
        return false;

    const EPSILON = 1e-6;
    return Math.abs(candW - buffer.width) <= EPSILON &&
        Math.abs(candH - buffer.height) <= EPSILON;
}

/** Whether a container sits at (0,0) at the buffer's size; unverifiable is rejected outright. */
export function isCompatibleSurfaceGeometry(candidate, win) {
    if (!hasBufferDimensions(candidate, win))
        return false;

    // The clip reads this box as the buffer's own space, so an offset shifts the cut by that much.
    const ORIGIN_EPSILON = 1e-6;
    return Math.abs(candidate.x ?? 0) <= ORIGIN_EPSILON &&
        Math.abs(candidate.y ?? 0) <= ORIGIN_EPSILON;
}

/** The Wayland surface container from the actor tree; an ambiguous tree answers null. */
export function getSurfaceContainer(actor, win, St = null) {
    try {
        const children = actor?.get_children?.() ?? [];
        const nonForeign = children.filter(child => !isForeignWidget(child, St));
        if (nonForeign.length === 1)
            return nonForeign[0];

        // An unallocated child may be the real container; returning it makes the resolver wait.
        const unallocated = nonForeign.find(isUnallocatedSurfaceBox);
        if (unallocated)
            return unallocated;

        const compatible = nonForeign.filter(child => isCompatibleSurfaceGeometry(child, win));
        if (compatible.length !== 1)
            return null;

        // Another child is buffer-sized but off-origin: maybe the container mid-move, so fall back.
        if (nonForeign.some(child =>
            child !== compatible[0] && hasBufferDimensions(child, win)))
            return null;

        return compatible[0];
    } catch {
        return null;
    }
}

/** Children covering the box: a second actor there paints corners the mask cannot round. */
export function countSurfaceActorsCoveringBox(container, St = null) {
    try {
        const box = actorBox(container);
        if (!box)
            return 0;
        let covering = 0;
        for (const child of container.get_children?.() ?? []) {
            if (!isForeignWidget(child, St) && coversBox(actorBox(child), box))
                covering++;
        }
        return covering;
    } catch {
        // A half-destroyed actor tree: no reading this pass.
        return 0;
    }
}

/** An actor's allocation as a box, or null when it carries no positive size. */
function actorBox(actor) {
    const {x = 0, y = 0, width = 0, height = 0} = actor ?? {};
    if (!(width > 0) || !(height > 0))
        return null;
    return {x, y, width, height};
}

/** Whether a child's box contains `box` on all four sides. */
function coversBox(candidate, box) {
    if (!candidate)
        return false;
    const EPSILON = 1e-6;
    return candidate.x <= box.x + EPSILON &&
        candidate.y <= box.y + EPSILON &&
        candidate.x + candidate.width >= box.x + box.width - EPSILON &&
        candidate.y + candidate.height >= box.y + box.height - EPSILON;
}
