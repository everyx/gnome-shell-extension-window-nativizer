/**
 * Window-level Shell and Mutter API operations and queries for GNOME 50+.
 */

import {WindowType, WindowClientType} from '../lib/mutterRules.generated.js';
import {getMonitorScale, getMonitorGeometry, getMonitorCount, getDisplay, getStage} from './display.js';
import {roundHalfAwayFromZero} from './numeric.js';

/**
 * The app id Shell's window tracker holds for the window, or '' when the tracker cannot answer.
 * The namespace is resolved lazily because the preferences process has no Shell typelib and reaches
 * this module through the rule presenter: a top-level `gi://Shell` import would fail there.
 */
export function getTrackedAppId(win) {
    try {
        const Shell = globalThis.imports?.gi?.Shell ?? null;
        return Shell?.WindowTracker?.get_default()?.get_window_app(win)?.get_id?.() ?? '';
    } catch {
        // WindowTracker is unusable while the session is tearing down.
        return '';
    }
}

/**
 * Extracts the Meta.Window instance from a MetaWindowActor across Mutter property name
 * variations: `meta_window` (current), `metaWindow`, then the `get_meta_window()`
 * modern method. A getter may throw on a half-destroyed actor, which must not escape.
 *
 * @returns Meta.Window or null
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
 * @param actorOrWin - Window actor, child, or Meta.Window instance
 * @returns MetaWindow instance if found
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
 * The window an actor resolves to, memoized per actor. The paint path calls this every frame for an
 * actor whose Meta.Window cannot change, so the ancestor walk runs once. The actor is the key, so a
 * rebuilt actor resolves afresh; a null read is not stored, so an actor attached later can still
 * find its window.
 */
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

/**
 * Checks if the window is fully maximized (GNOME 50+).
 * @param win - Meta.Window
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
 * @param win - Meta.Window
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
 * @param win - Meta.Window
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
 * @param win - Meta.Window
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
 * @param win - Meta.Window
 * @returns Frame rect {x, y, width, height} or null
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
 * @param win - Meta.Window
 * @returns Buffer rect {x, y, width, height} or null
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
 * @param win - Meta.Window
 * @returns Window actor or null
 */
export function getWindowActor(win) {
    try {
        return win?.get_compositor_private?.() ?? null;
    } catch {
        return null;
    }
}

/**
 * The actor every overview preview clone paints through: the window actor's surface container, so
 * one handle covers every preview whenever it was built. The mask is consulted per shaped texture,
 * and a preview clone overrides only the window actor's own opacity, so this container's opacity is
 * what carries the bypass.
 */
export function getWindowSurfaceContainer(win) {
    return getSurfaceContainer(getWindowActor(win), win, null);
}

/**
 * Every live overview preview of a window, in scene order. The overview's preview is Shell-private
 * and `metaWindow._delegate` names only the last-built card, while a window on all workspaces has
 * one preview per workspace, so the live set is read by walking the stage.
 */
export function getOverviewPreviews(win) {
    const found = [];
    const stage = getStage();
    if (!stage || !win)
        return found;

    // The stage holds the window group and the shell's own UI; a preview is a handful of levels
    // below it. The cap keeps a pathological tree from turning a settle into a hang.
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

/**
 * Reads the Meta.WindowClientType (Wayland or X11).
 * @param win - Meta.Window
 * @returns Meta.WindowClientType or null
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
 * @param win - Meta.Window
 * @returns Meta.WindowType
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
 * @param win - Meta.Window
 * @returns PID or -1
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
 * @param win - Meta.Window
 * @returns Parent Meta.Window or null
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
 * @param win - Meta.Window
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
 * @param win - Meta.Window
 */
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

/**
 * Checks whether the window is currently hidden by Mutter.
 * @param win - Meta.Window
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
 * @param win - Meta.Window
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
 * @param win - Meta.Window
 * @param workspace - Meta.Workspace
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
 * @param win - Meta.Window
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
 * @param win - Meta.Window
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
 * @param win - Meta.Window
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
 * @param win - Meta.Window
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
 * @param win - Meta.Window
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
 * @param win - Meta.Window
 * @returns Meta.Window or null
 */
export function getWindowTileMatch(win) {
    try {
        return win?.get_tile_match?.() ?? null;
    } catch {
        return null;
    }
}

/**
 * Checks whether an actor is an injected foreign UI widget (e.g. from Blur my Shell).
 *
 * The check lives here, not in `lib/clipTarget.js`, because the clip-target resolver and the
 * subpixel phase reader both need the same answer and the platform layer may not import from
 * `lib/` (see tools/check-platform-boundary.mjs); `clipTarget.js` re-exports it.
 *
 */
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

/**
 * Whether a candidate surface container has no allocation yet, so its box cannot be verified. Kept
 * separate from `isCompatibleSurfaceGeometry` because the resolver treats it as the "wait" case
 * (keep the last good target) rather than an incompatibility (fall back to the window actor).
 *
 */
export function isUnallocatedSurfaceBox(candidate) {
    if (!candidate)
        return false;
    const width = candidate.width;
    const height = candidate.height;
    // Only an actor that exposes a box is a container candidate: an injected widget the St-based
    // filter could not name has no width/height and must not be read as an unallocated container.
    if (width === undefined && height === undefined)
        return false;
    return width === undefined || height === undefined || width === 0 || height === 0;
}

/**
 * Whether a candidate box has the buffer's dimensions, ignoring where it sits. Shared by the
 * compatibility predicate and the identity rule's "cannot tell" guard, so both read one buffer
 * comparison: an allocated child this size but off the buffer origin is either the container
 * mid-move or the backing, and the identity rule refuses to guess between them.
 *
 */
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

/**
 * Verifies that a candidate surface container's geometry starts at (0,0) and matches the buffer
 * dimensions. A geometry that cannot be verified is not accepted: an unreadable buffer or an
 * unallocated candidate used to fail open, so an offset container could be attached and the clip
 * cut the wrong body. The caller re-verifies on the container's `notify::allocation`.
 */
export function isCompatibleSurfaceGeometry(candidate, win) {
    if (!hasBufferDimensions(candidate, win))
        return false;

    // The container path's premise is that its local space IS the buffer's: the clip derives its
    // frame with ZERO_PHASE, so a real x/y offset moves the cut against the shadow's hole by exactly
    // that offset - 0.4 logical px is half a physical pixel at 1.25x. Only float residue may pass;
    // integer alignment is a separate concern (`isIntegerAlignedSurfaceBox`).
    const ORIGIN_EPSILON = 1e-6;
    return Math.abs(candidate.x ?? 0) <= ORIGIN_EPSILON &&
        Math.abs(candidate.y ?? 0) <= ORIGIN_EPSILON;
}

/**
 * The actor Mutter positions as the window's Wayland surface container, or null when it cannot be
 * identified. The container's type is private and unreachable from GJS, so identity comes from the
 * actor tree; an ambiguous tree answers null so the caller falls back instead of guessing.
 */
export function getSurfaceContainer(actor, win, St = null) {
    try {
        const children = actor?.get_children?.() ?? [];
        const nonForeign = children.filter(child => !isForeignWidget(child, St));
        if (nonForeign.length === 1)
            return nonForeign[0];

        // Narrow hole, "we can tell": an unallocated non-foreign child may be the real container
        // waiting for its buffer. Do not guess among the allocated siblings; return it so the
        // resolver's defer path fires and keeps the last good target.
        const unallocated = nonForeign.find(isUnallocatedSurfaceBox);
        if (unallocated)
            return unallocated;

        const compatible = nonForeign.filter(child => isCompatibleSurfaceGeometry(child, win));
        if (compatible.length !== 1)
            return null;

        // Narrow hole, "we cannot tell": another non-foreign child is buffer-sized but off the
        // buffer origin. It could be the real container mid-move and the compatible child the
        // backing, so never guess - fall back as the tie does.
        if (nonForeign.some(child =>
            child !== compatible[0] && hasBufferDimensions(child, win)))
            return null;

        return compatible[0];
    } catch {
        return null;
    }
}

/**
 * Whether two layout rects overlap with positive area, matching `mtk_rectangle_intersect`.
 */
function rectanglesOverlap(a, b) {
    const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return width > 0 && height > 0;
}

/**
 * The monitor list and the resolved index are cached because the phase mirror runs on every paint,
 * and re-reading the display per monitor each frame is O(monitors) GI calls. The manager's existing
 * `monitors-changed` handler is the topology seam that clears both.
 */
let monitorList = null;
let resolvedMonitor = new WeakMap();

/**
 * Drops the cached monitor list and every resolved index. The manager calls this from the display's
 * `monitors-changed` signal, so the next read rebuilds from the new topology.
 */
export function invalidateMonitorCache() {
    monitorList = null;
    resolvedMonitor = new WeakMap();
}

/**
 * The current display's monitors as {geometry, scale}, cached until a topology signal. Null is
 * "unreadable", never a fabricated empty list. The scale is read eagerly and kept null when the
 * geometry is unreadable; the scan only consults it for an overlapping monitor, so a null on a
 * non-overlapping one changes no answer.
 */
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

/**
 * The highest-scale logical monitor whose layout rect intersects the window's frame: -1 when a
 * readable frame overlaps none, null when the frame is degenerate or unreadable or the scan cannot
 * complete - an unreadable monitor count, geometry or scale, each of which a defaulting read would
 * fold into "no overlap". The index is reused while the frame stays on it.
 */
function resolveHighestScaleMonitorIndex(win) {
    const frame = getWindowFrameRect(win);
    if (!frame || !(frame.width > 0) || !(frame.height > 0))
        return null;

    const entries = readMonitorList();
    if (entries === null)
        return null;

    const cached = resolvedMonitor.get(win);
    if (cached && cached.entries === entries && cacheHoldsFrame(cached, frame))
        return cached.index;

    let bestIndex = -1;
    let bestScale = 0;
    for (let i = 0; i < entries.length; i++) {
        const {geometry, scale} = entries[i];
        // An unreadable geometry cannot be ruled out of the intersection, so the scan cannot
        // tell "no overlap" from "overlap unknown". Surface that instead of skipping it.
        if (!geometry)
            return null;
        if (!rectanglesOverlap(geometry, frame))
            continue;
        // A strict read: an unreadable scale is "unknown", not the integer 1.0. On a fractional
        // monitor the fallback would pick it as an integer and return a zero offset while Mutter
        // applies a real phase; the caller keeps its last good phase for the null instead.
        if (scale === null)
            return null;
        if (scale > bestScale) {
            bestScale = scale;
            bestIndex = i;
        }
    }

    resolvedMonitor.set(win, {
        entries,
        frame,
        index: bestIndex,
        geometry: bestIndex >= 0 ? entries[bestIndex].geometry : null,
    });
    return bestIndex;
}

/** Whether the cached index still describes the new frame. */
function cacheHoldsFrame(cached, frame) {
    if (rectEquals(cached.frame, frame))
        return true;
    return cached.index >= 0 && cached.geometry && rectContains(cached.geometry, frame);
}

function rectEquals(a, b) {
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function rectContains(outer, inner) {
    return outer.x <= inner.x && outer.y <= inner.y &&
        outer.x + outer.width >= inner.x + inner.width &&
        outer.y + outer.height >= inner.y + inner.height;
}

/** The resolved monitor's scale, read from the cached list so a paint takes no display call. */
function monitorScaleAt(index) {
    const entries = readMonitorList();
    return entries?.[index]?.scale ?? null;
}

/** The resolved monitor's geometry, read from the cached list so a paint takes no display call. */
function monitorGeometryAt(index) {
    const entries = readMonitorList();
    return entries?.[index]?.geometry ?? null;
}

/**
 * The mirror of Mutter's subpixel phase, computed from public API: the arithmetic
 * `surface_container_apply_transform` runs, with `roundf`'s snap-away-from-zero rule rather than
 * `Math.round`'s toward +Infinity. Null when the frame is degenerate or unreadable, or the monitor
 * scan cannot complete, {x: 0, y: 0} when a readable frame overlaps no monitor or on a non-Wayland
 * window.
 */
export function getWindowSubpixelOffset(win, St = null, container = null) {
    if (!win)
        return {x: 0, y: 0};

    try {
        if (getWindowClientType(win) !== WindowClientType.WAYLAND)
            return {x: 0, y: 0};

        const actor = getWindowActor(win);
        if (!actor)
            return {x: 0, y: 0};

        const monitorIndex = resolveHighestScaleMonitorIndex(win);
        // null is "the frame or a monitor reading could not be taken", distinct from -1's
        // "no overlap": surface it so the caller keeps its last good phase rather than collapse
        // to zero.
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

        // Layout coordinates only: the window actor's position plus the surface container's
        // position inside it (zero when the container cannot be identified). The container is
        // resolved with the same St the clip path is handed, so both run one identification rule;
        // a caller that already resolved it hands it in, so the applied read names one actor.
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

/**
 * The subpixel phase Mutter actually applied to a Wayland window's surface container, read back from
 * the transform it cached there, or null when it cannot be read - a non-Wayland client, an ambiguous
 * container, a non-unit matrix scale, or a throw. This is the production source on the container
 * path; the mirror is the fallback.
 */
export function getAppliedSubpixelPhase(win, St = null, container = null) {
    try {
        if (!win || getWindowClientType(win) !== WindowClientType.WAYLAND)
            return null;

        const actor = getWindowActor(win);
        if (!actor)
            return null;

        // The same St the clip resolves its target with, so the applied read and the clip share
        // one identification rule rather than the heuristic. A caller hands in the container it
        // already resolved, so the transform below is read from the same actor whose layout origin
        // is subtracted - one authority, never a transform against another actor's position.
        const surfaceContainer = container ?? getSurfaceContainer(actor, win, St);
        if (!surfaceContainer || typeof surfaceContainer.get_transform !== 'function')
            return null;

        const matrix = surfaceContainer.get_transform();
        if (!matrix ||
            typeof matrix.get_x_translation !== 'function' ||
            typeof matrix.get_y_translation !== 'function')
            return null;

        // `geometry_scale` is the only writer of the surface container's ancestor child
        // transform; a scale that is not 1 means the translation carries it too. A NaN scale (a
        // half-initialised matrix during teardown) fails this comparison, but it would also make
        // the subtraction below NaN, so the result is checked for finiteness at the end.
        const scaleX = typeof matrix.get_x_scale === 'function' ? matrix.get_x_scale() : 1;
        const scaleY = typeof matrix.get_y_scale === 'function' ? matrix.get_y_scale() : 1;
        if (Math.abs(scaleX - 1) > 0.001 || Math.abs(scaleY - 1) > 0.001)
            return null;

        const x = matrix.get_x_translation() -
            ((surfaceContainer.x ?? 0) + (surfaceContainer.translation_x ?? 0));
        const y = matrix.get_y_translation() -
            ((surfaceContainer.y ?? 0) + (surfaceContainer.translation_y ?? 0));
        // A half-torn-down container can hand back a NaN transform; assigning it to an actor's
        // translation is a GLib critical, so an unusable read is "unavailable" and takes the mirror
        // fallback, exactly like a non-unit scale.
        if (!Number.isFinite(x) || !Number.isFinite(y))
            return null;

        return {x, y};
    } catch {
        return null;
    }
}
