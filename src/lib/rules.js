/**
 * The window-kind rule model: keys, states, matching and sanitising. What a key
 * means, and what each state does, are in docs/rule-model.md.
 *
 * Pure logic module: no shell globals, unit-testable.
 */

import {WindowType} from './mutterRules.generated.js';

/** Rule-key / D-Bus tokens for the client-type fingerprint field. */
export const CLIENT_TYPE_TOKEN_WAYLAND = 'wayland';
export const CLIENT_TYPE_TOKEN_X11 = 'x11';
/**
 * The two decorations this extension paints. They are independent: a window can
 * have either, both, or neither, and a rule says which of them are ours.
 */
export const RuleAxis = Object.freeze({
    SHADOW: 'shadow',
    CORNERS: 'corners',
});
/**
 * The four states a rule can name. There is no direction: a state names the axes
 * that are ours, so an empty set (`none`) is a choice, not the absence of one.
 */
export const RuleState = Object.freeze({
    BOTH: 'both',
    NONE: 'none',
    CORNERS: 'corners',
    SHADOW: 'shadow',
});
/**
 * Every state, in the order the preferences shows them. The state grammar lives
 * here so parsing and rendering can never drift apart.
 */
export const RULE_STATES = Object.freeze([
    RuleState.BOTH, RuleState.NONE, RuleState.CORNERS, RuleState.SHADOW,
]);
// One entry per state. parseRuleState() reads it, and the hasOwnProperty guard there
// keeps stray names like 'toString' from parsing as states.
const RULE_STATE_AXES = Object.freeze({
    [RuleState.BOTH]: [RuleAxis.CORNERS, RuleAxis.SHADOW],
    [RuleState.NONE]: [],
    [RuleState.CORNERS]: [RuleAxis.CORNERS],
    [RuleState.SHADOW]: [RuleAxis.SHADOW],
});
/**
 * Parses a rule state into the set of axes it says are ours.
 *
 * @param {string} state
 * @returns {Set<string>|null} null when the state is not one of the four
 */
export function parseRuleState(state) {
    if (typeof state !== 'string' ||
        !Object.prototype.hasOwnProperty.call(RULE_STATE_AXES, state))
        return null;
    return new Set(RULE_STATE_AXES[state]);
}
/**
 * Renders axes back into the canonical rule state.
 *
 * @param {Iterable<string>} axes
 * @returns {string} One of RuleState; 'none' when no known axis is ours
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
 * Renders a boolean as the canonical rule-key token.
 *
 * @param {*} value
 * @returns {string} 'true' or 'false'
 */
export function boolString(value) {
    return value ? 'true' : 'false';
}
/** Decodes a rule-key identity, tolerating keys that were never encoded. */
function decodeIdentity(token) {
    try {
        return decodeURIComponent(token);
    } catch {
        return token;
    }
}
/**
 * Encodes an identity for key storage: lowercased, then percent-encoded. The rest of
 * a key is already canonical (lowercase tokens, numbers, true/false), so case is not
 * part of a key's identity - one application may report "WeChat" from one window and
 * "wechat" from the next, and those are the same kind.
 */
function encodeIdentity(identity) {
    return encodeURIComponent(identity.toLowerCase());
}
/**
 * Canonical spelling of a key, so a lookup is an exact one. Keys written before the
 * identity was lowercased are canonicalised here, as they are read.
 */
function normalizeRuleKey(key) {
    const colonIdx = key.indexOf(':');
    if (colonIdx < 0)
        return key;
    return `${encodeIdentity(decodeIdentity(key.slice(0, colonIdx)))}:${key.slice(colonIdx + 1)}`;
}
/** Shell wraps windows it cannot attribute to an app in a per-window app object. */
const WINDOW_BACKED_APP_ID_PATTERN = /^window:\d+$/;
/**
 * Whether a Shell app id is a per-window placeholder rather than a real identity: it
 * embeds a session-local sequence number (docs/rule-model.md).
 *
 * @param {string} appId
 * @returns {boolean}
 */
export function isWindowBackedAppId(appId) {
    return WINDOW_BACKED_APP_ID_PATTERN.test(appId);
}
/**
 * Picks the identity a rule should be keyed on, from the candidates gathered off a
 * window and its siblings. Pure so it can be unit-tested; gathering them needs Shell
 * APIs and lives in window.js, and the order they are weighed in is in
 * docs/rule-model.md.
 *
 * @param {object} [candidates={}]
 * @param {string} [candidates.declared=''] - Identity the window declares itself
 * @param {string} [candidates.peer=''] - Identity declared by a sibling process window
 * @param {string} [candidates.tracked=''] - Shell.WindowTracker's app id
 * @param {number} [candidates.pid=-1] - Owning process id
 * @returns {string} Identity, or '' when nothing identifies the window
 */
export function chooseWindowIdentity({declared = '', peer = '', tracked = '', pid = -1} = {}) {
    if (declared)
        return declared;
    if (peer)
        return peer;
    if (tracked && !isWindowBackedAppId(tracked))
        return tracked;
    // Last resort: two windows of one process share it, but it changes when the
    // process restarts, so a rule built on it only lives as long as the session.
    return pid > 0 ? `pid-${pid}` : '';
}
/**
 * Canonical window fingerprint: the attributes that define a window "kind". There is
 * deliberately no app-wide form, and field order is part of the format
 * (docs/rule-model.md).
 */
const BOOL_FIELD = '(?:true|false)';
/**
 * The window-kind fingerprint fields, in grammar order. One entry drives all three
 * places that must agree on them: the validation pattern, buildRuleKey() and
 * parseRuleKey().
 */
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
 * Builds the canonical rule key (application + window-kind fingerprint).
 *
 * @param {string} wmClass - Base window class / app id
 * @param {object} [props={}]
 * @param {string} [props.clientType='wayland'] - 'wayland' | 'x11'
 * @param {number} [props.windowType=WindowType.NORMAL] - Meta.WindowType
 * @param {boolean} [props.hasParent=false] - transient child window
 * @param {boolean} [props.allowsResize=true] - resizable
 * @param {boolean} [props.isAttachedDialog=false] - modal dialog attached to parent
 * @returns {string} Canonical rule key, or '' when wmClass is missing
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

    // ':' and whitespace are delimiters in the key grammar, so the identity is
    // encoded rather than assumed key-safe; parseRuleKey() decodes it back.
    return `${encodeIdentity(wmClass)}:${specifier}`;
}
/**
 * Validates and sanitizes the rule map read from settings: malformed keys and
 * states are dropped and identities are lowercased, so two spellings of one
 * application collapse onto one kind (docs/rule-model.md).
 *
 * @param {Record<string, string>} [rawRules={}]
 * @returns {Record<string, string>} canonical key -> RuleState value
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
 * Returns the rules with `key` set to `state`. The picker and the
 * effectiveness check both go through here, so the rule that looked worth adding is
 * the rule that gets stored.
 *
 * @param {Record<string, string>} [rules={}]
 * @param {string} key
 * @param {string} state
 * @returns {Record<string, string>}
 */
export function withRule(rules = {}, key, state) {
    // A rule is one of the four states; anything else is a caller bug, not a rule.
    if (!RULE_STATES.includes(state))
        throw new Error(`[window-nativizer] unknown rule state: ${state}`);
    return {...rules, [key]: state};
}
/**
 * Splits a rule key into its identity, its fingerprint specifier, and the parsed
 * property values. Strict: invalid keys yield an empty result, so parser and
 * validator can never disagree (grammar in docs/rule-model.md).
 *
 * @param {string} key - Rule key string
 * @returns {{ baseWmClass: string, specifier: string|null, properties: Record<string, string|number|boolean>|null }}
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
 * Resolves the rule that applies to a window, matching its canonical window-kind
 * fingerprint against the user's rules. The identity comparison is case-insensitive both
 * ways, while the fingerprint must match exactly (docs/rule-model.md).
 *
 * @param {string} wmClass - Window identity (WM_CLASS / app id / resolver result)
 * @param {Record<string, string>} [rules={}] - Canonical rule map
 * @param {object} [options={}]
 * @param {string} [options.clientType='wayland'] - 'wayland' | 'x11'
 * @param {number} [options.windowType=WindowType.NORMAL] - Meta.WindowType
 * @param {boolean} [options.hasParent=false] - Whether window has parent (transient)
 * @param {boolean} [options.allowsResize=true] - Whether window allows resizing
 * @param {boolean} [options.isAttachedDialog=false] - Whether modal dialog attached to parent
 * @returns {Set<string>|null} The axes that are ours, or null when no rule matched
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
