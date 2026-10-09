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
