import {findMetaWindow} from './window.js';

/**
 * Returns the active Meta.Display instance, or null.
 * @param {object|null} [customDisplay=null]
 * @returns {object|null}
 */
export function getDisplay(customDisplay = null) {
    return customDisplay ?? globalThis.global?.display ?? null;
}

/**
 * Returns the currently focused Meta.Window, or null.
 * @param {object|null} [display=null]
 * @returns {object|null}
 */
export function getFocusWindow(display = null) {
    try {
        return (display ?? getDisplay())?.focus_window ?? null;
    } catch {
        return null;
    }
}

/**
 * Returns the compositor window_group container, or null.
 * @param {object|null} [customGroup=null]
 * @returns {object|null}
 */
export function getWindowGroup(customGroup = null) {
    return customGroup ?? globalThis.global?.window_group ?? null;
}

/**
 * Returns Meta.MonitorManager from the compositor backend or display, or null.
 * @returns {object|null}
 */
export function getMonitorManager() {
    try {
        return globalThis.global?.backend?.get_monitor_manager?.() ??
            globalThis.global?.display?.get_monitor_manager?.() ?? null;
    } catch {
        return null;
    }
}

/**
 * Returns the count of connected monitors.
 * @returns {number}
 */
export function getMonitorCount() {
    const display = getDisplay();
    try {
        return typeof display?.get_n_monitors === 'function' ? display.get_n_monitors() : 0;
    } catch {
        return 0;
    }
}

/**
 * Reads fractional or integer monitor scale from Meta.Display.
 * @param {number} monitorIndex
 * @returns {number}
 */
export function getMonitorScale(monitorIndex) {
    const display = getDisplay();
    try {
        const nMonitors = typeof display?.get_n_monitors === 'function' ? display.get_n_monitors() : Infinity;
        if (monitorIndex >= 0 && monitorIndex < nMonitors && typeof display?.get_monitor_scale === 'function') {
            const scale = display.get_monitor_scale(monitorIndex);
            if (scale > 0 && Number.isFinite(scale))
                return scale;
        }
    } catch {
        // Display or index went away.
    }
    return 1.0;
}

/**
 * Reads monitor geometry rectangle {x, y, width, height} from Meta.Display.
 * @param {number} monitorIndex
 * @returns {object|null}
 */
export function getMonitorGeometry(monitorIndex) {
    const display = getDisplay();
    try {
        const nMonitors = typeof display?.get_n_monitors === 'function' ? display.get_n_monitors() : Infinity;
        if (monitorIndex >= 0 && monitorIndex < nMonitors && typeof display?.get_monitor_geometry === 'function')
            return display.get_monitor_geometry(monitorIndex);
    } catch {
        return null;
    }
    return null;
}

/**
 * Resolves the true physical monitor scale for a window actor or Meta.Window instance.
 * @param {object|null} actorOrWin - Window actor, child, or Meta.Window instance
 * @param {number} [fallback=1.0]
 * @returns {number} Physical monitor scale
 */
export function getPhysicalMonitorScale(actorOrWin, fallback = 1.0) {
    if (!actorOrWin)
        return fallback;

    const win = findMetaWindow(actorOrWin);
    let monitor = -1;
    if (win) {
        try {
            monitor = typeof win.get_monitor === 'function' ? win.get_monitor() : -1;
        } catch {
            // Deallocated mid-read.
        }
    }

    const display = getDisplay();
    try {
        const nMonitors = typeof display?.get_n_monitors === 'function' ? display.get_n_monitors() : Infinity;
        if (monitor >= 0 && monitor < nMonitors && typeof display?.get_monitor_scale === 'function') {
            const scale = display.get_monitor_scale(monitor);
            if (scale > 0 && Number.isFinite(scale))
                return scale;
        }
    } catch {
        // Rapid topology change.
    }
    return fallback;
}

/**
 * Resolves a window's monitor geometry safely bounding the index.
 * @param {object|null} display - Meta.Display
 * @param {object|null} win - Meta.Window
 * @returns {object|null} Monitor rect, or null
 */
export function resolveMonitorBounds(display, win) {
    const disp = display ?? getDisplay();
    try {
        const nMonitors = typeof disp?.get_n_monitors === 'function' ? disp.get_n_monitors() : Infinity;
        const monitor = typeof win?.get_monitor === 'function' ? win.get_monitor() : -1;
        if (monitor >= 0 && monitor < nMonitors && typeof disp?.get_monitor_geometry === 'function')
            return disp.get_monitor_geometry(monitor);
    } catch {
        // Display or index went stale.
    }
    return null;
}

/**
 * Retrieves the tab list of windows from Meta.Display.
 * Defaults to Meta.TabList.NORMAL_ALL (3).
 * @param {number} [type=3] - Meta.TabList
 * @param {object|null} [workspace=null] - Meta.Workspace or null
 * @returns {Array<object>}
 */
export function getTabList(type = 3, workspace = null) {
    const display = getDisplay();
    try {
        return display?.get_tab_list?.(type, workspace) ?? [];
    } catch {
        return [];
    }
}

/**
 * Focuses a window via Meta.Display.
 * @param {object} win - Meta.Window
 * @param {number} [timestamp=0]
 * @param {object|null} [customDisplay=null]
 */
export function focusWindow(win, timestamp = 0, customDisplay = null) {
    try {
        getDisplay(customDisplay)?.focus_window?.(win, timestamp);
    } catch {
        // Window already gone.
    }
}

/**
 * Repositions an actor above a sibling actor in the compositor window group.
 * @param {object|null} child - Clutter.Actor
 * @param {object|null} sibling - Clutter.Actor
 * @param {object|null} [customGroup=null]
 */
export function setActorAboveSibling(child, sibling, customGroup = null) {
    if (!child || !sibling)
        return;
    try {
        getWindowGroup(customGroup)?.set_child_above_sibling?.(child, sibling);
    } catch {
        // Window group or actors deallocated.
    }
}

/**
 * Repositions an actor below a sibling actor in the compositor window group.
 * @param {object|null} child - Clutter.Actor
 * @param {object|null} sibling - Clutter.Actor
 * @param {object|null} [customGroup=null]
 */
export function setActorBelowSibling(child, sibling, customGroup = null) {
    if (!child || !sibling)
        return;
    try {
        getWindowGroup(customGroup)?.set_child_below_sibling?.(child, sibling);
    } catch {
        // Window group or actors deallocated.
    }
}

/**
 * Returns all window actors currently tracked by the shell.
 * @returns {Array<object>}
 */
export function getWindowActors() {
    try {
        return globalThis.global?.get_window_actors?.() ?? [];
    } catch {
        return [];
    }
}

/**
 * Returns the active workspace index.
 * @returns {number}
 */
export function getActiveWorkspaceIndex() {
    try {
        return globalThis.global?.workspace_manager?.get_active_workspace_index?.() ?? 0;
    } catch {
        return 0;
    }
}

/**
 * Returns the currently active workspace object, or null.
 * @returns {object|null}
 */
export function getActiveWorkspace() {
    try {
        return globalThis.global?.workspace_manager?.get_active_workspace?.() ?? null;
    } catch {
        return null;
    }
}

/**
 * Returns the global Clutter.Stage instance, or null.
 * @returns {object|null}
 */
export function getStage() {
    return globalThis.global?.stage ?? null;
}

/**
 * Returns stage dimensions {width, height}.
 * @returns {{width: number, height: number}}
 */
export function getStageDimensions() {
    try {
        const stage = getStage();
        return {
            width: stage?.width ?? 0,
            height: stage?.height ?? 0,
        };
    } catch {
        return {width: 0, height: 0};
    }
}
