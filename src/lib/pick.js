// Pure pick contract shared by extension and prefs — see docs/architecture.md.

import {WindowType, WindowClientType} from './mutterRules.generated.js';

import {hasDeclaredMarginRing} from './frame.js';
import {
    CLIENT_TYPE_TOKEN_WAYLAND,
    CLIENT_TYPE_TOKEN_X11,
    buildRuleKey,
    boolString,
} from './rules.js';

// Generated from vendor/mutter/window.h.
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
    const f = win.get_frame_rect?.();
    const b = win.get_buffer_rect?.();

    let hasRing = false;
    if (typeof win.hasRing === 'boolean')
        hasRing = win.hasRing;
    else if (f && b)
        hasRing = hasDeclaredMarginRing({buffer: b, frame: f, hasSsd: Boolean(win.decorated)});

    // Values are strings for D-Bus a{ss}; prefs parses them back for buildRuleKey().
    const props = {
        wmClass,
        'clientType': isX11 ? CLIENT_TYPE_TOKEN_X11 : CLIENT_TYPE_TOKEN_WAYLAND,
        'windowType': String(windowType),
        'hasParent': boolString(win.get_transient_for?.()),
        'allowsResize': boolString(win.allows_resize?.()),
        'isAttachedDialog': boolString(win.is_attached_dialog?.()),
        'hasRing': boolString(hasRing),
    };

    if (f && Number.isFinite(f.width) && Number.isFinite(f.height) && f.width > 0 && f.height > 0) {
        props.width = String(Math.round(f.width));
        props.height = String(Math.round(f.height));
    }

    return props;
}

/** @param {Record<string,string>} [properties] @returns {string} canonical key or '' */
export function buildRuleKeyFromProperties(properties = {}) {
    const allowsResize = properties.allowsResize === 'true';
    return buildRuleKey(properties.wmClass, {
        clientType: properties.clientType,
        windowType: Number(properties.windowType ?? WindowType.NORMAL),
        hasParent: properties.hasParent === 'true',
        allowsResize,
        isAttachedDialog: properties.isAttachedDialog === 'true',
        hasRing: properties.hasRing === 'true',
        width: !allowsResize && properties.width ? Number(properties.width) : null,
        height: !allowsResize && properties.height ? Number(properties.height) : null,
    });
}
