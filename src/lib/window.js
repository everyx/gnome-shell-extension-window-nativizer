function getShell() {
    try {
        return globalThis.imports?.gi?.Shell ?? null;
    } catch {
        return null;
    }
}

import {WindowType, WindowClientType} from './mutterRules.generated.js';
import {
    CLIENT_TYPE_TOKEN_WAYLAND,
    CLIENT_TYPE_TOKEN_X11,
    chooseWindowIdentity,
} from './rules.js';
import {insetsFromRects} from './frame.js';
import {clientDeclaredRing, isWindowMaximized, isWindowTiled} from './detector.js';

function listWindowActors() {
    return global.get_window_actors?.() ?? [];
}

/**
 * Executes a getter safely, returning a fallback value if the call throws
 * (e.g. during Mutter window teardown or C-boundary marshalling errors).
 *
 * @template T
 * @param {() => T} getter
 * @param {T} fallback
 * @returns {T}
 */
export function safeRead(getter, fallback) {
    try {
        return getter() ?? fallback;
    } catch {
        return fallback;
    }
}

/**
 * Reads a window string, returning '' when GJS rejects non-UTF-8 C bytes: an app
 * may set any bytes as its class, and one unreadable name must not cost the
 * window its decision.
 *
 * @param {Function} getter - Reads the window field; the throw is inside the call
 * @returns {string} The field, or '' when unreadable
 */
export function readWindowString(getter) {
    return safeRead(getter, '');
}

/**
 * Declared identity, first non-blank source wins. A whitespace-only field (an X11 client may
 * set any bytes as its class) is not an identity: it must not short-circuit the chain nor
 * become a rule key.
 * @param {object} win
 * @returns {string} declared identity or ''
 */
export function readDeclaredIdentity(win) {
    for (const read of [
        () => win?.get_wm_class?.(),
        () => win?.get_sandboxed_app_id?.(),
        () => win?.get_gtk_application_id?.(),
    ]) {
        const identity = readWindowString(read).trim();
        if (identity)
            return identity;
    }
    return '';
}

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
 * Essential when effects are attached to child surface containers (e.g. on X11 or with Blur my Shell).
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
 * Resolves the true physical monitor scale for a window actor or Meta.Window instance.
 * Resolves fractional display scale directly from Meta.Display, bypassing Mutter's
 * integer-ceil'd clutter_actor_get_resource_scale().
 *
 * @param {object|null} actorOrWin - Window actor, child, or Meta.Window instance
 * @param {number} [fallback=1.0]
 * @returns {number} True physical monitor scale (e.g. 1.0, 1.25, 1.5, 2.0)
 */
export function getPhysicalMonitorScale(actorOrWin, fallback = 1.0) {
    const win = findMetaWindow(actorOrWin);
    let monitor = -1;
    if (win) {
        try {
            monitor = typeof win.get_monitor === 'function' ? win.get_monitor() : -1;
        } catch {
            // win may be partially deallocated during window close
        }
    }

    const display = typeof global !== 'undefined' ? global.display : globalThis.global?.display;
    try {
        // Infinity when the query is absent: "cannot bound it" must not silently disable
        // fractional-scale resolution, it only means there is no upper bound to enforce.
        const nMonitors = typeof display?.get_n_monitors === 'function' ? display.get_n_monitors() : Infinity;
        if (monitor >= 0 && monitor < nMonitors && typeof display?.get_monitor_scale === 'function') {
            const scale = display.get_monitor_scale(monitor);
            if (scale > 0 && Number.isFinite(scale))
                return scale;
        }
    } catch {
        // Display or index went away during a rapid topology change.
    }
    return fallback;
}

/**
 * Resolves a window's monitor geometry, or null when the index is stale (an unplugged
 * monitor before Mutter redirects the window) or the display cannot answer. The upper
 * bound is mandatory here: `get_monitor_geometry()` is a Mutter macro that logs a
 * `mutter-CRITICAL` for an out-of-range index, which is how an unplug used to reach syslog.
 *
 * @param {object|null} display - Meta.Display
 * @param {object|null} win - Meta.Window
 * @returns {object|null} monitor rect, or null
 */
export function resolveMonitorBounds(display, win) {
    try {
        const nMonitors = typeof display?.get_n_monitors === 'function' ? display.get_n_monitors() : Infinity;
        const monitor = typeof win?.get_monitor === 'function' ? win.get_monitor() : -1;
        if (monitor >= 0 && monitor < nMonitors && typeof display?.get_monitor_geometry === 'function')
            return display.get_monitor_geometry(monitor);
    } catch {
        // Display or index went stale mid-read.
    }
    return null;
}

// Tracker-derived answers are remembered. A declared answer returns before the cache, a pid
// fallback would freeze a session-local rule, and a peer-derived answer is not remembered
// either: the peer scan is O(actors) but only runs for a window that declares no identity at
// all, while caching it could not be invalidated correctly for a peer the manager does not
// track (a popup, a dock).
const fallbackIdentities = new WeakMap();

/** @param {object} win @returns {string} stable identity or '' */
export function resolveWindowIdentity(win) {
    if (!win)
        return '';

    const declared = readDeclaredIdentity(win);
    if (declared)
        return declared;

    const remembered = fallbackIdentities.get(win);
    if (remembered && remembered.declared === declared)
        return remembered.identity;

    let pid = -1;
    try {
        pid = win.get_pid?.() ?? -1;
    } catch {
        // Window went away mid-resolve; fall through with no pid.
    }
    let peer = '';
    if (pid > 0) {
        for (const actor of listWindowActors()) {
            const candidate = getWindowFromActor(actor);
            if (!candidate || candidate === win)
                continue;
            try {
                if (candidate.get_pid?.() !== pid)
                    continue;
            } catch {
                continue; // Peer is itself being torn down.
            }
            peer = readDeclaredIdentity(candidate);
            if (peer)
                break;
        }
    }

    let tracked = '';
    try {
        tracked = getShell()?.WindowTracker?.get_default()?.get_window_app(win)?.get_id?.() ?? '';
    } catch {
        // WindowTracker is unusable while the session is tearing down.
    }

    const identity = chooseWindowIdentity({declared, peer, tracked, pid});
    if (identity && identity !== peer && !identity.startsWith('pid-'))
        fallbackIdentities.set(win, {declared, identity});
    return identity;
}

/**
 * @typedef {object} WindowReading
 * @property {object|null} bufferRect - {x, y, width, height} or null
 * @property {object|null} frameRect - {x, y, width, height} or null
 * @property {number} bufferWidth
 * @property {number} bufferHeight
 * @property {number} frameWidth
 * @property {number} frameHeight
 * @property {boolean} hasValidGeometry
 * @property {object|null} insets - {left, top, right, bottom} or null
 * @property {boolean} hasRing
 * @property {number} monitorScale
 * @property {boolean} isMaximized
 * @property {boolean} maximizedHorizontally
 * @property {boolean} maximizedVertically
 * @property {boolean} isFullscreen
 * @property {boolean} hasSsd
 * @property {boolean} isX11
 * @property {string} clientTypeToken
 * @property {boolean} nativeLikeCorners
 * @property {boolean} hasGtk4Client
 * @property {number} windowType
 * @property {boolean} hasParent
 * @property {boolean} isAttachedDialog
 * @property {boolean} allowsResize
 * @property {boolean} hasTileMatch
 * @property {string} declaredWmClass
 * @property {string} wmClass
 * @property {boolean} appearsFocused
 * @property {boolean} tiled
 * @property {number} pid
 */

/**
 * Reads a comprehensive, safe snapshot of a Meta.Window.
 * Absorbs all C-boundary exceptions during window teardown and returns null if the window is inaccessible.
 *
 * @param {object|null} win - Meta.Window
 * @param {object} [options]
 * @param {string|null} [options.wmClassOverride=null]
 * @param {import('./nativeLikeCorners.js').ProcessClassifier|null} [options.classifier=null]
 * @returns {WindowReading|null}
 */
export function readWindow(win, {wmClassOverride = null, classifier = null} = {}) {
    if (!win)
        return null;

    let b = null;
    let f = null;
    try {
        b = win.get_buffer_rect?.() ?? null;
        f = win.get_frame_rect?.() ?? null;
    } catch {
        // Window being destroyed mid-read.
        return null;
    }

    const hasValidGeometry = Boolean(b && f && b.width > 0 && b.height > 0 && f.width > 0 && f.height > 0);
    const insets = hasValidGeometry ? insetsFromRects(b, f) : null;

    const isX11 = safeRead(() => win.get_client_type?.() === WindowClientType.X11, false);
    const hasSsd = safeRead(() => Boolean(win.decorated), false);
    const maximizedHorizontally = safeRead(() => Boolean(win.maximized_horizontally), false);
    const maximizedVertically = safeRead(() => Boolean(win.maximized_vertically), false);
    const appearsFocused = safeRead(() => Boolean(win.appears_focused), false);

    const hasRing = safeRead(() => {
        if (typeof win.hasRing === 'boolean')
            return win.hasRing;
        if (hasValidGeometry)
            return clientDeclaredRing({hasSsd, insets, bufferWidth: b.width, bufferHeight: b.height, frameWidth: f.width, frameHeight: f.height});
        return false;
    }, false);

    const isMaximized = safeRead(() => isWindowMaximized(win), false);
    const hasTileMatch = safeRead(() => Boolean(win.get_tile_match?.()), false);
    const isFullscreen = safeRead(() => Boolean(win.is_fullscreen?.()), false);
    const windowType = safeRead(() => win.get_window_type?.() ?? WindowType.NORMAL, WindowType.NORMAL);
    const pid = safeRead(() => win.get_pid?.() ?? -1, -1);
    const hasParent = safeRead(() => Boolean(win.get_transient_for?.()), false);
    const isAttachedDialog = safeRead(() => Boolean(win.is_attached_dialog?.()), false);
    const allowsResize = safeRead(() => Boolean(win.allows_resize?.()), true);

    const declaredWmClass = safeRead(() => readDeclaredIdentity(win), '');
    const wmClass = wmClassOverride || declaredWmClass || safeRead(() => resolveWindowIdentity(win), '');

    // Process classification defaults to false when classifier is omitted or throws.
    const nativeLikeCorners = safeRead(
        () => Boolean(classifier && typeof classifier.hasNativeLikeCorners === 'function' && classifier.hasNativeLikeCorners(win)),
        false
    );
    const hasGtk4 = safeRead(
        () => Boolean(classifier && typeof classifier.hasGtk4Client === 'function' && classifier.hasGtk4Client(pid)),
        false
    );
    const tiled = safeRead(() => isWindowTiled(win, {isMaximized, hasTileMatch}), false);

    return {
        bufferRect: b,
        frameRect: f,
        bufferWidth: b?.width ?? 0,
        bufferHeight: b?.height ?? 0,
        frameWidth: f?.width ?? 0,
        frameHeight: f?.height ?? 0,
        hasValidGeometry,
        insets,
        hasRing,
        monitorScale: getPhysicalMonitorScale(win, 1),

        isMaximized,
        maximizedHorizontally,
        maximizedVertically,
        isFullscreen,
        hasSsd,
        isX11,
        clientTypeToken: isX11 ? CLIENT_TYPE_TOKEN_X11 : CLIENT_TYPE_TOKEN_WAYLAND,
        nativeLikeCorners,
        hasGtk4Client: hasGtk4,
        windowType,
        hasParent,
        isAttachedDialog,
        allowsResize,
        hasTileMatch,
        declaredWmClass,
        wmClass,

        appearsFocused,
        tiled,
        pid,
    };
}

/**
 * Checks whether an object matches the minimal shape of a resolved WindowReading snapshot
 * (has a string clientTypeToken and frameRect property) as distinguished from a raw Meta.Window.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isWindowReading(value) {
    return Boolean(
        value &&
        typeof value === 'object' &&
        typeof value.clientTypeToken === 'string' &&
        'frameRect' in value
    );
}
