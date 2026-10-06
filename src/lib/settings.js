import GLib from 'gi://GLib';
import {kindId, sanitizeRules} from './rules.js';

export const SETTINGS_KEY_WINDOW_RULES = 'window-rules-v2';

/**
 * Flattens an in-memory entry into the stored record. The settings layer is the only
 * place that knows the on-disk spelling of a kind.
 * @param {{kind: object, state: string, title?: string}} entry
 * @returns {object}
 */
function recordFromEntry({kind, state, title}) {
    return {
        identity: kind.identity,
        client_type: kind.clientType,
        window_type: kind.windowType,
        has_parent: kind.hasParent,
        allows_resize: kind.allowsResize,
        attached_dialog: kind.attachedDialog,
        has_ring: kind.hasRing,
        has_ssd: kind.hasSsd,
        width: kind.width ?? 0,
        height: kind.height ?? 0,
        state,
        title: title ?? '',
    };
}

/**
 * Accepts either the raw record array GSettings hands back or a UI entry map keyed by
 * kindId, and returns the record array sanitizeRules validates.
 * @param {*} raw
 * @returns {Array<object>}
 */
function asRecords(raw) {
    if (Array.isArray(raw))
        return raw;
    if (!raw || typeof raw !== 'object')
        return [];
    return Object.values(raw)
        .filter(entry => entry && typeof entry === 'object' && entry.kind && typeof entry.kind === 'object')
        .map(recordFromEntry);
}

/**
 * Validates and normalizes raw entries in a single pass.
 * @param {*} raw - Raw stored records, or UI entries keyed by kindId
 * @returns {Record<string, {kind: object, state: string, title: string}>}
 */
export function sanitizeEntries(raw) {
    const entries = {};
    for (const rule of sanitizeRules(asRecords(raw)))
        entries[kindId(rule.kind)] = rule;
    return entries;
}

/**
 * One entry per rule: the kind, its active state, and a display-only sample title.
 * @param {object} settings
 * @returns {Record<string, {kind: object, state: string, title: string}>}
 */
export function readEntries(settings) {
    return sanitizeEntries(readValue(settings, SETTINGS_KEY_WINDOW_RULES));
}

/** @param {object} settings @returns {Array<{kind: object, state: string, title: string}>} */
export function getWindowRules(settings) {
    return Object.values(readEntries(settings));
}

/** @param {object} settings @returns {Record<string, string>} kindId -> title */
export function getRuleTitles(settings) {
    const titles = {};
    for (const [id, entry] of Object.entries(readEntries(settings))) {
        if (entry.title)
            titles[id] = entry.title;
    }
    return titles;
}

/**
 * Updates or inserts a single rule entry and its display-only title.
 * @param {object} settings @param {object} kind @param {string} state @param {string} [title='']
 */
export function setWindowRule(settings, kind, state, title = '') {
    const entries = readEntries(settings);
    const nextEntries = {...entries};
    nextEntries[kindId(kind)] = {
        kind,
        state,
        title: title ?? '',
    };
    setAllRuleEntries(settings, nextEntries);
}

/**
 * Writes the UI entry map directly after sanitization.
 * @param {object} settings
 * @param {Record<string, {kind: object, state: string, title?: string}>} entries
 */
export function setAllRuleEntries(settings, entries) {
    writeEntries(settings, entries);
}

/**
 * Serializes active window rules into a canonical JSON export string.
 * @param {Record<string, {kind: object, state: string, title?: string}>} entries
 * @returns {string} Formatted JSON string
 */
export function exportRulesJson(entries) {
    const clean = sanitizeEntries(entries);
    const rules = Object.values(clean).map(recordFromEntry);
    return JSON.stringify({version: 2, rules}, null, 2);
}

/**
 * Parses and sanitizes rules from JSON text, separating non-conflicting entries from conflicts.
 * @param {Record<string, {kind: object, state: string, title: string}>} existingEntries
 * @param {string} jsonText
 * @returns {{
 *   hasConflicts: boolean,
 *   nextEntries?: Record<string, {kind: object, state: string, title: string}>,
 *   addedCount?: number,
 *   updatedCount?: number,
 *   conflicts?: Array<{key: string, kind: object, existingState: string, importedState: string, existingTitle: string, importedTitle: string}>,
 *   nonConflictingEntries?: Record<string, {kind: object, state: string, title: string}>,
 *   cleanImported?: Record<string, {kind: object, state: string, title: string}>,
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

    if (!parsed || typeof parsed !== 'object')
        throw new Error('Invalid rules payload');

    let rawRules = null;
    if (Array.isArray(parsed)) {
        rawRules = parsed;
    } else {
        // The field-based payload is the second shape this key has had. The first one is refused
        // by version rather than translated: a translator would keep the old grammar alive for a
        // shape nothing writes any more.
        if (parsed.version !== undefined && parsed.version !== 2)
            throw new Error(`Unsupported format version: ${parsed.version} (only the current format can be imported)`);
        if (Array.isArray(parsed.rules))
            rawRules = parsed.rules;
    }

    if (!rawRules || rawRules.length === 0)
        throw new Error('No rules found in content');

    const cleanImported = sanitizeEntries(rawRules);
    const importedKeys = Object.keys(cleanImported);
    if (importedKeys.length === 0)
        throw new Error('No valid rules found');

    const conflicts = [];
    const nonConflictingEntries = {...existingEntries};
    let addedCount = 0;
    let updatedCount = 0;

    for (const [id, importedEntry] of Object.entries(cleanImported)) {
        const existing = existingEntries[id];
        if (!existing) {
            nonConflictingEntries[id] = {
                kind: importedEntry.kind,
                state: importedEntry.state,
                title: importedEntry.title,
            };
            addedCount++;
        } else if (existing.state !== importedEntry.state) {
            conflicts.push({
                key: id,
                kind: importedEntry.kind,
                existingState: existing.state,
                importedState: importedEntry.state,
                existingTitle: existing.title || '',
                importedTitle: importedEntry.title || '',
            });
        } else {
            // Same state: supplement title if existing title is empty
            const titleSupplemented = Boolean(!existing.title && importedEntry.title);
            if (titleSupplemented) {
                nonConflictingEntries[id] = {
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
 * @param {Record<string, {kind: object, state: string, title?: string}>} existingEntries
 * @param {Record<string, {kind: object, state: string, title?: string}>} nonConflictingEntries
 * @param {Record<string, {kind: object, state: string, title?: string}>} cleanImported
 * @param {Record<string, 'existing'|'imported'>} resolutions
 * @returns {{nextEntries: Record<string, object>, resolvedUpdatedCount: number}}
 */
export function applyConflictResolutions(existingEntries, nonConflictingEntries, cleanImported, resolutions) {
    const nextEntries = {...nonConflictingEntries};
    let resolvedUpdatedCount = 0;

    for (const [id, choice] of Object.entries(resolutions ?? {})) {
        const imported = cleanImported[id];
        const existing = existingEntries[id];
        if (!imported)
            continue;

        if (choice === 'imported') {
            nextEntries[id] = {
                kind: imported.kind,
                state: imported.state,
                title: imported.title || existing?.title || '',
            };
            resolvedUpdatedCount++;
        } else if (existing) {
            nextEntries[id] = existing;
        }
    }

    return {
        nextEntries,
        resolvedUpdatedCount,
    };
}

/** @param {{kind: object, state: string, title: string}} entry @returns {object} A dict of wrapped variants for `aa{sv}` */
function entryToVariant(entry) {
    const record = recordFromEntry(entry);
    return {
        identity: new GLib.Variant('s', record.identity),
        client_type: new GLib.Variant('s', record.client_type),
        window_type: new GLib.Variant('i', record.window_type),
        has_parent: new GLib.Variant('b', record.has_parent),
        allows_resize: new GLib.Variant('b', record.allows_resize),
        attached_dialog: new GLib.Variant('b', record.attached_dialog),
        has_ring: new GLib.Variant('b', record.has_ring),
        has_ssd: new GLib.Variant('b', record.has_ssd),
        width: new GLib.Variant('i', record.width),
        height: new GLib.Variant('i', record.height),
        state: new GLib.Variant('s', record.state),
        title: new GLib.Variant('s', record.title),
    };
}

// Coalesce writes: each write notifies Shell and re-evaluates every window.
function writeEntries(settings, entries) {
    const clean = sanitizeEntries(entries);
    const value = new GLib.Variant('aa{sv}', Object.values(clean).map(entryToVariant));
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
        const variant = settings?.get_value?.(key) ?? null;
        if (!variant)
            return null;
        if (typeof variant.recursiveUnpack === 'function')
            return variant.recursiveUnpack();
        return unwrapRecordVariants(variant.deep_unpack());
    } catch {
        return null;
    }
}

// `a{sv}` holds a variant per value; deep_unpack leaves them wrapped on GJS versions
// without recursiveUnpack, so unwrap each leaf before the parser sees it.
function unwrapRecordVariants(records) {
    if (!Array.isArray(records))
        return records;
    return records.map(record => {
        if (!record || typeof record !== 'object')
            return record;
        const out = {};
        for (const [field, value] of Object.entries(record))
            out[field] = value && typeof value.deepUnpack === 'function' ? value.deepUnpack() : value;
        return out;
    });
}
