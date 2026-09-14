// GSettings IO for window rules — see docs/rule-model.md.

import GLib from 'gi://GLib';
import {sanitizeWindowRules} from './rules.js';

export const SETTINGS_KEY_WINDOW_RULES = 'window-rules';

/** @param {object} settings @returns {Record<string,string>} */
export function getWindowRules(settings) {
    return sanitizeWindowRules(readRules(settings, SETTINGS_KEY_WINDOW_RULES));
}

/** @param {object} settings @param {Record<string,string>} rules */
export function setWindowRules(settings, rules) {
    writeRules(settings, SETTINGS_KEY_WINDOW_RULES, sanitizeWindowRules(rules));
}

// Coalesce writes: each write notifies Shell and re-evaluates every window.
function writeRules(settings, key, rules) {
    const value = new GLib.Variant('a{ss}', rules);
    try {
        if (settings?.get_value?.(key)?.equal(value))
            return;
    } catch {
        // Unreadable key: writing restores a known state.
    }
    settings.set_value(key, value);
}

function readRules(settings, key) {
    try {
        const value = settings?.get_value?.(key);
        return value ? value.deep_unpack() : {};
    } catch {
        return {};
    }
}
