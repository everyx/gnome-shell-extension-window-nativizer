import {findMetaWindow} from './window.js';

/**
 * Returns the active Meta.Display instance, or null.
 */
export function getDisplay(customDisplay = null) {
    return customDisplay ?? globalThis.global?.display ?? null;
}

/**
 * Returns the currently focused Meta.Window, or null.
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
 */
export function getWindowGroup(customGroup = null) {
    return customGroup ?? globalThis.global?.window_group ?? null;
}

/**
 * Returns Meta.MonitorManager from the compositor backend or display, or null.
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
 * Returns the count of connected monitors. The historical default is 0, which callers that only
 * want a loop bound keep; a caller that must tell "no monitors" from "could not read" passes
 * `strict` and gets null. See `resolveHighestScaleMonitorIndex`.
 */
export function getMonitorCount({strict = false} = {}) {
    const display = getDisplay();
    try {
        if (typeof display?.get_n_monitors === 'function') {
            const count = display.get_n_monitors();
            if (Number.isFinite(count) && count >= 0)
                return count;
        }
    } catch {
        // Display went away.
    }
    return strict ? null : 0;
}

/**
 * Reads fractional or integer monitor scale from Meta.Display. The historical default is 1.0 (an
 * integer scale); a caller that must not fold an unreadable scale into 1.0 passes `strict` and gets
 * null. Same shape as `getWindowFrameRect`'s `throwOnError`: one read, two failure modes.
 */
export function getMonitorScale(monitorIndex, {strict = false} = {}) {
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
    return strict ? null : 1.0;
}

/**
 * Reads monitor geometry rectangle {x, y, width, height} from Meta.Display.
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
 * Resolves the true physical monitor scale for a window actor or Meta.Window, or null when it cannot
 * be read - no actor, no window, a stale index, a throwing display. It drives the clip cut, the
 * shadow cutout, the resize band and the crisp-text decision, so a wrong integer would move an
 * already-correct display; each consumer degrades on null.
 */
export function getPhysicalMonitorScale(actorOrWin) {
    if (!actorOrWin)
        return null;

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
    return null;
}

/**
 * Resolves a window's monitor geometry safely bounding the index.
 * @param display - Meta.Display
 * @param win - Meta.Window
 * @returns Monitor rect, or null
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
 * @param [type=3] - Meta.TabList
 * @param [workspace=null] - Meta.Workspace or null
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
 * @param win - Meta.Window
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
 * @param child - Clutter.Actor
 * @param sibling - Clutter.Actor
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
 * @param child - Clutter.Actor
 * @param sibling - Clutter.Actor
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
 */
export function getActiveWorkspaceIndex() {
    try {
        return globalThis.global?.workspace_manager?.get_active_workspace_index?.() ?? 0;
    } catch {
        return 0;
    }
}

/**
 * Returns the number of workspaces, or 1 when the read is unavailable.
 *
 * One is the answer that never over-states what a window can have: the count is used to size the
 * set of overview previews a window on all workspaces must have, and an unknown count must not
 * turn into a promise of more cards than exist.
 */
export function getWorkspaceCount() {
    try {
        const count = globalThis.global?.workspace_manager?.n_workspaces ?? 1;
        return count > 0 ? count : 1;
    } catch {
        return 1;
    }
}

/**
 * Returns the currently active workspace object, or null.
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
 */
export function getStage() {
    return globalThis.global?.stage ?? null;
}

/**
 * Returns stage dimensions {width, height}.
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
