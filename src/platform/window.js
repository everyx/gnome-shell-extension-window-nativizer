/**
 * Window-level Shell and Mutter API operations and queries for GNOME 50+.
 */

import {WindowType} from '../lib/mutterRules.generated.js';

/**
 * Extracts the Meta.Window instance from a MetaWindowActor across Mutter property name
 * variations: `meta_window` (current), `metaWindow`, then the `get_meta_window()`
 * modern method. A getter may throw on a half-destroyed actor, which must not escape.
 *
 * @param {object|null} actor
 * @returns {object|null} Meta.Window or null
 */
export function getWindowFromActor(actor) {
    if (!actor)
        return null;
    try {
        return actor.meta_window ?? actor.metaWindow ?? actor.get_meta_window?.() ?? null;
    } catch {
        return null;
    }
}

/**
 * Resolves the enclosing MetaWindow from a window actor, child container, or Meta.Window instance.
 *
 * @param {object|null} actorOrWin - Window actor, child, or Meta.Window instance
 * @param {number} [maxDepth=8]
 * @returns {object|null} MetaWindow instance if found
 */
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

/**
 * Checks if the window is fully maximized (GNOME 50+).
 * @param {object|null} win - Meta.Window
 * @returns {boolean}
 */
export function isWindowMaximized(win) {
    try {
        return Boolean(win?.is_maximized?.());
    } catch {
        return false;
    }
}

/**
 * Checks if the window is fullscreen.
 * @param {object|null} win - Meta.Window
 * @returns {boolean}
 */
export function isWindowFullscreen(win) {
    try {
        return Boolean(win?.is_fullscreen?.());
    } catch {
        return false;
    }
}

/**
 * Checks if the window is minimized.
 * @param {object|null} win - Meta.Window
 * @returns {boolean}
 */
export function isWindowMinimized(win) {
    try {
        return Boolean(win?.minimized);
    } catch {
        return false;
    }
}

/**
 * Checks if the window is tiled (split half, edge tile, or tile matched).
 * @param {object|null} win - Meta.Window
 * @param {object} [options={}]
 * @param {boolean} [options.isMaximized]
 * @param {boolean} [options.hasTileMatch]
 * @returns {boolean}
 */
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

/**
 * Reads the window frame rectangle in logical coords, or null if destroyed/inaccessible.
 * @param {object|null} win - Meta.Window
 * @param {object} [options={}]
 * @param {boolean} [options.throwOnError=false]
 * @returns {object|null} Frame rect {x, y, width, height} or null
 */
export function getWindowFrameRect(win, {throwOnError = false} = {}) {
    try {
        return win?.get_frame_rect?.() ?? null;
    } catch (err) {
        if (throwOnError)
            throw err;
        return null;
    }
}

/**
 * Reads the window buffer rectangle in logical coords, or null if destroyed/inaccessible.
 * @param {object|null} win - Meta.Window
 * @param {object} [options={}]
 * @param {boolean} [options.throwOnError=false]
 * @returns {object|null} Buffer rect {x, y, width, height} or null
 */
export function getWindowBufferRect(win, {throwOnError = false} = {}) {
    try {
        return win?.get_buffer_rect?.() ?? null;
    } catch (err) {
        if (throwOnError)
            throw err;
        return null;
    }
}

/**
 * Resolves the underlying compositor window actor (MetaWindowActor).
 * @param {object|null} win - Meta.Window
 * @returns {object|null} Window actor or null
 */
export function getWindowActor(win) {
    try {
        return win?.get_compositor_private?.() ?? null;
    } catch {
        return null;
    }
}

/**
 * Reads the Meta.WindowClientType (Wayland or X11).
 * @param {object|null} win - Meta.Window
 * @returns {number|null} Meta.WindowClientType or null
 */
export function getWindowClientType(win) {
    try {
        return win?.get_client_type?.() ?? null;
    } catch {
        return null;
    }
}

/**
 * Reads the window type (Meta.WindowType), defaulting to NORMAL.
 * @param {object|null} win - Meta.Window
 * @returns {number} Meta.WindowType
 */
export function getWindowType(win) {
    try {
        return win?.get_window_type?.() ?? WindowType.NORMAL;
    } catch {
        return WindowType.NORMAL;
    }
}

/**
 * Reads the owning process id.
 * @param {object|null} win - Meta.Window
 * @returns {number} PID or -1
 */
export function getWindowPid(win) {
    try {
        return win?.get_pid?.() ?? -1;
    } catch {
        return -1;
    }
}

/**
 * Reads the window's transient parent window if one exists.
 * @param {object|null} win - Meta.Window
 * @returns {object|null} Parent Meta.Window or null
 */
export function getWindowTransientFor(win) {
    try {
        return win?.get_transient_for?.() ?? null;
    } catch {
        return null;
    }
}

/**
 * Checks whether the window is an attached modal dialog.
 * @param {object|null} win - Meta.Window
 * @returns {boolean}
 */
export function isWindowAttachedDialog(win) {
    try {
        return Boolean(win?.is_attached_dialog?.());
    } catch {
        return false;
    }
}

/**
 * Checks whether the window allows resizing.
 * @param {object|null} win - Meta.Window
 * @returns {boolean}
 */
export function isWindowAllowsResize(win) {
    try {
        return win?.allows_resize ? Boolean(win.allows_resize()) : true;
    } catch {
        return true;
    }
}

/**
 * Checks whether the window is currently hidden by Mutter.
 * @param {object|null} win - Meta.Window
 * @returns {boolean}
 */
export function isWindowHidden(win) {
    try {
        return Boolean(win?.is_hidden?.());
    } catch {
        return false;
    }
}

/**
 * Checks whether the window is present on all workspaces.
 * @param {object|null} win - Meta.Window
 * @returns {boolean}
 */
export function isWindowOnAllWorkspaces(win) {
    try {
        return Boolean(win?.is_on_all_workspaces?.());
    } catch {
        return false;
    }
}

/**
 * Checks whether the window is located on a specific workspace.
 * @param {object|null} win - Meta.Window
 * @param {object} workspace - Meta.Workspace
 * @returns {boolean}
 */
export function isWindowLocatedOnWorkspace(win, workspace) {
    try {
        return Boolean(win?.located_on_workspace?.(workspace));
    } catch {
        return false;
    }
}

/**
 * Reads the window's display title, returning empty string if unreadable.
 * @param {object|null} win - Meta.Window
 * @returns {string}
 */
export function getWindowDisplayTitle(win) {
    try {
        return win?.get_title?.() ?? '';
    } catch {
        return '';
    }
}

/**
 * Checks whether the window is decorated by SSD (decorated property).
 * @param {object|null} win - Meta.Window
 * @returns {boolean}
 */
export function isWindowDecorated(win) {
    try {
        return Boolean(win?.decorated);
    } catch {
        return false;
    }
}

/**
 * Checks whether the window is horizontally maximized.
 * @param {object|null} win - Meta.Window
 * @returns {boolean}
 */
export function isWindowMaximizedHorizontally(win) {
    try {
        return Boolean(win?.maximized_horizontally);
    } catch {
        return false;
    }
}

/**
 * Checks whether the window is vertically maximized.
 * @param {object|null} win - Meta.Window
 * @returns {boolean}
 */
export function isWindowMaximizedVertically(win) {
    try {
        return Boolean(win?.maximized_vertically);
    } catch {
        return false;
    }
}

/**
 * Checks whether the window appears focused.
 * @param {object|null} win - Meta.Window
 * @returns {boolean}
 */
export function isWindowAppearsFocused(win) {
    try {
        return Boolean(win?.appears_focused);
    } catch {
        return false;
    }
}

/**
 * Resolves the matching tile window if one exists.
 * @param {object|null} win - Meta.Window
 * @returns {object|null} Meta.Window or null
 */
export function getWindowTileMatch(win) {
    try {
        return win?.get_tile_match?.() ?? null;
    } catch {
        return null;
    }
}

