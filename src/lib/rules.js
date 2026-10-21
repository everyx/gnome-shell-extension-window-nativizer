import {journal} from '../platform/journal.js';
import {WindowType} from './mutterRules.generated.js';

export const CLIENT_TYPE_TOKEN_WAYLAND = 'wayland';
export const CLIENT_TYPE_TOKEN_X11 = 'x11';

export const RuleAxis = Object.freeze({
    CORNERS: 'corners',
    SHADOW: 'shadow',
    RESIZE: 'resize',
});
export const RULE_AXES = Object.freeze([
    RuleAxis.CORNERS, RuleAxis.SHADOW, RuleAxis.RESIZE,
]);

/**
 * Parse a stored state: the axes whose automatic decision the user reversed,
 * comma-separated in canonical order. '' (no axis) is valid and means no rule.
 * @returns Null when not valid stored grammar
 */
export function parseRuleState(state) {
    if (typeof state !== 'string')
        return null;

    const axes = new Set();
    if (state === '')
        return axes;

    // Order is part of the format: prefs always renders canonically, so string
    // comparison is enough to match, and a hand-edited misorder is dropped loudly.
    let lastIndex = -1;
    for (const part of state.split(',')) {
        const index = RULE_AXES.indexOf(part);
        if (index <= lastIndex)
            return null;
        lastIndex = index;
        axes.add(part);
    }
    return axes;
}

/**
 * Renders the canonical stored form: the reversed axes in canonical order, e.g.
 * 'corners,shadow'. Nothing reversed renders as '' (no rule to store).
 */
export function buildRuleState(axes = null) {
    const reversed = new Set(axes ?? []);
    return RULE_AXES.filter(axis => reversed.has(axis)).join(',');
}

/**
 * @returns 'true' or 'false'
 */
export function boolString(value) {
    return value ? 'true' : 'false';
}

/**
 * Splits a rule key into identity and specifier at the last colon.
 */
function splitRuleKey(key) {
    const sep = key.lastIndexOf(':');
    return {identity: key.slice(0, sep), specifier: key.slice(sep + 1)};
}

/**
 * Normalizes rule key identity to lowercase for case-insensitive matching.
 */
function canonicalRuleKey(key) {
    const {identity, specifier} = splitRuleKey(key);
    return `${identity.toLowerCase()}:${specifier}`;
}

const WINDOW_BACKED_APP_ID_PATTERN = /^window:\d+$/;

export function isWindowBackedAppId(appId) {
    return WINDOW_BACKED_APP_ID_PATTERN.test(appId);
}

/**
 * @returns Identity or '' when nothing identifies the window
 */
export function chooseWindowIdentity({declared = '', peer = '', tracked = '', pid = -1} = {}) {
    if (declared?.trim())
        return declared.trim();
    if (peer?.trim())
        return peer.trim();
    if (tracked && !isWindowBackedAppId(tracked))
        return tracked;
    // pid changes on restart, so a rule keyed on it is session-scoped.
    return pid > 0 ? `pid-${pid}` : '';
}

const BOOL_FIELD = '(?:true|false)';

/**
 * The structural attributes that key a rule, in canonical order, and the only statement of the field
 * set: `name` (specifier spelling), `key` (kind object), `reading` (window reading, where it differs),
 * `fallback`, `pattern`, `text` (value to stored form) and `parse` (stored form to value).
 */
export const FINGERPRINT_FIELDS = [
    {
        name: 'client_type',
        key: 'clientType',
        reading: 'clientTypeToken',
        fallback: CLIENT_TYPE_TOKEN_WAYLAND,
        pattern: `(?:${CLIENT_TYPE_TOKEN_WAYLAND}|${CLIENT_TYPE_TOKEN_X11})`,
        text: value => value,
        parse: raw => raw,
    },
    {
        name: 'window_type',
        key: 'windowType',
        fallback: WindowType.NORMAL,
        pattern: '\\d+',
        text: value => String(value),
        parse: raw => Number(raw ?? WindowType.NORMAL),
    },
    boolField('has_parent', 'hasParent', false),
    boolField('allows_resize', 'allowsResize', true),
    boolField('attached_dialog', 'isAttachedDialog', false),
    boolField('has_ring', 'hasRing', false),
    boolField('has_ssd', 'hasSsd', false),
];

/**
 * @returns One boolean attribute's table entry: the grammar every boolean shares, its fallback and
 * the two conversions, which are the same in both directions.
 */
function boolField(name, key, fallback) {
    return {name, key, fallback, pattern: BOOL_FIELD, text: boolString, parse: raw => raw === 'true'};
}

const FINGERPRINT_MAP = Object.freeze(
    Object.fromEntries(FINGERPRINT_FIELDS.map(f => [f.name, f]))
);

/**
 * Reads the seven structural attributes out of a caller's kind object, applying each field's fallback
 * for an omitted one. A kind may carry more than these (`width`, `height`, `frameWidth`, ...); those
 * are the key builder's own business.
 *
 * @returns Keyed by each field's `key`
 */
function readKind(kind = {}) {
    const fields = {};
    for (const field of FINGERPRINT_FIELDS) {
        const value = kind?.[field.key];
        fields[field.key] = value === undefined ? field.fallback : value;
    }
    return fields;
}

// Fixed-size windows (allows_resize=false) may optionally include a size=WxH suffix
// to distinguish different dialogs/toolbars of the same kind. Resizable windows MUST NOT have size.
// The identity is opaque - it may hold ':' and spaces - so this pins only the specifier and
// requires a nonempty identity ahead of the last ':'. The specifier has no ':' of its own.
const SIZE_SUFFIX = ',size=\\d+x\\d+';

/**
 * One shape's specifier grammar, built from the table with the attributes that shape pins. The two
 * shapes are the only structural rule the pattern adds to the table: a fixed-size key may carry a
 * size, a resizable one may not.
 */
function specifierPattern(pinned) {
    return FINGERPRINT_FIELDS
        .map(field => `${field.name}=${pinned[field.name] ?? field.pattern}`)
        .join(',');
}

const VALID_RULE_KEY_PATTERN = new RegExp(
    '^[\\s\\S]+:(?:' +
    `${specifierPattern({allows_resize: 'false'})}(?:${SIZE_SUFFIX})?|` +
    `${specifierPattern({allows_resize: 'true'})}` +
    ')$'
);

/**
 * @param [kind.width=null] - Fixed logical width (only valid when allowsResize is false)
 * @param [kind.height=null] - Fixed logical height (only valid when allowsResize is false)
 * @returns Canonical key or '' when wmClass is missing
 * @throws When the rendered specifier is not colon-free (a field the table cannot own)
 */
export function buildRuleKey(wmClass, kind = {}) {
    if (!wmClass?.trim())
        return '';

    const fields = readKind(kind);
    let specifier = FINGERPRINT_FIELDS
        .map(field => `${field.name}=${field.text(fields[field.key])}`)
        .join(',');

    const w = Number(kind.width);
    const h = Number(kind.height);
    if (!fields.allowsResize && Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0)
        specifier += `,size=${Math.round(w)}x${Math.round(h)}`;

    // Nothing escapes the identity, so a ':' in the specifier would move the last-':' separator.
    // Fail loudly here rather than let resolveRule look the kind up under a different key.
    if (specifier.includes(':'))
        throw new Error(`rule specifier is not colon-free: ${specifier}`);

    return `${wmClass.toLowerCase()}:${specifier}`;
}

/**
 * Sanitizes window titles associated with picked rules (display only, keyed by canonical rule key).
 * @returns Canonical key -> one-line title
 */
export function sanitizeRuleTitles(rawTitles = {}) {
    if (!rawTitles || typeof rawTitles !== 'object')
        return {};

    const clean = {};
    const seenKeys = new Map();
    for (const [key, title] of Object.entries(rawTitles)) {
        if (!VALID_RULE_KEY_PATTERN.test(key) || typeof title !== 'string')
            continue;
        // One line beside an app name: a newline would break the row.
        const oneLine = title.replace(/[\r\n]+/g, ' ').trim();
        if (!oneLine)
            continue;
        // Same canonicalisation as the states, or a mixed-case stored key would land under
        // its lowercased state key and lose its title on the next write.
        const canonicalKey = canonicalRuleKey(key);
        if (seenKeys.has(canonicalKey)) {
            journal.warn(`Dropping case-colliding title key "${key}" (conflicts with "${seenKeys.get(canonicalKey)}")`);
            continue;
        }
        seenKeys.set(canonicalKey, key);
        clean[canonicalKey] = oneLine;
    }
    return clean;
}

/**
 * @returns Canonical key -> canonical axis state
 */
export function sanitizeWindowRules(rawRules = {}) {
    if (!rawRules || typeof rawRules !== 'object')
        return {};

    const clean = {};
    const seenKeys = new Map();

    for (const [key, state] of Object.entries(rawRules)) {
        if (!VALID_RULE_KEY_PATTERN.test(key)) {
            journal.warn(`Dropping invalid rule key: "${key}"`);
            continue;
        }

        const axes = parseRuleState(state);
        if (!axes) {
            journal.warn(`Dropping rule with invalid state: "${state}" for key "${key}"`);
            continue;
        }

        // Nothing reversed is no rule: drop the row rather than store ''.
        const canonical = buildRuleState(axes);
        if (!canonical)
            continue;

        const canonicalKey = canonicalRuleKey(key);
        if (seenKeys.has(canonicalKey)) {
            const existingKey = seenKeys.get(canonicalKey);
            journal.warn(`Dropping case-colliding rule key "${key}" (conflicts with "${existingKey}")`);
            continue;
        }

        seenKeys.set(canonicalKey, key);
        clean[canonicalKey] = canonical;
    }

    return clean;
}

/**
 * Stores a state, canonicalising it first. A state with nothing reversed ('') stores
 * nothing: it is the same as having no rule, so the key is removed.
 */
export function withRule(rules = {}, key, state) {
    const axes = parseRuleState(state);
    if (!axes)
        throw new Error(`unknown rule state: ${state}`);
    const next = {...rules};
    const canonical = buildRuleState(axes);
    if (!canonical)
        delete next[key];
    else
        next[key] = canonical;
    return next;
}

export function parseRuleKey(key) {
    if (!key || typeof key !== 'string' || !VALID_RULE_KEY_PATTERN.test(key))
        return {baseWmClass: '', specifier: null, properties: null};

    const {identity: baseWmClass, specifier} = splitRuleKey(key);

    const properties = {};
    for (const pair of specifier.split(',')) {
        const eqIdx = pair.indexOf('=');
        const name = pair.slice(0, eqIdx);
        const val = pair.slice(eqIdx + 1);
        if (name === 'size') {
            properties.size = val;
            const [w, h] = val.split('x').map(Number);
            properties.width = w;
            properties.height = h;
            continue;
        }
        const field = FINGERPRINT_MAP[name];
        if (field)
            properties[name] = field.parse(val);
    }

    return {baseWmClass, specifier, properties};
}

/**
 * @returns The reversed axes, or null when no rule matched
 */
export function resolveRule(wmClass, rules = {}, kind = {}) {
    if (!wmClass)
        return null;

    const {frameWidth = null, frameHeight = null} = kind;
    const fields = readKind(kind);

    const isFixed = !fields.allowsResize && Number.isFinite(frameWidth) && Number.isFinite(frameHeight) && frameWidth > 0 && frameHeight > 0;

    const has = key => Boolean(key && Object.prototype.hasOwnProperty.call(rules, key));
    const lookup = key => has(key)
        ? parseRuleState(rules[key])
        : null;

    // 1. For fixed-size windows with known dimensions, prefer an exact-size rule.
    if (isFixed) {
        const exactKey = buildRuleKey(wmClass, {...fields, width: frameWidth, height: frameHeight});
        const matched = lookup(exactKey);
        if (matched)
            return matched;
    }

    // 2. Generic rule key as fallback for fixed-size, or primary for resizable.
    const genericKey = buildRuleKey(wmClass, fields);

    if (has(genericKey))
        return parseRuleState(rules[genericKey]);
    return null;
}

/**
 * @returns The kind the picker's wire dictionary describes. Its values are strings, so each one goes
 * through the field's own converter - the form both processes share.
 */
export function kindFromWire(properties = {}) {
    const kind = {};
    for (const field of FINGERPRINT_FIELDS)
        kind[field.key] = field.parse(properties?.[field.key]);
    return kind;
}

/**
 * @returns The kind a parsed rule key describes. parseRuleKey has already given every field its typed
 * value, so this only renames them, filling an omission with the field's fallback.
 */
export function kindFromSpecifier(specifier = {}) {
    const kind = {};
    for (const field of FINGERPRINT_FIELDS) {
        const value = specifier?.[field.name];
        kind[field.key] = value === undefined ? field.fallback : value;
    }
    return kind;
}

/**
 * The picker's property dictionary for a window reading: the same seven attributes the rule key
 * stores, rendered by the same table.
 */
export function fingerprintProperties(reading) {
    const fields = kindFromReading(reading);
    const properties = {};
    for (const field of FINGERPRINT_FIELDS)
        properties[field.key] = String(field.text(fields[field.key]));
    return properties;
}

/**
 * @returns The seven attributes read off a window reading, keyed by their kind-object names. Two
 * reads sit under a different name on a reading (`clientTypeToken`), which the table records.
 */
function kindFromReading(reading) {
    const kind = {};
    for (const field of FINGERPRINT_FIELDS)
        kind[field.key] = reading?.[field.reading ?? field.key];
    return readKind(kind);
}

export function buildRuleKeyFromProperties(properties = {}) {
    const kind = kindFromWire(properties);
    return buildRuleKey(properties.wmClass, {
        ...kind,
        width: !kind.allowsResize && properties.width ? Number(properties.width) : null,
        height: !kind.allowsResize && properties.height ? Number(properties.height) : null,
    });
}
