/** The picker's window dictionary: what a window reports about itself, as D-Bus strings. */

import {WindowClientType} from './mutterRules.generated.js';

import {boolString, fingerprintProperties} from './rules.js';
import {readWindow, isWindowReading} from './window.js';
import {getWindowClientType} from '../platform/window.js';
import {getAppliedSubpixelPhase, getWindowSubpixelOffset} from '../platform/windowPhase.js';

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
        // The structural keys come from the rule table, so prefs turns the dictionary back into one key.
        ...fingerprintProperties(reading),
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

/** Both read through the clip's own container rule, so the mirror and the applied phase compare. */
export function extractPhaseProperties(win, St = null) {
    const mirror = getWindowSubpixelOffset(win, St);
    const properties = {
        // null means the scan did not complete, not a zero phase; say unknown rather than fabricate one.
        mirrorPhaseX: mirror ? String(mirror.x) : 'unknown',
        mirrorPhaseY: mirror ? String(mirror.y) : 'unknown',
    };

    // The applied transform exists only on Wayland, so X11 says n/a rather than echo a zero.
    if (getWindowClientType(win) !== WindowClientType.WAYLAND) {
        properties.appliedPhaseX = 'n/a';
        properties.appliedPhaseY = 'n/a';
        return properties;
    }

    const applied = getAppliedSubpixelPhase(win, St);
    properties.appliedPhaseX = applied ? String(applied.x) : 'unavailable';
    properties.appliedPhaseY = applied ? String(applied.y) : 'unavailable';
    return properties;
}
