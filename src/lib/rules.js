import {WindowType} from './mutterRules.generated.js';

/** D-Bus / kind tokens for the client-type field. */
export const CLIENT_TYPE_TOKEN_WAYLAND = 'wayland';
export const CLIENT_TYPE_TOKEN_X11 = 'x11';

const CLIENT_TYPE_TOKENS = [CLIENT_TYPE_TOKEN_WAYLAND, CLIENT_TYPE_TOKEN_X11];

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
    if (declared?.trim())
        return declared.trim();
    if (peer?.trim())
        return peer.trim();
    if (tracked && !isWindowBackedAppId(tracked))
        return tracked;
    // pid changes on restart, so a kind keyed on it is session-scoped.
    return pid > 0 ? `pid-${pid}` : '';
}

/**
 * Builds a window kind from the D-Bus string map the picker sends
 * (see extractWindowProperties in pick.js). The identity decides whether a rule
 * can exist at all: without one there is nothing stable to key on.
 * @param {Record<string, string>} [properties={}]
 * @returns {{identity: string, clientType: string, windowType: number, hasParent: boolean,
 *   allowsResize: boolean, attachedDialog: boolean, hasRing: boolean, hasSsd: boolean,
 *   width: number|null, height: number|null}|null}
 */
export function kindFromProperties(properties = {}) {
    const identity = typeof properties.wmClass === 'string' ? properties.wmClass.trim() : '';
    if (!identity)
        return null;

    const allowsResize = properties.allowsResize === 'true';
    // Fixed-size windows may carry a stable size; a resizable window's size is
    // not stable, so it is not part of the kind.
    const width = !allowsResize && properties.width ? Number(properties.width) : NaN;
    const height = !allowsResize && properties.height ? Number(properties.height) : NaN;

    return {
        identity,
        clientType: properties.clientType === CLIENT_TYPE_TOKEN_X11
            ? CLIENT_TYPE_TOKEN_X11
            : CLIENT_TYPE_TOKEN_WAYLAND,
        windowType: Number(properties.windowType ?? WindowType.NORMAL),
        hasParent: properties.hasParent === 'true',
        allowsResize,
        attachedDialog: properties.isAttachedDialog === 'true',
        hasRing: properties.hasRing === 'true',
        hasSsd: properties.hasSsd === 'true',
        width: Number.isFinite(width) && width > 0 ? Math.round(width) : null,
        height: Number.isFinite(height) && height > 0 ? Math.round(height) : null,
    };
}

/**
 * A stable string for a kind, used only as a UI map key (prefs indexes rows by it).
 * It is never parsed back - the kind travels beside it - so it is just a fixed-order
 * tuple, not a grammar. The identity is lowercased here so a re-pick spelled with a
 * different case updates the same row.
 * @param {{identity: string}|null} kind
 * @returns {string}
 */
export function kindId(kind) {
    if (!kind)
        return '';
    return JSON.stringify([
        kind.identity.toLowerCase(),
        kind.clientType,
        kind.windowType,
        kind.hasParent,
        kind.allowsResize,
        kind.attachedDialog,
        kind.hasRing,
        kind.hasSsd,
        kind.width,
        kind.height,
    ]);
}

/**
 * Field equality, with the identity compared case-insensitively: one application can
 * report itself as 'WeChat' from one window and 'wechat' from the next.
 * @param {object|null} a
 * @param {object|null} b
 * @returns {boolean}
 */
export function sameKind(a, b) {
    if (!a || !b)
        return false;
    return a.identity.toLowerCase() === b.identity.toLowerCase() &&
        a.clientType === b.clientType &&
        a.windowType === b.windowType &&
        a.hasParent === b.hasParent &&
        a.allowsResize === b.allowsResize &&
        a.attachedDialog === b.attachedDialog &&
        a.hasRing === b.hasRing &&
        a.hasSsd === b.hasSsd &&
        a.width === b.width &&
        a.height === b.height;
}

const INVALID_SIZE = Symbol('invalid-size');

/**
 * Storage spells "no size" as 0. A positive number is kept (rounded); anything else
 * that is not 0/null/undefined is a malformed record.
 * @param {*} value
 * @returns {number|null|typeof INVALID_SIZE}
 */
function storedSize(value) {
    if (value === null || value === undefined || value === 0)
        return null;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0)
        return Math.round(value);
    return INVALID_SIZE;
}

const BOOL_RECORD_FIELDS = ['has_parent', 'allows_resize', 'attached_dialog', 'has_ring', 'has_ssd'];

/**
 * Validates stored records into kinds with their state and display title. A record
 * that cannot describe a window kind is dropped with a warning naming the field; a
 * state that reverses nothing is dropped silently, because it is the same as no rule.
 * @param {Array<object>} [raw=[]]
 * @returns {Array<{kind: object, state: string, title: string}>}
 */
export function sanitizeRules(raw = []) {
    if (!Array.isArray(raw))
        return [];

    const rules = [];
    const seen = new Map();

    for (const record of raw) {
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
            console.warn('[window-nativizer] Dropping rule with a non-object record');
            continue;
        }

        const identity = typeof record.identity === 'string' ? record.identity.trim() : '';
        if (!identity) {
            console.warn('[window-nativizer] Dropping rule with no identity');
            continue;
        }

        if (!CLIENT_TYPE_TOKENS.includes(record.client_type)) {
            console.warn(`[window-nativizer] Dropping rule for "${identity}" with unknown client type: "${record.client_type}"`);
            continue;
        }

        if (!Number.isInteger(record.window_type)) {
            console.warn(`[window-nativizer] Dropping rule for "${identity}" with invalid window type: "${record.window_type}"`);
            continue;
        }

        const badBool = BOOL_RECORD_FIELDS.find(field => typeof record[field] !== 'boolean');
        if (badBool) {
            console.warn(`[window-nativizer] Dropping rule for "${identity}" with non-boolean ${badBool}`);
            continue;
        }

        const allowsResize = record.allows_resize;
        const width = storedSize(record.width);
        const height = storedSize(record.height);
        if (width === INVALID_SIZE || height === INVALID_SIZE) {
            console.warn(`[window-nativizer] Dropping rule for "${identity}" with a non-numeric size`);
            continue;
        }
        // width/height may only be set when the size is stable, and only as a pair.
        if (allowsResize && (width !== null || height !== null)) {
            console.warn(`[window-nativizer] Dropping rule for "${identity}" with a size on a resizable window`);
            continue;
        }
        if ((width === null) !== (height === null)) {
            console.warn(`[window-nativizer] Dropping rule for "${identity}" with an incomplete size`);
            continue;
        }

        const axes = parseRuleState(record.state);
        if (!axes) {
            console.warn(`[window-nativizer] Dropping rule with invalid state: "${record.state}" for "${identity}"`);
            continue;
        }
        const state = buildRuleState(axes);
        if (!state)
            continue;

        const kind = {
            identity,
            clientType: record.client_type,
            windowType: record.window_type,
            hasParent: record.has_parent,
            allowsResize,
            attachedDialog: record.attached_dialog,
            hasRing: record.has_ring,
            hasSsd: record.has_ssd,
            width,
            height,
        };

        const id = kindId(kind);
        if (seen.has(id)) {
            console.warn(`[window-nativizer] Dropping duplicate rule for "${identity}" (conflicts with "${seen.get(id)}")`);
            continue;
        }
        seen.set(id, identity);

        // One line beside an app name: a newline would break the row.
        const title = typeof record.title === 'string'
            ? record.title.replace(/[\r\n]+/g, ' ').trim()
            : '';

        rules.push({kind, state, title});
    }

    return rules;
}

/**
 * Resolves the rule for a window kind, preserving the two-level match: a fixed-size
 * window prefers a rule that carries its exact size, then falls back to a size-less
 * rule for the same kind; a resizable window only ever matches a size-less kind.
 * @param {{identity: string, allowsResize: boolean, width: number|null, height: number|null}} windowKind
 * @param {Array<{kind: object, state: string}>} [rules=[]] - The array from sanitizeRules
 * @returns {Set<string>|null} The reversed axes, or null when no rule matched
 */
export function resolveRule(windowKind, rules = []) {
    if (!windowKind?.identity)
        return null;

    // 1. For fixed-size windows with known dimensions, prefer an exact-size rule.
    if (windowKind.allowsResize === false) {
        const exact = rules.find(rule => sameKind(rule.kind, windowKind));
        if (exact)
            return parseRuleState(exact.state);
    }

    // 2. Size-less kind as fallback for fixed-size, or primary for resizable.
    const generic = {...windowKind, width: null, height: null};
    const match = rules.find(rule => sameKind(rule.kind, generic));
    return match ? parseRuleState(match.state) : null;
}
