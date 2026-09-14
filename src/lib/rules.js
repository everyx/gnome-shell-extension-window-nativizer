// Window-kind rule model — see docs/rule-model.md; pure logic, unit-testable.

import {WindowType} from './mutterRules.generated.js';

/** D-Bus / rule-key tokens for the client-type field. */
export const CLIENT_TYPE_TOKEN_WAYLAND = 'wayland';
export const CLIENT_TYPE_TOKEN_X11 = 'x11';

export const RuleAxis = Object.freeze({
    SHADOW: 'shadow',
    CORNERS: 'corners',
});

export const RuleState = Object.freeze({
    BOTH: 'both',
    NONE: 'none',
    CORNERS: 'corners',
    SHADOW: 'shadow',
});

export const RULE_STATES = Object.freeze([
    RuleState.BOTH, RuleState.NONE, RuleState.CORNERS, RuleState.SHADOW,
]);

// Guarded by hasOwnProperty in parseRuleState so stray names like 'toString' don't parse.
const RULE_STATE_AXES = Object.freeze({
    [RuleState.BOTH]: [RuleAxis.CORNERS, RuleAxis.SHADOW],
    [RuleState.NONE]: [],
    [RuleState.CORNERS]: [RuleAxis.CORNERS],
    [RuleState.SHADOW]: [RuleAxis.SHADOW],
});

/**
 * @param {string} state
 * @returns {Set<string>|null} Null when not one of the four states
 */
export function parseRuleState(state) {
    if (typeof state !== 'string' ||
        !Object.prototype.hasOwnProperty.call(RULE_STATE_AXES, state))
        return null;
    return new Set(RULE_STATE_AXES[state]);
}

/**
 * @param {Iterable<string>} axes
 * @returns {string}
 */
export function buildRuleState(axes) {
    const named = new Set(axes);
    const corners = named.has(RuleAxis.CORNERS);
    const shadow = named.has(RuleAxis.SHADOW);

    if (corners && shadow)
        return RuleState.BOTH;
    if (corners)
        return RuleState.CORNERS;
    if (shadow)
        return RuleState.SHADOW;
    return RuleState.NONE;
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
        pattern: `(?:${CLIENT_TYPE_TOKEN_WAYLAND}|${CLIENT_TYPE_TOKEN_X11})`,
        parse: raw => raw,
    },
    {name: 'window_type', render: o => o.windowType, pattern: '\\d+', parse: raw => Number(raw)},
    {name: 'has_parent', render: o => boolString(o.hasParent), pattern: BOOL_FIELD, parse: raw => raw === 'true'},
    {name: 'allows_resize', render: o => boolString(o.allowsResize), pattern: BOOL_FIELD, parse: raw => raw === 'true'},
    {name: 'attached_dialog', render: o => boolString(o.isAttachedDialog), pattern: BOOL_FIELD, parse: raw => raw === 'true'},
];
const FINGERPRINT_SPECIFIER_PATTERN = FINGERPRINT_FIELDS
    .map(field => `${field.name}=${field.pattern}`)
    .join(',');
const VALID_RULE_KEY_PATTERN = new RegExp(
    `^[^\\s:]+:${FINGERPRINT_SPECIFIER_PATTERN}$`
);

/**
 * @param {string} wmClass
 * @param {object} [props={}]
 * @param {string} [props.clientType='wayland']
 * @param {number} [props.windowType=WindowType.NORMAL]
 * @param {boolean} [props.hasParent=false]
 * @param {boolean} [props.allowsResize=true]
 * @param {boolean} [props.isAttachedDialog=false]
 * @returns {string} Canonical key or '' when wmClass is missing
 */
export function buildRuleKey(wmClass, {
    clientType = CLIENT_TYPE_TOKEN_WAYLAND,
    windowType = WindowType.NORMAL,
    hasParent = false,
    allowsResize = true,
    isAttachedDialog = false,
} = {}) {
    if (!wmClass)
        return '';

    const fields = {clientType, windowType, hasParent, allowsResize, isAttachedDialog};
    const specifier = FINGERPRINT_FIELDS
        .map(field => `${field.name}=${field.render(fields)}`)
        .join(',');

    // ':'/whitespace delimit the grammar, so the identity is encoded.
    return `${encodeIdentity(wmClass)}:${specifier}`;
}

/**
 * @param {Record<string, string>} [rawRules={}]
 * @returns {Record<string, string>} Canonical key -> RuleState
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

        const canonicalKey = normalizeRuleKey(key);
        if (seenKeys.has(canonicalKey)) {
            const existingKey = seenKeys.get(canonicalKey);
            console.warn(`[window-nativizer] Dropping case-colliding rule key "${key}" (conflicts with "${existingKey}")`);
            continue;
        }

        seenKeys.set(canonicalKey, key);
        clean[canonicalKey] = buildRuleState(axes);
    }

    return clean;
}

/**
 * @param {Record<string, string>} [rules={}]
 * @param {string} key
 * @param {string} state
 * @returns {Record<string, string>}
 */
export function withRule(rules = {}, key, state) {
    if (!RULE_STATES.includes(state))
        throw new Error(`[window-nativizer] unknown rule state: ${state}`);
    return {...rules, [key]: state};
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
        const field = FINGERPRINT_FIELDS.find(f => f.name === name);
        if (field)
            properties[name] = field.parse(pair.slice(eqIdx + 1));
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
 * @returns {Set<string>|null} Axes that are ours, or null when no rule matched
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
    } = options;

    const key = buildRuleKey(wmClass, {
        clientType,
        windowType,
        hasParent,
        allowsResize,
        isAttachedDialog,
    });
    if (!key)
        return null;

    return parseRuleState(rules[key]);
}
