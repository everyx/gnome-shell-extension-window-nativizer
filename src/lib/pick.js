import {WindowClientType} from './mutterRules.generated.js';

import {
    buildRuleKeyFromProperties,
    boolString,
} from './rules.js';
import {
    readWindowString,
    readDeclaredIdentity,
    getWindowFromActor,
    readWindow,
    isWindowReading,
} from './window.js';
import {
    getWindowSubpixelOffset,
    getAppliedSubpixelPhase,
    getWindowClientType,
} from '../platform/window.js';

export {WindowClientType};

// Re-exported window inspection utilities for backward compatibility.
export {
    buildRuleKeyFromProperties,
    readWindowString,
    readDeclaredIdentity,
    getWindowFromActor
};

export const INSPECTOR_DBUS_NAME = 'org.gnome.Shell.Extensions.WindowNativizer';
export const INSPECTOR_DBUS_PATH = '/org/gnome/Shell/Extensions/WindowNativizer';

/**
 * @param {object} winOrReading - Meta.Window or existing WindowReading
 * @param {string|null} [wmClassOverride]
 * @returns {Record<string,string>}
 */
export function extractWindowProperties(winOrReading, wmClassOverride = null) {
    if (!winOrReading)
        return {};

    const reading = isWindowReading(winOrReading)
        ? winOrReading
        : readWindow(winOrReading, {wmClassOverride});
    if (!reading)
        return {};

    const props = {
        wmClass: wmClassOverride || reading.declaredWmClass,
        clientType: reading.clientTypeToken,
        windowType: String(reading.windowType),
        hasParent: boolString(reading.hasParent),
        allowsResize: boolString(reading.allowsResize),
        isAttachedDialog: boolString(reading.isAttachedDialog),
        hasRing: boolString(reading.hasRing),
        hasSsd: boolString(reading.hasSsd),
        isMaximized: boolString(reading.isMaximized),
        isFullscreen: boolString(reading.isFullscreen),
        hasTileMatch: boolString(reading.hasTileMatch),
    };

    const f = reading.frameRect;
    if (f && Number.isFinite(f.width) && Number.isFinite(f.height) && f.width > 0 && f.height > 0) {
        props.width = String(Math.round(f.width));
        props.height = String(Math.round(f.height));
    }

    return props;
}

/**
 * Builds the pick reply's subpixel-phase diagnostic fields, so a user can compare the phase we
 * cut on with the phase Mutter actually applied.
 *
 * The mirror is `getWindowSubpixelOffset`; the applied phase is read back from the surface
 * container's cached transform (`getAppliedSubpixelPhase`). The applied read is also the
 * production source on the container path (the shadow reads it too, see `shadowPhaseOffset`), so
 * this reply is where a user compares the two when the mirror's monitor scan cannot be exercised
 * locally. The reply is an `a{ss}` map, so every field is a string, and an unreadable applied
 * phase says so rather than claiming a zero; an unreadable monitor scan answers "unknown" for
 * the mirror for the same reason. This runs only when a user asks for the pick, never per frame.
 *
 * @param {object|null} win - Meta.Window
 * @returns {Record<string,string>} mirrorPhaseX/Y and appliedPhaseX/Y
 */
export function extractPhaseProperties(win) {
    const mirror = getWindowSubpixelOffset(win);
    const properties = {
        // null is "the monitor scan could not complete", not a phase of zero; say so rather than
        // report a fabricated zero the user would compare against the applied read.
        mirrorPhaseX: mirror ? String(mirror.x) : 'unknown',
        mirrorPhaseY: mirror ? String(mirror.y) : 'unknown',
    };

    // The applied transform only exists for a Wayland surface container; the mirror's own doc
    // answers zero for X11, so the applied side says not-applicable instead of echoing that zero.
    if (getWindowClientType(win) !== WindowClientType.WAYLAND) {
        properties.appliedPhaseX = 'n/a';
        properties.appliedPhaseY = 'n/a';
        return properties;
    }

    const applied = getAppliedSubpixelPhase(win);
    properties.appliedPhaseX = applied ? String(applied.x) : 'unavailable';
    properties.appliedPhaseY = applied ? String(applied.y) : 'unavailable';
    return properties;
}
