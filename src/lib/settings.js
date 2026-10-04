import GLib from 'gi://GLib';
import {sanitizeRuleTitles, sanitizeWindowRules} from './rules.js';

export const SETTINGS_KEY_WINDOW_RULES = 'window-rules';

/**
 * Validates and normalizes raw entries dictionary in a single pass.
 * @param {Record<string, {state?: string, title?: string}>} raw
 * @returns {Record<string, {state: string, title: string}>}
 */
export function sanitizeEntries(raw) {
    const rawStates = {};
    const rawTitles = {};

    for (const [key, entry] of Object.entries(raw ?? {})) {
        if (entry && typeof entry === 'object') {
            rawStates[key] = entry.state;
            rawTitles[key] = entry.title;
        }
    }

    const states = sanitizeWindowRules(rawStates);
    const titles = sanitizeRuleTitles(rawTitles);

    const entries = {};
    for (const [key, state] of Object.entries(states)) {
        entries[key] = {
            state,
            title: titles[key] ?? '',
        };
    }
    return entries;
}

/**
 * One entry per rule: active state and display sample title.
 * @param {object} settings
 * @returns {Record<string, {state: string, title: string}>}
 */
export function readEntries(settings) {
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
 * Updates or inserts a single rule entry and its display-only title.
 * @param {object} settings @param {string} key @param {string} state @param {string} [title='']
 */
export function setWindowRule(settings, key, state, title = '') {
    const entries = readEntries(settings);
    const nextEntries = {...entries};
    nextEntries[key] = {
        state,
        title: title ?? '',
    };
    setAllRuleEntries(settings, nextEntries);
}

/**
 * Writes raw entries map directly after sanitization.
 * @param {object} settings
 * @param {Record<string, {state: string, title?: string}>} entries
 */
export function setAllRuleEntries(settings, entries) {
    writeEntries(settings, entries);
}

/**
 * Serializes active window rules into a canonical JSON export string.
 * @param {Record<string, {state: string, title?: string}>} entries
 * @returns {string} Formatted JSON string
 */
export function exportRulesJson(entries) {
    const clean = sanitizeEntries(entries);
    const rules = {};
    for (const [key, entry] of Object.entries(clean)) {
        const rule = {state: entry.state};
        if (entry.title)
            rule.title = entry.title;
        rules[key] = rule;
    }
    const payload = {
        version: 1,
        rules,
    };
    return JSON.stringify(payload, null, 2);
}

/**
 * Parses and sanitizes rules from JSON text, separating non-conflicting entries from conflicts.
 * @param {Record<string, {state: string, title: string}>} existingEntries
 * @param {string} jsonText
 * @returns {{
 *   hasConflicts: boolean,
 *   nextEntries?: Record<string, {state: string, title: string}>,
 *   addedCount?: number,
 *   updatedCount?: number,
 *   conflicts?: Array<{key: string, existingState: string, importedState: string, existingTitle: string, importedTitle: string}>,
 *   nonConflictingEntries?: Record<string, {state: string, title: string}>,
 *   cleanImported?: Record<string, {state: string, title: string}>,
 *   importedKeys: string[],
 * }}
 */
export function importRulesJson(existingEntries, jsonText) {
    if (!jsonText || !jsonText.trim())
        throw new Error('Empty clipboard or content');

    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    } catch {
        throw new Error('Invalid JSON format');
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('Invalid rules payload');

    let rawRules = null;
    if (parsed.version !== undefined) {
        if (parsed.version !== 1)
            throw new Error(`Unsupported format version: ${parsed.version}`);
        if (parsed.rules && typeof parsed.rules === 'object' && !Array.isArray(parsed.rules))
            rawRules = parsed.rules;
    } else if (parsed.rules && typeof parsed.rules === 'object' && !Array.isArray(parsed.rules)) {
        rawRules = parsed.rules;
    } else {
        rawRules = parsed;
    }

    if (!rawRules || Object.keys(rawRules).length === 0)
        throw new Error('No rules found in content');

    const candidateRaw = {};
    for (const [key, val] of Object.entries(rawRules)) {
        if (val && typeof val === 'object') {
            candidateRaw[key] = {
                state: val.state,
                title: val.title,
            };
        } else if (typeof val === 'string') {
            candidateRaw[key] = {
                state: val,
                title: '',
            };
        }
    }
    const cleanImported = sanitizeEntries(candidateRaw);
    const importedKeys = Object.keys(cleanImported);
    if (importedKeys.length === 0)
        throw new Error('No valid rules found');

    const conflicts = [];
    const nonConflictingEntries = {...existingEntries};
    let addedCount = 0;
    let updatedCount = 0;

    for (const [key, importedEntry] of Object.entries(cleanImported)) {
        const existing = existingEntries[key];
        if (!existing) {
            nonConflictingEntries[key] = {
                state: importedEntry.state,
                title: importedEntry.title,
            };
            addedCount++;
        } else if (existing.state !== importedEntry.state) {
            conflicts.push({
                key,
                existingState: existing.state,
                importedState: importedEntry.state,
                existingTitle: existing.title || '',
                importedTitle: importedEntry.title || '',
            });
        } else {
            // Same state: supplement title if existing title is empty
            const titleSupplemented = Boolean(!existing.title && importedEntry.title);
            if (titleSupplemented) {
                nonConflictingEntries[key] = {
                    ...existing,
                    title: importedEntry.title,
                };
                updatedCount++;
            }
        }
    }

    if (conflicts.length > 0) {
        return {
            hasConflicts: true,
            conflicts,
            nonConflictingEntries,
            cleanImported,
            importedKeys,
        };
    }

    return {
        hasConflicts: false,
        nextEntries: nonConflictingEntries,
        addedCount,
        updatedCount,
        importedKeys,
    };
}

/**
 * Applies user conflict resolutions and merges with non-conflicting entries.
 * @param {Record<string, {state: string, title?: string}>} existingEntries
 * @param {Record<string, {state: string, title?: string}>} nonConflictingEntries
 * @param {Record<string, {state: string, title?: string}>} cleanImported
 * @param {Record<string, 'existing'|'imported'>} resolutions
 * @returns {{nextEntries: Record<string, object>, resolvedUpdatedCount: number}}
 */
export function applyConflictResolutions(existingEntries, nonConflictingEntries, cleanImported, resolutions) {
    const nextEntries = {...nonConflictingEntries};
    let resolvedUpdatedCount = 0;

    for (const [key, choice] of Object.entries(resolutions ?? {})) {
        const imported = cleanImported[key];
        const existing = existingEntries[key];
        if (!imported)
            continue;

        if (choice === 'imported') {
            nextEntries[key] = {
                state: imported.state,
                title: imported.title || existing?.title || '',
            };
            resolvedUpdatedCount++;
        } else if (existing) {
            nextEntries[key] = existing;
        }
    }

    return {
        nextEntries,
        resolvedUpdatedCount,
    };
}

/**
 * Read-modify-write over the one key. A rule write keeps the titles of surviving keys.
 */
function mergeEntries(entries, {rules = null}) {
    const merged = {};
    const keys = new Set([...Object.keys(entries), ...Object.keys(rules ?? {})]);
    for (const key of keys) {
        const stored = entries[key];
        const state = rules ? rules[key] ?? '' : stored?.state ?? '';
        const title = stored?.title ?? '';

        if (!state)
            continue;

        merged[key] = {state, title};
    }
    return merged;
}

// Coalesce writes: each write notifies Shell and re-evaluates every window.
function writeEntries(settings, entries) {
    const clean = sanitizeEntries(entries);
    const value = new GLib.Variant('a{sa{ss}}', clean);
    try {
        if (settings?.get_value?.(SETTINGS_KEY_WINDOW_RULES)?.equal(value))
            return;
    } catch {
        // Unreadable key: writing restores a known state.
    }
    settings?.set_value?.(SETTINGS_KEY_WINDOW_RULES, value);
}

function readValue(settings, key) {
    try {
        return settings?.get_value?.(key)?.deep_unpack() ?? null;
    } catch {
        return null;
    }
}
