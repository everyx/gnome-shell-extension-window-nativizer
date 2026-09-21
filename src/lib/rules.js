// Window-kind rule model — see docs/rule-model.md; pure logic, unit-testable.

import {WindowType} from './mutterRules.generated.js';

/** D-Bus / rule-key tokens for the client-type field. */
export const CLIENT_TYPE_TOKEN_WAYLAND = 'wayland';
export const CLIENT_TYPE_TOKEN_X11 = 'x11';

export const RuleAxis = Object.freeze({
    CORNERS: 'corners',
    SHADOW: 'shadow',
    RESIZE: 'resize',
});
/** Canonical axis order in stored states. */
export const RULE_AXES = Object.freeze([
    RuleAxis.CORNERS, RuleAxis.SHADOW, RuleAxis.RESIZE,
]);

/**
 * Parse a stored state: the axes whose automatic decision the user reversed,
 * comma-separated in canonical order. '' (no axis) is valid and means no rule.
 * @param {string} state
 * @returns {Set<string>|null} Null when not valid stored grammar
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
 * @param {Iterable<string>|null} [axes]
 * @returns {string}
 */
export function buildRuleState(axes = null) {
    const reversed = new Set(axes ?? []);
    return RULE_AXES.filter(axis => reversed.has(axis)).join(',');
}

/**
 * @param {*} value
 * @returns {string} 'true' or 'false'
 */
export function boolString(value) {
    return value ? 'true' : 'false';
}

/** Tolerates keys that were never encoded. */
function decodeIdentity(token) {
    try {
        return decodeURIComponent(token);
    } catch {
        return token;
    }
}

// Lowercased so 'WeChat'/'wechat' are the same kind.
function encodeIdentity(identity) {
    return encodeURIComponent(identity.toLowerCase());
}

/** Lowercases the identity part so old keys canonicalise on read. */
function normalizeRuleKey(key) {
    const colonIdx = key.indexOf(':');
    if (colonIdx < 0)
        return key;
    return `${encodeIdentity(decodeIdentity(key.slice(0, colonIdx)))}:${key.slice(colonIdx + 1)}`;
}

/** Shell's per-window placeholder for unattributed windows. */
const WINDOW_BACKED_APP_ID_PATTERN = /^window:\d+$/;

/**
 * @param {string} appId
 * @returns {boolean}
 */
export function isWindowBackedAppId(appId) {
    return WINDOW_BACKED_APP_ID_PATTERN.test(appId);
}

/**
 * @param {object} [candidates={}]
 * @param {string} [candidates.declared='']
 * @param {string} [candidates.peer='']
 * @param {string} [candidates.tracked='']
 * @param {number} [candidates.pid=-1]
 * @returns {string} Identity or '' when nothing identifies the window
 */
export function chooseWindowIdentity({declared = '', peer = '', tracked = '', pid = -1} = {}) {
    if (declared)
        return declared;
    if (peer)
        return peer;
    if (tracked && !isWindowBackedAppId(tracked))
        return tracked;
    // pid changes on restart, so a rule keyed on it is session-scoped.
    return pid > 0 ? `pid-${pid}` : '';
}

const BOOL_FIELD = '(?:true|false)';

const FINGERPRINT_FIELDS = [
    {
        name: 'client_type',
        render: o => o.clientType,
        parse: raw => raw,
    },
    {name: 'window_type', render: o => o.windowType, parse: raw => Number(raw)},
    {name: 'has_parent', render: o => boolString(o.hasParent), parse: raw => raw === 'true'},
    {name: 'allows_resize', render: o => boolString(o.allowsResize), parse: raw => raw === 'true'},
    {name: 'attached_dialog', render: o => boolString(o.isAttachedDialog), parse: raw => raw === 'true'},
    {name: 'has_ring', render: o => boolString(o.hasRing), parse: raw => raw === 'true'},
    {name: 'has_ssd', render: o => boolString(o.hasSsd), parse: raw => raw === 'true'},
];

// Fixed-size windows (allows_resize=false) may optionally include a size=WxH suffix
// to distinguish different dialogs/toolbars of the same kind. Resizable windows MUST NOT have size.
const VALID_RULE_KEY_PATTERN = new RegExp(
    '^[^\\s:]+:(?:' +
    `client_type=(?:${CLIENT_TYPE_TOKEN_WAYLAND}|${CLIENT_TYPE_TOKEN_X11}),window_type=\\d+,has_parent=${BOOL_FIELD},allows_resize=false,attached_dialog=${BOOL_FIELD},has_ring=${BOOL_FIELD},has_ssd=${BOOL_FIELD}(?:,size=\\d+x\\d+)?|` +
    `client_type=(?:${CLIENT_TYPE_TOKEN_WAYLAND}|${CLIENT_TYPE_TOKEN_X11}),window_type=\\d+,has_parent=${BOOL_FIELD},allows_resize=true,attached_dialog=${BOOL_FIELD},has_ring=${BOOL_FIELD},has_ssd=${BOOL_FIELD}` +
    ')$'
);

/**
 * @param {string} wmClass
 * @param {object} [props={}]
 * @param {string} [props.clientType='wayland']
 * @param {number} [props.windowType=WindowType.NORMAL]
 * @param {boolean} [props.hasParent=false]
 * @param {boolean} [props.allowsResize=true]
 * @param {boolean} [props.isAttachedDialog=false]
 * @param {boolean} [props.hasRing=false]
 * @param {boolean} [props.hasSsd=false]
 * @param {number|null} [props.width=null] - Fixed logical width (only valid when allowsResize is false)
 * @param {number|null} [props.height=null] - Fixed logical height (only valid when allowsResize is false)
 * @returns {string} Canonical key or '' when wmClass is missing
 */
export function buildRuleKey(wmClass, {
    clientType = CLIENT_TYPE_TOKEN_WAYLAND,
    windowType = WindowType.NORMAL,
    hasParent = false,
    allowsResize = true,
    isAttachedDialog = false,
    hasRing = false,
    hasSsd = false,
    width = null,
    height = null,
} = {}) {
    if (!wmClass)
        return '';

    const fields = {clientType, windowType, hasParent, allowsResize, isAttachedDialog, hasRing, hasSsd};
    let specifier = FINGERPRINT_FIELDS
        .map(field => `${field.name}=${field.render(fields)}`)
        .join(',');

    const w = Number(width);
    const h = Number(height);
    if (!allowsResize && Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0)
        specifier += `,size=${Math.round(w)}x${Math.round(h)}`;

    // ':'/whitespace delimit the grammar, so the identity is encoded.
    return `${encodeIdentity(wmClass)}:${specifier}`;
}

/**
 * @param {Record<string, string>} [rawRules={}]
 * @returns {Record<string, string>} Canonical key -> canonical axis state
 */
export function sanitizeWindowRules(rawRules = {}) {
    if (!rawRules || typeof rawRules !== 'object')
        return {};

    const clean = {};
    const seenKeys = new Map();

    for (const [key, state] of Object.entries(rawRules)) {
        if (!VALID_RULE_KEY_PATTERN.test(key)) {
            console.warn(`[window-nativizer] Dropping invalid rule key: "${key}"`);
            continue;
        }

        const axes = parseRuleState(state);
        if (!axes) {
            console.warn(`[window-nativizer] Dropping rule with invalid state: "${state}" for key "${key}"`);
            continue;
        }

        // Nothing reversed is no rule: drop the row rather than store ''.
        const canonical = buildRuleState(axes);
        if (!canonical)
            continue;

        const canonicalKey = normalizeRuleKey(key);
        if (seenKeys.has(canonicalKey)) {
            const existingKey = seenKeys.get(canonicalKey);
            console.warn(`[window-nativizer] Dropping case-colliding rule key "${key}" (conflicts with "${existingKey}")`);
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
 * @param {Record<string, string>} [rules={}]
 * @param {string} key
 * @param {string} state
 * @returns {Record<string, string>}
 */
export function withRule(rules = {}, key, state) {
    const axes = parseRuleState(state);
    if (!axes)
        throw new Error(`[window-nativizer] unknown rule state: ${state}`);
    const next = {...rules};
    const canonical = buildRuleState(axes);
    if (!canonical)
        delete next[key];
    else
        next[key] = canonical;
    return next;
}

/**
 * @param {string} key
 * @returns {{baseWmClass: string, specifier: string|null, properties: Record<string, string|number|boolean>|null}}
 */
export function parseRuleKey(key) {
    if (!key || typeof key !== 'string' || !VALID_RULE_KEY_PATTERN.test(key))
        return {baseWmClass: '', specifier: null, properties: null};

    const colonIdx = key.indexOf(':');
    const baseWmClass = decodeIdentity(key.slice(0, colonIdx));
    const specifier = key.slice(colonIdx + 1);

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
        const field = FINGERPRINT_FIELDS.find(f => f.name === name);
        if (field)
            properties[name] = field.parse(val);
    }

    return {baseWmClass, specifier, properties};
}

/**
 * @param {string} wmClass
 * @param {Record<string, string>} [rules={}]
 * @param {object} [options={}]
 * @param {string} [options.clientType='wayland']
 * @param {number} [options.windowType=WindowType.NORMAL]
 * @param {boolean} [options.hasParent=false]
 * @param {boolean} [options.allowsResize=true]
 * @param {boolean} [options.isAttachedDialog=false]
 * @param {boolean} [options.hasRing=false]
 * @param {boolean} [options.hasSsd=false]
 * @param {number|null} [options.frameWidth=null]
 * @param {number|null} [options.frameHeight=null]
 * @returns {Set<string>|null} The reversed axes, or null when no rule matched
 */
export function resolveRule(wmClass, rules = {}, options = {}) {
    if (!wmClass)
        return null;

    const {
        clientType = CLIENT_TYPE_TOKEN_WAYLAND,
        windowType = WindowType.NORMAL,
        hasParent = false,
        allowsResize = true,
        isAttachedDialog = false,
        hasRing = false,
        hasSsd = false,
        frameWidth = null,
        frameHeight = null,
    } = options;

    const isFixed = !allowsResize && Number.isFinite(frameWidth) && Number.isFinite(frameHeight) && frameWidth > 0 && frameHeight > 0;

    const has = key => Boolean(key && Object.prototype.hasOwnProperty.call(rules, key));
    const lookup = key => has(key)
        ? parseRuleState(rules[key])
        : null;

    // 1. For fixed-size windows with known dimensions, prefer an exact-size rule.
    if (isFixed) {
        const exactKey = buildRuleKey(wmClass, {
            clientType, windowType, hasParent, allowsResize, isAttachedDialog, hasRing, hasSsd,
            width: frameWidth, height: frameHeight,
        });
        const matched = lookup(exactKey);
        if (matched)
            return matched;
    }

    // 2. Generic rule key as fallback for fixed-size, or primary for resizable.
    const genericKey = buildRuleKey(wmClass, {
        clientType, windowType, hasParent, allowsResize, isAttachedDialog, hasRing, hasSsd,
    });

    if (has(genericKey))
        return parseRuleState(rules[genericKey]);
    return null;
}
