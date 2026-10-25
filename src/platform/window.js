/** The reads and queries this tree makes of a Meta.Window, one Shell call each. */

import {WindowType} from '../lib/mutterRules.generated.js';
import {getStage} from './display.js';
import {safeRead} from './read.js';

export function isWindowMaximized(win) {
    return safeRead(() => Boolean(win?.is_maximized?.()), false);
}

export function isWindowFullscreen(win) {
    return safeRead(() => Boolean(win?.is_fullscreen?.()), false);
}

export function isWindowMinimized(win) {
    return safeRead(() => Boolean(win?.minimized), false);
}

export function isWindowTiled(win, options = {}) {
    if (!win)
        return false;
    try {
        const isMax = options.isMaximized ?? isWindowMaximized(win);
        if (isMax)
            return false;
        const hasMatch = options.hasTileMatch ?? Boolean(getWindowTileMatch(win));
        const hMax = isWindowMaximizedHorizontally(win);
        const vMax = isWindowMaximizedVertically(win);
        return (hMax !== vMax) || hasMatch;
    } catch {
        return false;
    }
}

export function getWindowFrameRect(win, {throwOnError = false} = {}) {
    try {
        return win?.get_frame_rect?.() ?? null;
    } catch (err) {
        if (throwOnError)
            throw err;
        return null;
    }
}

export function getWindowBufferRect(win, {throwOnError = false} = {}) {
    try {
        return win?.get_buffer_rect?.() ?? null;
    } catch (err) {
        if (throwOnError)
            throw err;
        return null;
    }
}

export function getWindowActor(win) {
    return safeRead(() => win?.get_compositor_private?.(), null);
}


/** Every live preview of a window; `_delegate` names only the last card, not all workspaces. */
export function getOverviewPreviews(win) {
    const found = [];
    const stage = getStage();
    if (!stage || !win)
        return found;

    // Cap the walk: a pathological tree must not turn a settle into a hang.
    const MAX_DEPTH = 16;
    const visit = (actor, depth) => {
        if (!actor || depth > MAX_DEPTH)
            return;
        let children = [];
        try {
            if (actor.metaWindow === win && actor.window_container)
                found.push(actor);
            children = actor.get_children?.() ?? [];
        } catch {
            // A half-destroyed actor: it is not a preview of this pass.
            return;
        }
        for (const child of children)
            visit(child, depth + 1);
    };

    try {
        for (const child of stage.get_children?.() ?? [])
            visit(child, 0);
    } catch {
        // Stage tearing down.
    }
    return found;
}

export function getWindowClientType(win) {
    return safeRead(() => win?.get_client_type?.(), null);
}

export function getWindowType(win) {
    return safeRead(() => win?.get_window_type?.(), WindowType.NORMAL);
}

export function getWindowPid(win) {
    return safeRead(() => win?.get_pid?.(), -1);
}

export function getWindowTransientFor(win) {
    return safeRead(() => win?.get_transient_for?.(), null);
}

export function isWindowAttachedDialog(win) {
    return safeRead(() => Boolean(win?.is_attached_dialog?.()), false);
}

export function isWindowAllowsResize(win) {
    try {
        const value = win?.allows_resize;
        if (typeof value === 'function')
            return Boolean(value.call(win));
        if (typeof value === 'boolean')
            return value;
        return true;
    } catch {
        return true;
    }
}

export function isWindowHidden(win) {
    return safeRead(() => Boolean(win?.is_hidden?.()), false);
}

export function isWindowOnAllWorkspaces(win) {
    return safeRead(() => Boolean(win?.is_on_all_workspaces?.()), false);
}

export function isWindowLocatedOnWorkspace(win, workspace) {
    return safeRead(() => Boolean(win?.located_on_workspace?.(workspace)), false);
}

export function getWindowDisplayTitle(win) {
    return safeRead(() => win?.get_title?.(), '');
}

export function isWindowDecorated(win) {
    return safeRead(() => Boolean(win?.decorated), false);
}

// Cogl's texture component counts; the detector must not read a Cogl value itself.
const COMPONENTS_RGB = 3;
const COMPONENTS_RGBA = 4;

// Per-actor memo: the buffer format is fixed by the client's X11 depth for the actor's whole life.
const actorBufferAlphaCache = new WeakMap();

/** Whether the buffer carries alpha; null when unreadable, since a guess decides the shadow. */
export function getWindowBufferAlpha(win) {
    const actor = getWindowActor(win);
    if (!actor)
        return null;

    const cached = actorBufferAlphaCache.get(actor);
    if (cached !== undefined)
        return cached;

    const alpha = readBufferAlpha(actor);
    if (alpha !== null)
        actorBufferAlphaCache.set(actor, alpha);
    return alpha;
}

/** The shaped texture's first plane, which is the window buffer itself. */
function readBufferAlpha(actor) {
    try {
        const components = actor?.get_texture?.()?.get_texture?.()?.get_plane?.(0)?.get_components?.() ?? null;
        if (components === COMPONENTS_RGBA)
            return true;
        if (components === COMPONENTS_RGB)
            return false;
        return null;
    } catch {
        return null;
    }
}

export function isWindowMaximizedHorizontally(win) {
    return safeRead(() => Boolean(win?.maximized_horizontally), false);
}

export function isWindowMaximizedVertically(win) {
    return safeRead(() => Boolean(win?.maximized_vertically), false);
}

export function isWindowAppearsFocused(win) {
    return safeRead(() => Boolean(win?.appears_focused), false);
}

export function getWindowTileMatch(win) {
    return safeRead(() => win?.get_tile_match?.(), null);
}
