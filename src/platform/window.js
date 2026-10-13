/**
 * Window-level Shell and Mutter API operations and queries for GNOME 50+.
 */

import {WindowType, WindowClientType} from '../lib/mutterRules.generated.js';
import {getMonitorScale, getMonitorGeometry, getMonitorCount} from './display.js';
import {roundHalfAwayFromZero} from './numeric.js';

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
 * Reads the overview preview's window container for a window, or null outside the overview.
 *
 * The overview's preview is Shell-private (`metaWindow._delegate`, set in
 * `js/ui/windowPreview.js`) and the container is its child, so the whole chain — parent and
 * container — is read here rather than in the decoration modules. The container's parent is
 * the preview the shadow clone is mounted under.
 *
 * @param {object|null} win - Meta.Window
 * @returns {{container: object, preview: object}|null} Actors, or null outside the overview
 */
export function getOverviewPreview(win) {
    try {
        const preview = win?._delegate ?? null;
        const container = preview?.window_container ?? null;
        return preview && container ? {preview, container} : null;
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

/**
 * Checks whether an actor is an injected foreign UI widget (e.g. from Blur my Shell).
 *
 * The check lives here, not in `lib/clipTarget.js`, because the clip-target resolver and the
 * subpixel phase reader both need the same answer and the platform layer may not import from
 * `lib/` (see tools/check-platform-boundary.mjs); `clipTarget.js` re-exports it.
 *
 * @param {object|null} child
 * @param {object|null} [St]
 * @returns {boolean}
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
 * Resolves the actor Mutter positions as the window's Wayland surface container.
 *
 * `surface_container_apply_transform` computes the subpixel phase from the container's layout
 * position inside the window actor - `get_x(windowActor) + get_x(surfaceContainer)` - and
 * `do_sync_geometry` moves that container for letterboxed fullscreen windows, so a reader that
 * wants the phase has to read this actor, not the window actor. The container's type
 * (`MetaSurfaceContainerActorWayland`) is private: it is absent from `meta-window-actor.h` and
 * from the GIR sources, so it is not reachable from GJS and cannot be type-checked. Identity is
 * inferred from the actor tree instead: the window actor's non-foreign child. The background
 * actor Mutter inserts is not an St.Widget, so an ambiguous tree (more than one non-foreign
 * child) answers null and the caller treats the container offset as zero.
 *
 * @param {object|null} actor - The window actor
 * @param {object|null} [St]
 * @returns {object|null} Surface container actor, or null when it cannot be identified
 */
export function getSurfaceContainer(actor, St = null) {
    try {
        const children = actor?.get_children?.() ?? [];
        const nonForeign = children.filter(child => !isForeignWidget(child, St));
        return nonForeign.length === 1 ? nonForeign[0] : null;
    } catch {
        return null;
    }
}

/**
 * Whether two layout rects overlap with positive area, matching `mtk_rectangle_intersect`.
 * @param {{x:number,y:number,width:number,height:number}} a
 * @param {{x:number,y:number,width:number,height:number}} b
 * @returns {boolean}
 */
function rectanglesOverlap(a, b) {
    const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return width > 0 && height > 0;
}

/**
 * The highest-scale logical monitor whose layout rect intersects the window's frame.
 *
 * This is `meta_window_get_highest_scale_monitor` rebuilt from public API: that getter only
 * returns the private `window->highest_scale_monitor` pointer (window-private.h) and is not in
 * the typelib, so the rule behind it -
 * `meta_monitor_manager_get_highest_scale_monitor_from_rect`, max scale over intersecting
 * logical monitors - is re-run here from the public frame rect and monitor geometry. Mutter
 * caches the result on the window and refreshes it on monitor and frame changes, while this runs
 * per read, so the two can disagree for a frame around a move or hotplug; that is the one
 * approximation in the term.
 *
 * A degenerate frame (unreadable, or a width/height that is not positive) returns -1, which
 * `getWindowSubpixelOffset` maps to {x: 0, y: 0}. It used to return `win.get_monitor()` - the
 * main monitor - as a third rule on top of upstream's two, but Mutter's two writers of the
 * cached pointer already disagree: `meta_window_constructed` stores the current logical monitor
 * (window.c:1250-1260), while `meta_window_update_monitor` stores `window->monitor`, the last
 * resolved main monitor (window.c:4195-4199). `surface_container_apply_transform`
 * (meta-window-actor-wayland.c:130) applies no phase at all when that pointer is NULL, so
 * mirroring either path buys nothing once a decoration is live - and a degenerate frame means
 * exactly that it is not (the measurement is in the commit message). The valid-frame,
 * no-intersecting-monitor case was already -1 for the same reason.
 *
 * An unreadable monitor geometry is not a non-overlapping one: the scan cannot rule it out of
 * the intersection, so it answers null ("unknown") rather than skip the monitor and possibly
 * answer -1. That keeps "no overlap" and "cannot tell" apart; the caller keeps the last good
 * phase for the unknown case instead of collapsing to zero.
 *
 * @param {object|null} win - Meta.Window
 * @returns {number|null} Logical monitor index, -1 when no readable monitor overlaps, or null
 *          when a monitor geometry read failed
 */
function resolveHighestScaleMonitorIndex(win) {
    const frame = getWindowFrameRect(win);
    if (!frame || !(frame.width > 0) || !(frame.height > 0))
        return -1;

    let bestIndex = -1;
    let bestScale = 0;
    const count = getMonitorCount();
    for (let i = 0; i < count; i++) {
        const geom = getMonitorGeometry(i);
        // An unreadable geometry cannot be ruled out of the intersection, so the scan cannot
        // tell "no overlap" from "overlap unknown". Surface that instead of skipping it.
        if (!geom)
            return null;
        if (!rectanglesOverlap(geom, frame))
            continue;
        const scale = getMonitorScale(i);
        if (scale > bestScale) {
            bestScale = scale;
            bestIndex = i;
        }
    }
    return bestIndex;
}

/**
 * Computes the Wayland subpixel phase Mutter applies to a window's surface container.
 *
 * The arithmetic is `surface_container_apply_transform`
 * (meta-window-actor-wayland.c:130-147), term for term:
 *
 *   monitor  = meta_window_get_highest_scale_monitor (window)
 *   scale    = meta_logical_monitor_get_scale (monitor)
 *   rect     = meta_logical_monitor_get_layout (monitor)
 *   abs_x    = clutter_actor_get_x (windowActor) + clutter_actor_get_x (surfaceContainer)
 *   rel_x    = abs_x - rect.x
 *   x_off    = roundf (rel_x * scale) / scale - rel_x
 *
 * Two terms are reconstructed rather than read, because their C symbols are not introspectable:
 * the highest-scale monitor (see resolveHighestScaleMonitorIndex) and the surface container (see
 * getSurfaceContainer). Both note what is exact and what is approximated where they are defined.
 *
 * The window's `translation_x/y` is deliberately not a term. Mutter computes the phase from
 * layout coordinates and the base transform carries the translation separately, so animations
 * move the window off the grid on purpose; folding the translation in would move our cut while
 * the buffer was somewhere else.
 *
 * The snap uses `roundf`'s rule, not JavaScript's `Math.round`. `Math.round` sends an exact half
 * toward +Infinity while `roundf` sends it away from zero, so on a negative half they differ by
 * one snapped integer: at 1.25, `relX = -2` gives -2.5, where `roundf` snaps to -3 and
 * `Math.round` stays at -2, a 0.8 logical px (one physical px) difference in the offset. An
 * earlier revision claimed this could not happen; that holds on the 4/3 path, where an integer
 * times 4/3 never ends in .5, but not in general - on a 1.25 monitor negative halves are
 * reachable whenever `relX ≡ 2 (mod 4)`, and likewise at 1.5. The shared
 * `roundHalfAwayFromZero` (`platform/numeric.js`) encodes `roundf`'s rule and leaves the 4/3
 * path unchanged.
 *
 * Returns {x: 0, y: 0} for non-Wayland windows, integer scales, or a frame no readable monitor
 * overlaps, and null when the monitor scan cannot complete because a geometry read failed. The
 * phase's two consumers keep their last good value on null, so both cuts stay on one line.
 *
 * @param {object|null} win - Meta.Window
 * @returns {{x: number, y: number}|null} Applied offset, or null when it cannot be computed
 */
export function getWindowSubpixelOffset(win) {
    if (!win)
        return {x: 0, y: 0};

    try {
        if (getWindowClientType(win) !== WindowClientType.WAYLAND)
            return {x: 0, y: 0};

        const actor = getWindowActor(win);
        if (!actor)
            return {x: 0, y: 0};

        const monitorIndex = resolveHighestScaleMonitorIndex(win);
        // null is "a monitor geometry could not be read", distinct from -1's "no overlap":
        // surface it so the caller keeps its last good phase rather than collapse to zero.
        if (monitorIndex === null)
            return null;
        if (monitorIndex < 0)
            return {x: 0, y: 0};

        const scale = getMonitorScale(monitorIndex);
        if (!(scale > 0) || !Number.isFinite(scale) || Math.abs(scale - Math.round(scale)) < 0.001)
            return {x: 0, y: 0};

        const geom = getMonitorGeometry(monitorIndex);
        const monitorX = geom?.x ?? 0;
        const monitorY = geom?.y ?? 0;

        // Layout coordinates only: the window actor's position plus the surface container's
        // position inside it (zero when the container cannot be identified).
        const container = getSurfaceContainer(actor);
        const absX = (actor.x ?? 0) + (container?.x ?? 0);
        const absY = (actor.y ?? 0) + (container?.y ?? 0);
        const relX = absX - monitorX;
        const relY = absY - monitorY;

        const adjRelX = roundHalfAwayFromZero(relX * scale) / scale;
        const adjRelY = roundHalfAwayFromZero(relY * scale) / scale;

        return {
            x: adjRelX - relX,
            y: adjRelY - relY,
        };
    } catch {
        return {x: 0, y: 0};
    }
}

/**
 * Reads the subpixel phase Mutter actually applied to a Wayland window's surface container.
 *
 * This is the production source on the container path. The clip's target carries the phase in its
 * own transform, so the clip cuts a phase-free local frame and the shadow reads that same transform
 * back to translate its cutout onto the same physical line; both cuts then follow one source.
 * The mirror in `getWindowSubpixelOffset` is the fallback whenever this read is unavailable (a
 * non-Wayland client, an ambiguous container, a non-unit matrix scale, or a throw) and stays the
 * primary source on the clip's fallback path, where the clip folds the mirror into its own frame.
 * Read `docs/decoration-model.md`'s "Where the phase comes from" for the trade-off.
 *
 * `surface_container_apply_transform` (meta-window-actor-wayland.c) folds the phase into the
 * container's transform with `graphene_matrix_translate`; `ensure_valid_actor_transform` caches
 * that matrix on the actor and `clutter_actor_get_transform` reads it back. The matrix also
 * carries the container's layout origin (its `x`/`y` plus `translation_x`/`translation_y`) and no
 * ancestor position, so subtracting the layout origin from the matrix translation leaves the
 * applied phase. The window actor's `geometry_scale` child transform scales the matrix, which
 * would scale that translation and make the subtraction meaningless, so a non-unit scale answers
 * null rather than a wrong number.
 *
 * A caller may stub the container and matrix as plain objects exposing `get_transform()` and the
 * Graphene accessors. Every unavailable case - a non-Wayland client, a missing actor or container,
 * an unreadable matrix, a non-unit scale, or a throw - answers null; it never throws at the pick
 * reply and never claims a fake zero.
 *
 * @param {object|null} win - Meta.Window
 * @returns {{x: number, y: number}|null} Applied phase, or null when it cannot be read
 */
export function getAppliedSubpixelPhase(win) {
    try {
        if (!win || getWindowClientType(win) !== WindowClientType.WAYLAND)
            return null;

        const actor = getWindowActor(win);
        if (!actor)
            return null;

        const container = getSurfaceContainer(actor);
        if (!container || typeof container.get_transform !== 'function')
            return null;

        const matrix = container.get_transform();
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

        const x = matrix.get_x_translation() - ((container.x ?? 0) + (container.translation_x ?? 0));
        const y = matrix.get_y_translation() - ((container.y ?? 0) + (container.translation_y ?? 0));
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
