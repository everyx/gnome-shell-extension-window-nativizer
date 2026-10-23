/** Window-level Shell and Mutter API calls and reads for GNOME 50+. */

import {rectanglesOverlap, rectContains, rectEquals} from './rect.js';
import {WindowType, WindowClientType} from '../lib/mutterRules.generated.js';
import {getMonitorScale, getMonitorGeometry, getMonitorCount, getDisplay, getStage} from './display.js';
import {roundHalfAwayFromZero} from './numeric.js';
import {safeRead} from './read.js';

/** App id from Shell's window tracker; the import stays lazy because prefs has no Shell typelib. */
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

/** Every preview clone paints through this container; a clone overrides only actor opacity. */
export function getWindowSurfaceContainer(win) {
    return getSurfaceContainer(getWindowActor(win), win, null);
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

// Both caches exist because the phase mirror runs every paint; `monitors-changed` clears them.
let monitorList = null;
let resolvedMonitor = null;

/** Drops both caches; the manager calls this from `monitors-changed`, so the next read rebuilds. */
export function invalidateMonitorCache() {
    monitorList = null;
    resolvedMonitor = null;
}

/** Monitors as {geometry, scale}; null is unreadable, never a fabricated empty list. */
function readMonitorList() {
    const display = getDisplay();
    if (monitorList && monitorList.display === display)
        return monitorList.entries;

    const count = getMonitorCount({strict: true});
    if (count === null)
        return null;

    const entries = [];
    for (let i = 0; i < count; i++) {
        const geometry = getMonitorGeometry(i);
        const scale = geometry ? getMonitorScale(i, {strict: true}) : null;
        entries.push({geometry, scale});
    }

    monitorList = {display, entries};
    return entries;
}

/** Highest-scale monitor overlapping `rect`; -1 none, null unreadable, reused while it stays. */
function resolveHighestScaleMonitorIndex(win, rect) {
    if (!rect || !(rect.width > 0) || !(rect.height > 0))
        return null;

    const entries = readMonitorList();
    if (entries === null)
        return null;

    resolvedMonitor ??= new WeakMap();
    const cached = resolvedMonitor.get(win);
    if (cached && cached.entries === entries && cacheHoldsRect(cached, rect))
        return cached.index;

    let bestIndex = -1;
    let bestScale = 0;
    for (let i = 0; i < entries.length; i++) {
        const {geometry, scale} = entries[i];
        // An unreadable geometry can't be ruled out of the intersection, so surface it, don't skip.
        if (!geometry)
            return null;
        if (!rectanglesOverlap(geometry, rect))
            continue;
        // Strict: null is unknown, not 1.0, which would give a zero phase on a fractional monitor.
        if (scale === null)
            return null;
        if (scale > bestScale) {
            bestScale = scale;
            bestIndex = i;
        }
    }

    resolvedMonitor.set(win, {
        entries,
        rect,
        index: bestIndex,
        geometry: bestIndex >= 0 ? entries[bestIndex].geometry : null,
    });
    return bestIndex;
}

/** Whether the cached index still describes the new rect. */
function cacheHoldsRect(cached, rect) {
    if (rectEquals(cached.rect, rect))
        return true;
    return cached.index >= 0 && cached.geometry && rectContains(cached.geometry, rect);
}

/** Highest-scale monitor the frame intersects, mirroring Mutter's frame-rect scan. */
function resolveFrameMonitorIndex(win) {
    return resolveHighestScaleMonitorIndex(win, getWindowFrameRect(win));
}

/** The resolved monitor's scale, read from the cached list so a paint takes no display call. */
function monitorScaleAt(index) {
    const entries = readMonitorList();
    return entries?.[index]?.scale ?? null;
}

/** Scale of the monitor the frame sits on, from the cache; null when that read is unavailable. */
export function resolveWindowMonitorScale(win) {
    const index = resolveFrameMonitorIndex(win);
    if (index === null || index < 0)
        return null;
    return monitorScaleAt(index);
}

/** Scales of every monitor the buffer intersects; the FBO is allocated there, ring included. */
export function resolveWindowScaleCandidates(win) {
    const buffer = getWindowBufferRect(win);
    if (!buffer || !(buffer.width > 0) || !(buffer.height > 0))
        return null;

    const entries = readMonitorList();
    if (entries === null)
        return null;

    const scales = [];
    for (const {geometry, scale} of entries) {
        if (!geometry)
            return null;
        if (!rectanglesOverlap(geometry, buffer))
            continue;
        if (scale === null)
            return null;
        scales.push(scale);
    }
    return scales.length ? scales : null;
}

/** The resolved monitor's geometry, read from the cached list so a paint takes no display call. */
function monitorGeometryAt(index) {
    const entries = readMonitorList();
    return entries?.[index]?.geometry ?? null;
}

/** Mirror of Mutter's subpixel phase: `roundf` snaps away from zero, `Math.round` does not. */
export function getWindowSubpixelOffset(win, St = null, container = null) {
    if (!win)
        return {x: 0, y: 0};

    try {
        if (getWindowClientType(win) !== WindowClientType.WAYLAND)
            return {x: 0, y: 0};

        const actor = getWindowActor(win);
        if (!actor)
            return {x: 0, y: 0};

        const monitorIndex = resolveFrameMonitorIndex(win);
        // null is "no reading", not -1's "no overlap": the caller then keeps its last good phase.
        if (monitorIndex === null)
            return null;
        if (monitorIndex < 0)
            return {x: 0, y: 0};

        const scale = monitorScaleAt(monitorIndex);
        if (scale === null)
            return null;
        if (!(scale > 0) || !Number.isFinite(scale) || Math.abs(scale - Math.round(scale)) < 0.001)
            return {x: 0, y: 0};

        const geom = monitorGeometryAt(monitorIndex);
        const monitorX = geom?.x ?? 0;
        const monitorY = geom?.y ?? 0;

        // Layout coords only: actor plus container position, resolved with the same St as the clip.
        const surfaceContainer = container ?? getSurfaceContainer(actor, win, St);
        const absX = (actor.x ?? 0) + (surfaceContainer?.x ?? 0);
        const absY = (actor.y ?? 0) + (surfaceContainer?.y ?? 0);
        const relX = absX - monitorX;
        const relY = absY - monitorY;

        const adjRelX = roundHalfAwayFromZero(relX * scale) / scale;
        const adjRelY = roundHalfAwayFromZero(relY * scale) / scale;

        return {
            x: adjRelX - relX,
            y: adjRelY - relY,
        };
    } catch {
        return null;
    }
}

/** The phase Mutter actually applied, read from the container's transform; beats the mirror. */
export function getAppliedSubpixelPhase(win, St = null, container = null) {
    try {
        if (!win || getWindowClientType(win) !== WindowClientType.WAYLAND)
            return null;

        const actor = getWindowActor(win);
        if (!actor)
            return null;

        // The same St the clip uses, so transform and subtracted origin name one actor, never two.
        const surfaceContainer = container ?? getSurfaceContainer(actor, win, St);
        if (!surfaceContainer || typeof surfaceContainer.get_transform !== 'function')
            return null;

        const matrix = surfaceContainer.get_transform();
        if (!matrix ||
            typeof matrix.get_x_translation !== 'function' ||
            typeof matrix.get_y_translation !== 'function')
            return null;

        // `geometry_scale` is the only writer, so a non-unit scale means the translation has it.
        const scaleX = typeof matrix.get_x_scale === 'function' ? matrix.get_x_scale() : 1;
        const scaleY = typeof matrix.get_y_scale === 'function' ? matrix.get_y_scale() : 1;
        if (Math.abs(scaleX - 1) > 0.001 || Math.abs(scaleY - 1) > 0.001)
            return null;

        const x = matrix.get_x_translation() -
            ((surfaceContainer.x ?? 0) + (surfaceContainer.translation_x ?? 0));
        const y = matrix.get_y_translation() -
            ((surfaceContainer.y ?? 0) + (surfaceContainer.translation_y ?? 0));
        // A torn-down container hands back NaN, and assigning that to a translation is a critical.
        if (!Number.isFinite(x) || !Number.isFinite(y))
            return null;

        return {x, y};
    } catch {
        return null;
    }
}
