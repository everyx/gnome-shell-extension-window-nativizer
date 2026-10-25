/** Monitor geometry and scale, cached against the display until `monitors-changed` clears it. */

import {rectanglesOverlap, rectContains, rectEquals} from './rect.js';
import {getDisplay, getMonitorCount, getMonitorGeometry, getMonitorScale} from './display.js';
import {getWindowBufferRect, getWindowFrameRect} from './window.js';
import {findMetaWindow} from './windowActor.js';

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
export function resolveFrameMonitorIndex(win) {
    return resolveHighestScaleMonitorIndex(win, getWindowFrameRect(win));
}

/** The resolved monitor's scale, read from the cached list so a paint takes no display call. */
export function monitorScaleAt(index) {
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

/** Every monitor's scale, from the cached list the frame scan reads. */
export function getAllMonitorScales() {
    return readMonitorList()?.map(entry => entry.scale).filter(scale => scale > 0) ?? null;
}

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
export function monitorGeometryAt(index) {
    const entries = readMonitorList();
    return entries?.[index]?.geometry ?? null;
}

/** Highest scale the frame intersects, Mutter's real_resource_scale rule, not get_monitor(). */
export function getPhysicalMonitorScale(actorOrWin) {
    if (!actorOrWin)
        return null;

    const win = findMetaWindow(actorOrWin);
    return win ? resolveWindowMonitorScale(win) : null;
}

/** The candidate scales the clip picks the FBO's scale from, so no paint re-reads the display. */
export function getWindowScaleCandidates(actorOrWin) {
    if (!actorOrWin)
        return null;

    const win = findMetaWindow(actorOrWin);
    return win ? resolveWindowScaleCandidates(win) : null;
}
