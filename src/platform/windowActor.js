/** Resolving an actor back to the Meta.Window behind it, with the cache the paint clock needs. */

import {safeRead} from './read.js';

export function getTrackedAppId(win) {
    // WindowTracker is unusable while the session is tearing down.
    return safeRead(() => {
        const Shell = globalThis.imports?.gi?.Shell ?? null;
        return Shell?.WindowTracker?.get_default()?.get_window_app(win)?.get_id?.() ?? '';
    }, '');
}

/** Meta.Window from an actor, trying `meta_window`, `metaWindow`, then `get_meta_window()`. */
export function getWindowFromActor(actor) {
    if (!actor)
        return null;
    return safeRead(() => actor.meta_window ?? actor.metaWindow ?? actor.get_meta_window?.(), null);
}

export function findMetaWindow(actorOrWin, maxDepth = 8) {
    if (!actorOrWin)
        return null;
    if (typeof actorOrWin.get_monitor === 'function' && typeof actorOrWin.get_parent !== 'function')
        return actorOrWin;
    try {
        let curr = actorOrWin;
        for (let depth = 0; curr && depth < maxDepth; depth++) {
            const win = getWindowFromActor(curr) ?? getWindowFromActor(curr._windowActor);
            if (win)
                return win;
            curr = typeof curr.get_parent === 'function' ? curr.get_parent() : null;
        }
    } catch {
        // Actor partially deallocated during window teardown.
    }
    return null;
}

// Per-actor memo for the paint path; a null read is not stored, so a later attach still resolves.
const actorWindowCache = new WeakMap();

export function findMetaWindowCached(actor) {
    if (!actor)
        return null;
    const cached = actorWindowCache.get(actor);
    if (cached !== undefined)
        return cached;
    const win = findMetaWindow(actor);
    if (win)
        actorWindowCache.set(actor, win);
    return win;
}
