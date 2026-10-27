// Adaptor over the platform window seam: safe reads, identity fallback, and the reading snapshot.

import {WindowType, WindowClientType} from './mutterRules.generated.js';
import {
    CLIENT_TYPE_TOKEN_WAYLAND,
    CLIENT_TYPE_TOKEN_X11,
    chooseWindowIdentity,
} from './rules.js';
import {insetsFromRects} from './frame.js';
import {clientDeclaredRing} from './detector.js';
import {getWindowBufferAlpha, getWindowBufferRect, getWindowClientType, getWindowFrameRect, getWindowPid, getWindowTileMatch, getWindowTransientFor, getWindowType, isWindowAllowsResize, isWindowAppearsFocused, isWindowAttachedDialog, isWindowDecorated, isWindowFullscreen, isWindowMaximized, isWindowMaximizedHorizontally, isWindowMaximizedVertically, isWindowTiled} from '../platform/window.js';
import {getTrackedAppId, getWindowFromActor} from '../platform/windowActor.js';
import {resolveMonitorBounds, getWindowActors} from '../platform/display.js';
import {getPhysicalMonitorScale, getWindowScaleCandidates} from '../platform/monitor.js';
import {safeRead, readWindowString} from '../platform/read.js';
import {offscreenScaleCandidates} from './offscreenBox.js';

export {resolveMonitorBounds, safeRead};

/** First non-blank source wins; a whitespace-only XWayland class is no identity nor rule key. */
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
        for (const actor of getWindowActors()) {
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

    const tracked = getTrackedAppId(win);

    const identity = chooseWindowIdentity({declared, peer, tracked, pid});
    if (identity && identity !== peer && !identity.startsWith('pid-'))
        fallbackIdentities.set(win, {declared, identity});
    return identity;
}

/** Full snapshot, or null when the window is inaccessible; C-boundary throws are absorbed. */
export function readWindow(win, {wmClassOverride = null, classifier = null} = {}) {
    if (!win)
        return null;

    let b = null;
    let f = null;
    try {
        b = getWindowBufferRect(win, {throwOnError: true});
        f = getWindowFrameRect(win, {throwOnError: true});
    } catch {
        // throwOnError: a window being destroyed mid-read throws instead of reporting zero rects.
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

    // Bare X11 only: has_shadow() abstains on ARGB32, and an SSD frame would answer for its client.
    let bufferAlpha = null;
    if (!hasSsd && isX11 && !hasRing)
        bufferAlpha = safeRead(() => getWindowBufferAlpha(win), null);

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
        monitorScale: getPhysicalMonitorScale(win),
        // Buffer's monitors with ceil variants, so no paint re-reads the display; null if partial.
        monitorScaleCandidates: offscreenScaleCandidates(getWindowScaleCandidates(win)),

        isMaximized,
        maximizedHorizontally,
        maximizedVertically,
        isFullscreen,
        hasSsd,
        isX11,
        bufferAlpha,
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

/** Snapshot rather than a raw Meta.Window: it carries a client type token and a frame rect. */
export function isWindowReading(value) {
    return Boolean(
        value &&
        typeof value === 'object' &&
        typeof value.clientTypeToken === 'string' &&
        'frameRect' in value
    );
}

/** Null means in flight, not "no": both classifier fields are tri-state. */
export function isClassificationPending(reading) {
    return reading?.nativeLikeCorners === null || reading?.hasGtk4Client === null;
}

/** A null reading is "could not read this pass", not "gone": teardown comes through unmanaging. */
export function reconcileOutcome(reading) {
    if (!reading)
        return 'defer';
    if (!reading.hasValidGeometry)
        return 'undecorate';
    if (isClassificationPending(reading))
        return 'defer';
    return 'apply';
}
