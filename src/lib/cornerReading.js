/**
 * What a corner sample means and which windows need one - pure, so the verdicts are testable
 * without a session. The probe that produces the samples is `cornerProbe.js`.
 */

import {requiresCornerVerification} from './detector.js';

const ALPHA_DROP_THRESHOLD = 32;
import {buildRuleKey} from './rules.js';

/**
 * Whether our corner arc (radius 15) cuts only solid pixels. The sample sits inside the arc, so a
 * corner that dropped means something was painted there. Null before the first frame or unreadable.
 */
export function isClipSafe(sample) {
    if (!sample || !Array.isArray(sample.corners) || sample.corners.length < 4)
        return null;
    const {corners, interior} = sample;
    if (!Number.isFinite(interior) || interior <= 0)
        return null;
    for (const alpha of corners) {
        if (!Number.isFinite(alpha))
            return null;
    }
    return !corners.some(alpha => alpha < interior - ALPHA_DROP_THRESHOLD);
}

/**
 * True for windows where metadata alone cannot tell an opaque square surface from a self-rounded
 * one (alpha-capable, no SSD, no declared ring, and either fixed-size or unverified dialog/utility).
 */
export function needsCornerAlphaProbe(reading) {
    if (!reading?.hasValidGeometry)
        return false;
    // Mutter answers `allows_resize` false for a maximized or fullscreen window, which otherwise
    // reads as fixed-size - and neither state is ever decorated, so the probe would be wasted.
    if (reading.isMaximized || reading.isFullscreen)
        return false;
    if (reading.hasSsd || reading.hasRing)
        return false;
    if (reading.bufferAlpha === false || reading.nativeLikeCorners)
        return false;
    // A ring is what a declared margin looks like from here, and this window has none.
    return requiresCornerVerification({
        hasSsd: reading.hasSsd,
        sideW: 0,
        sideH: 0,
        bufferAlpha: reading.bufferAlpha,
        allowsResize: reading.allowsResize,
        windowType: reading.windowType,
    }) !== null;
}

/** The kind a correction is written against, so a verdict and a rule name the same window; null for
 * session-scoped `pid-*` identities. */
export function cornerProbeKey(reading) {
    if (!reading?.hasValidGeometry || !reading.wmClass || reading.wmClass.startsWith('pid-'))
        return null;
    return buildRuleKey(reading.wmClass, {
        clientType: reading.clientTypeToken,
        windowType: reading.windowType,
        hasParent: Boolean(reading.hasParent),
        allowsResize: Boolean(reading.allowsResize),
        isAttachedDialog: Boolean(reading.isAttachedDialog),
        hasRing: Boolean(reading.hasRing),
        hasSsd: Boolean(reading.hasSsd),
        width: reading.frameWidth,
        height: reading.frameHeight,
    });
}
