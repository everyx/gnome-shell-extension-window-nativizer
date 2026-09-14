// Pure pick contract shared by extension and prefs — see docs/architecture.md.

import {WindowType, WindowClientType} from './mutterRules.generated.js';

import {
    CLIENT_TYPE_TOKEN_WAYLAND,
    CLIENT_TYPE_TOKEN_X11,
    buildRuleKey,
    boolString,
} from './rules.js';

// Generated from vendor/mutter/window.h; re-exported so pure modules avoid Shell/Meta.
export {WindowClientType};

export const INSPECTOR_DBUS_NAME = 'org.gnome.Shell.Extensions.WindowNativizer';
export const INSPECTOR_DBUS_PATH = '/org/gnome/Shell/Extensions/WindowNativizer';

/**
 * Reads a window string, returning '' when GJS rejects non-UTF-8 C bytes: an app
 * may set any bytes as its class, and one unreadable name must not cost the
 * window its decision.
 *
 * @param {Function} getter - Reads the window field; the throw is inside the call
 * @returns {string} The field, or '' when unreadable
 */
export function readWindowString(getter) {
    try {
        return getter() ?? '';
    } catch {
        return '';
    }
}

/** @param {object} win @returns {string} declared identity or '' */
export function readDeclaredIdentity(win) {
    return readWindowString(() => win?.get_wm_class?.()) ||
        readWindowString(() => win?.get_sandboxed_app_id?.()) ||
        readWindowString(() => win?.get_gtk_application_id?.()) ||
        '';
}

/** @param {object} win @param {string|null} [wmClassOverride] @returns {Record<string,string>} */
export function extractWindowProperties(win, wmClassOverride = null) {
    if (!win)
        return {};

    const wmClass = wmClassOverride || readDeclaredIdentity(win);
    const windowType = win.get_window_type?.() ?? WindowType.NORMAL;
    const isX11 = win.get_client_type?.() === WindowClientType.X11;

    // Values are strings for D-Bus a{ss}; prefs parses them back for buildRuleKey().
    return {
        wmClass,
        'clientType': isX11 ? CLIENT_TYPE_TOKEN_X11 : CLIENT_TYPE_TOKEN_WAYLAND,
        'windowType': String(windowType),
        'hasParent': boolString(win.get_transient_for?.()),
        'allowsResize': boolString(win.allows_resize?.()),
        'isAttachedDialog': boolString(win.is_attached_dialog?.()),
    };
}

/** @param {Record<string,string>} [properties] @returns {string} canonical key or '' */
export function buildRuleKeyFromProperties(properties = {}) {
    return buildRuleKey(properties.wmClass, {
        clientType: properties.clientType,
        windowType: Number(properties.windowType ?? WindowType.NORMAL),
        hasParent: properties.hasParent === 'true',
        allowsResize: properties.allowsResize === 'true',
        isAttachedDialog: properties.isAttachedDialog === 'true',
    });
}
