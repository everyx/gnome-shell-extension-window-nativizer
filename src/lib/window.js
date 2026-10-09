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
import {clientDeclaredRing} from './detector.js';
import {
    isWindowMaximized,
    isWindowFullscreen,
    isWindowTiled,
    getWindowFrameRect,
    getWindowBufferRect,
    getWindowClientType,
    getWindowType,
    getWindowPid,
    getWindowTransientFor,
    isWindowAttachedDialog,
    isWindowAllowsResize,
    isWindowDecorated,
    isWindowMaximizedHorizontally,
    isWindowMaximizedVertically,
    isWindowAppearsFocused,
    getWindowTileMatch,
    getWindowFromActor,
    findMetaWindow,
} from '../platform/window.js';
import {
    getPhysicalMonitorScale,
    resolveMonitorBounds,
    getWindowActors,
} from '../platform/display.js';

export {getPhysicalMonitorScale, resolveMonitorBounds, getWindowFromActor, findMetaWindow};

function listWindowActors() {
    return getWindowActors();
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




// Weak cache for resolved fallback identities; declared identities bypass cache.
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

    const pid = getWindowPid(win);
    let peer = '';
    if (pid > 0) {
        for (const actor of listWindowActors()) {
            const candidate = getWindowFromActor(actor);
            if (!candidate || candidate === win)
                continue;
            if (getWindowPid(candidate) !== pid)
                continue;
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
 * @property {boolean|null} nativeLikeCorners - Whether process draws native-like decorations, or null while pending
 * @property {boolean|null} hasGtk4Client - Whether client is GTK4, or null while pending
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
        b = getWindowBufferRect(win, {throwOnError: true});
        f = getWindowFrameRect(win, {throwOnError: true});
    } catch {
        // Window being destroyed mid-read.
        return null;
    }

    const hasValidGeometry = Boolean(b && f && b.width > 0 && b.height > 0 && f.width > 0 && f.height > 0);
    const insets = hasValidGeometry ? insetsFromRects(b, f) : null;

    const isX11 = safeRead(() => getWindowClientType(win) === WindowClientType.X11, false);
    const hasSsd = safeRead(() => isWindowDecorated(win), false);
    const maximizedHorizontally = safeRead(() => isWindowMaximizedHorizontally(win), false);
    const maximizedVertically = safeRead(() => isWindowMaximizedVertically(win), false);
    const appearsFocused = safeRead(() => isWindowAppearsFocused(win), false);

    const hasRing = safeRead(() => {
        if (typeof win.hasRing === 'boolean')
            return win.hasRing;
        if (hasValidGeometry)
            return clientDeclaredRing({hasSsd, insets, bufferWidth: b.width, bufferHeight: b.height, frameWidth: f.width, frameHeight: f.height});
        return false;
    }, false);

    const isMaximized = safeRead(() => isWindowMaximized(win), false);
    const hasTileMatch = safeRead(() => Boolean(getWindowTileMatch(win)), false);
    const isFullscreen = safeRead(() => isWindowFullscreen(win), false);
    const windowType = safeRead(() => getWindowType(win), WindowType.NORMAL);
    const pid = safeRead(() => getWindowPid(win), -1);
    const hasParent = safeRead(() => Boolean(getWindowTransientFor(win)), false);
    const isAttachedDialog = safeRead(() => isWindowAttachedDialog(win), false);
    const allowsResize = safeRead(() => isWindowAllowsResize(win), true);

    const declaredWmClass = safeRead(() => readDeclaredIdentity(win), '');
    const wmClass = wmClassOverride || declaredWmClass || safeRead(() => resolveWindowIdentity(win), '');

    // Null while read is pending or if classifier fails during teardown.
    const nativeLikeCorners = safeRead(() => {
        if (classifier && typeof classifier.adwaitaLook === 'function')
            return classifier.adwaitaLook(pid);
        return false;
    }, null);
    const hasGtk4 = safeRead(() => {
        if (classifier && typeof classifier.hasGtk4Client === 'function')
            return classifier.hasGtk4Client(pid);
        return false;
    }, null);
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

/**
 * Whether process classification is still in flight.
 * @param {{nativeLikeCorners: boolean|null, hasGtk4Client: boolean|null}} reading
 * @returns {boolean}
 */
export function isClassificationPending(reading) {
    return reading?.nativeLikeCorners === null || reading?.hasGtk4Client === null;
}
