// GSettings IO for window rules — see docs/rule-model.md.

import GLib from 'gi://GLib';
import {sanitizeRuleTitles, sanitizeWindowRules} from './rules.js';

export const SETTINGS_KEY_WINDOW_RULES = 'window-rules';

/**
 * Validates and normalizes raw entries dictionary in a single pass.
 * @param {Record<string, {state?: string, title?: string}>} raw
 * @returns {Record<string, {state: string, title: string}>}
 */
function sanitizeEntries(raw) {
    const rawStates = {};
    const rawTitles = {};
    for (const [key, entry] of Object.entries(raw ?? {})) {
        if (entry) {
            rawStates[key] = entry.state;
            rawTitles[key] = entry.title;
        }
    }
    const states = sanitizeWindowRules(rawStates);
    const titles = sanitizeRuleTitles(rawTitles);
    const entries = {};
    for (const [key, state] of Object.entries(states))
        entries[key] = {state, title: titles[key] ?? ''};
    return entries;
}

/**
 * One entry per rule: the axes to reverse, and the display-only title - see
 * docs/rule-model.md § What the pick remembers for the row.
 * @param {object} settings
 * @returns {Record<string, {state: string, title: string}>}
 */
function readEntries(settings) {
    return sanitizeEntries(readValue(settings, SETTINGS_KEY_WINDOW_RULES));
}

/** @param {object} settings @returns {Record<string,string>} Canonical key -> axis state */
export function getWindowRules(settings) {
    return Object.fromEntries(
        Object.entries(readEntries(settings)).map(([key, entry]) => [key, entry.state]));
}

/** @param {object} settings @returns {Record<string,string>} Canonical key -> title */
export function getRuleTitles(settings) {
    return Object.fromEntries(
        Object.entries(readEntries(settings))
            .filter(([, entry]) => entry.title)
            .map(([key, entry]) => [key, entry.title]));
}

/** @param {object} settings @param {Record<string,string>} rules */
export function setWindowRules(settings, rules) {
    writeEntries(settings, mergeEntries(readEntries(settings), {rules}));
}

/**
 * One entry, one write - see docs/rule-model.md § What the pick remembers for the row.
 * @param {object} settings @param {string} key @param {string} state @param {string} title
 */
export function setWindowRule(settings, key, state, title) {
    writeEntries(settings, mergeEntries(readEntries(settings), {
        upsert: {[key]: {state, title: title ?? ''}},
    }));
}

/**
 * Read-modify-write over the one key. A rule write keeps the titles of the keys that survive
 * and drops the rest with their rules; a title write keeps every state.
 */
function mergeEntries(entries, {rules = null, upsert = null}) {
    const merged = {};
    // The union of both sides; `rules` is authoritative, `upsert` touches one key only.
    const keys = new Set([...Object.keys(entries), ...Object.keys(rules ?? upsert ?? {})]);
    for (const key of keys) {
        const stored = entries[key];
        const state = rules ? rules[key] ?? '' : upsert?.[key]?.state ?? stored?.state ?? '';
        if (!state)
            continue;
        merged[key] = {
            state,
            title: rules ? stored?.title ?? '' : upsert?.[key]?.title ?? stored?.title ?? '',
        };
    }
    return merged;
}

// Coalesce writes: each write notifies Shell and re-evaluates every window.
function writeEntries(settings, entries) {
    // The one place both halves are validated, whatever wrote them.
    const clean = sanitizeEntries(entries);
    const value = new GLib.Variant('a{sa{ss}}', clean);
    try {
        if (settings?.get_value?.(SETTINGS_KEY_WINDOW_RULES)?.equal(value))
            return;
    } catch {
        // Unreadable key: writing restores a known state.
    }
    settings.set_value(SETTINGS_KEY_WINDOW_RULES, value);
}

function readValue(settings, key) {
    try {
        const value = settings?.get_value?.(key);
        return value ? value.deep_unpack() : {};
    } catch {
        return {};
    }
}
