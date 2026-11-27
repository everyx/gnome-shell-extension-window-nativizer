
export function getDisplay(customDisplay = null) {
    return customDisplay ?? globalThis.global?.display ?? null;
}

export function getFocusWindow(display = null) {
    try {
        return (display ?? getDisplay())?.focus_window ?? null;
    } catch {
        // Focus may be unreachable during shell startup or teardown.
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
        // Absent outside a live shell session (e.g. unit tests).
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

function isValidMonitorIndex(display, monitorIndex) {
    const nMonitors = typeof display?.get_n_monitors === 'function' ? display.get_n_monitors() : Infinity;
    return monitorIndex >= 0 && monitorIndex < nMonitors;
}

function readMonitorGeometry(display, monitorIndex) {
    if (!isValidMonitorIndex(display, monitorIndex) || typeof display?.get_monitor_geometry !== 'function')
        return null;
    return display.get_monitor_geometry(monitorIndex);
}

/** Default 1.0 hides an unreadable scale; `strict` returns null so a caller need not fold it in. */
export function getMonitorScale(monitorIndex, {strict = false} = {}) {
    const display = getDisplay();
    try {
        if (isValidMonitorIndex(display, monitorIndex) && typeof display?.get_monitor_scale === 'function') {
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
    try {
        return readMonitorGeometry(getDisplay(), monitorIndex);
    } catch {
        // Unreadable monitor geometry during hotplug or teardown.
        return null;
    }
}

/** Bounds win.get_monitor() against the count: a stale index outruns the list after an unplug. */
export function resolveMonitorBounds(display, win) {
    const disp = display ?? getDisplay();
    try {
        const monitor = typeof win?.get_monitor === 'function' ? win.get_monitor() : -1;
        return readMonitorGeometry(disp, monitor);
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
        // Display may be tearing down when enumerating windows.
        return [];
    }
}

function restackSibling(method, child, sibling, customGroup = null) {
    if (!child || !sibling)
        return;
    try {
        getWindowGroup(customGroup)?.[method]?.(child, sibling);
    } catch {
        // Restacking is best effort; a missing sibling is not worth a failed pass.
    }
}

export function setActorAboveSibling(child, sibling, customGroup = null) {
    restackSibling('set_child_above_sibling', child, sibling, customGroup);
}

export function setActorBelowSibling(child, sibling, customGroup = null) {
    restackSibling('set_child_below_sibling', child, sibling, customGroup);
}

export function getWindowActors() {
    try {
        return globalThis.global?.get_window_actors?.() ?? [];
    } catch {
        // Window group may be unavailable during shell teardown.
        return [];
    }
}

/** 1 never over-states: the count sizes how many overview cards a window gets. */
export function getWorkspaceCount() {
    try {
        const count = globalThis.global?.workspace_manager?.n_workspaces ?? 1;
        return count > 0 ? count : 1;
    } catch {
        // Workspace manager unavailable outside a live shell.
        return 1;
    }
}

export function getActiveWorkspace() {
    try {
        return globalThis.global?.workspace_manager?.get_active_workspace?.() ?? null;
    } catch {
        // Workspace manager unavailable outside a live shell.
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
        // Stage may be disposed during shutdown.
        return {width: 0, height: 0};
    }
}
