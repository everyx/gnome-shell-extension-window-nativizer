/**
 * Settings - GSettings IO adapter for Window Nativizer.
 *
 * Responsibilities:
 *   - Reads and deserializes the window rule map (a{ss})
 *   - Serializes and saves updated rules back to GSettings
 *   - Isolates GSettings IO from pure detection and rule resolution logic
 */

import GLib from 'gi://GLib';
import {sanitizeWindowRules} from './rules.js';

/** Window-kind fingerprint -> state, which names the axes that are ours. */
export const SETTINGS_KEY_WINDOW_RULES = 'window-rules';

/**
 * Reads and sanitizes the window rule map from GSettings.
 *
 * @param {object} settings - GSettings object
 * @returns {Record<string, string>} canonical key -> RuleState value
 */
export function getWindowRules(settings) {
    return sanitizeWindowRules(readRules(settings, SETTINGS_KEY_WINDOW_RULES));
}

/**
 * Saves the window rule map to GSettings.
 *
 * @param {object} settings - GSettings object
 * @param {Record<string, string>} rules
 */
export function setWindowRules(settings, rules) {
    writeRules(settings, SETTINGS_KEY_WINDOW_RULES, sanitizeWindowRules(rules));
}

/**
 * Writes the rule map, unless it already holds exactly these rules. Every write
 * notifies the Shell side, which then re-evaluates every tracked window.
 */
function writeRules(settings, key, rules) {
    const value = new GLib.Variant('a{ss}', rules);
    try {
        if (settings?.get_value?.(key)?.equal(value))
            return;
    } catch {
        // Unreadable key: writing it is the way back to a known state.
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
