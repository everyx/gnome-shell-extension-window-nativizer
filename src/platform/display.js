
export function getDisplay(customDisplay = null) {
    return customDisplay ?? globalThis.global?.display ?? null;
}

export function getFocusWindow(display = null) {
    try {
        return (display ?? getDisplay())?.focus_window ?? null;
    } catch {
        return null;
    }
}

export function getWindowGroup(customGroup = null) {
    return customGroup ?? globalThis.global?.window_group ?? null;
}

export function getMonitorManager() {
    try {
        return globalThis.global?.backend?.get_monitor_manager?.() ??
            globalThis.global?.display?.get_monitor_manager?.() ?? null;
    } catch {
        return null;
    }
}

/** Default 0 is the historical loop bound; `strict` tells "no monitors" from "could not read". */
export function getMonitorCount({strict = false} = {}) {
    const display = getDisplay();
    try {
        if (typeof display?.get_n_monitors === 'function') {
            const count = display.get_n_monitors();
            if (Number.isFinite(count) && count >= 0)
                return count;
        }
    } catch {
        // No monitor manager on this shell; the caller decides what to do without a count.
    }
    return strict ? null : 0;
}

/** Default 1.0 hides an unreadable scale; `strict` returns null so a caller need not fold it in. */
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
        // Scale is unreadable here, and a guessed scale is worse than none.
    }
    return strict ? null : 1.0;
}

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

/** Bounds win.get_monitor() against the count: a stale index outruns the list after an unplug. */
export function resolveMonitorBounds(display, win) {
    const disp = display ?? getDisplay();
    try {
        const nMonitors = typeof disp?.get_n_monitors === 'function' ? disp.get_n_monitors() : Infinity;
        const monitor = typeof win?.get_monitor === 'function' ? win.get_monitor() : -1;
        if (monitor >= 0 && monitor < nMonitors && typeof disp?.get_monitor_geometry === 'function')
            return disp.get_monitor_geometry(monitor);
    } catch {
        // Geometry is unreadable here; the caller falls back to the frame rect.
    }
    return null;
}

/** 3 is Meta.TabList.NORMAL_ALL; the bare number is that enum's value, not an arbitrary pick. */
export function getTabList(type = 3, workspace = null) {
    const display = getDisplay();
    try {
        return display?.get_tab_list?.(type, workspace) ?? [];
    } catch {
        return [];
    }
}

export function focusWindow(win, timestamp = 0, customDisplay = null) {
    try {
        getDisplay(customDisplay)?.focus_window?.(win, timestamp);
    } catch {
        // Focus is best effort: the window may be gone by the time the call lands.
    }
}

export function setActorAboveSibling(child, sibling, customGroup = null) {
    if (!child || !sibling)
        return;
    try {
        getWindowGroup(customGroup)?.set_child_above_sibling?.(child, sibling);
    } catch {
        // Restacking is best effort; a missing sibling is not worth a failed pass.
    }
}

export function setActorBelowSibling(child, sibling, customGroup = null) {
    if (!child || !sibling)
        return;
    try {
        getWindowGroup(customGroup)?.set_child_below_sibling?.(child, sibling);
    } catch {
        // Restacking is best effort; a missing sibling is not worth a failed pass.
    }
}

export function getWindowActors() {
    try {
        return globalThis.global?.get_window_actors?.() ?? [];
    } catch {
        return [];
    }
}

export function getActiveWorkspaceIndex() {
    try {
        return globalThis.global?.workspace_manager?.get_active_workspace_index?.() ?? 0;
    } catch {
        return 0;
    }
}

/** 1 never over-states: the count sizes how many overview cards a window gets. */
export function getWorkspaceCount() {
    try {
        const count = globalThis.global?.workspace_manager?.n_workspaces ?? 1;
        return count > 0 ? count : 1;
    } catch {
        return 1;
    }
}

export function getActiveWorkspace() {
    try {
        return globalThis.global?.workspace_manager?.get_active_workspace?.() ?? null;
    } catch {
        return null;
    }
}

export function getStage() {
    return globalThis.global?.stage ?? null;
}

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
