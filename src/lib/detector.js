import {WindowType} from './mutterRules.generated.js';

import {
    CLIENT_TYPE_TOKEN_WAYLAND,
    CLIENT_TYPE_TOKEN_X11,
    RuleAxis,
    RuleState,
    buildRuleState,
    resolveRule,
    withRule,
} from './rules.js';
import {buildRuleKeyFromProperties} from './pick.js';
import {styleForWindow} from './style.js';
import {ADWAITA_STYLE} from './adwaitaStyle.generated.js';
import {MIN_BAND_WINDOW, RESIZE_BAND} from './resizeBand.js';

// Four-layer model in docs/decoration-model.md; pure logic, unit-testable.

// 2× the libadwaita radius: below it the two corner arcs overlap, so no rounded rect fits (helper surface, e.g. wl-clipboard 1×1).
const MIN_DECORABLE_SIZE = 2 * ADWAITA_STYLE.window.radius;

/**
 * @param {number} bufferWidth
 * @param {number} bufferHeight
 * @param {number} frameWidth
 * @param {number} frameHeight
 * @returns {{w: number, h: number}} Two-sided totals, each >= 0
 */
export function computeInsets(bufferWidth, bufferHeight, frameWidth, frameHeight) {
    return {
        w: Math.max(0, bufferWidth - frameWidth),
        h: Math.max(0, bufferHeight - frameHeight),
    };
}

/**
 * @param {object} [params={}]
 * @param {number} [params.windowType=WindowType.NORMAL]
 * @param {boolean} [params.isMaximized=false]
 * @param {boolean} [params.isFullscreen=false]
 * @param {number} [params.frameWidth=Infinity] - Logical px
 * @param {number} [params.frameHeight=Infinity] - Logical px
 * @returns {{eligible: boolean, reason: string}}
 */
export function checkDecorationEligibility({
    windowType = WindowType.NORMAL,
    isMaximized = false, isFullscreen = false,
    frameWidth = Number.POSITIVE_INFINITY,
    frameHeight = Number.POSITIVE_INFINITY,
} = {}) {
    if (windowType !== WindowType.NORMAL && windowType !== WindowType.DIALOG &&
        windowType !== WindowType.MODAL_DIALOG && windowType !== WindowType.UTILITY)
        return {eligible: false, reason: `window-type=${windowType}`};

    // libadwaita: maximized/fullscreen have square corners, no shadow.
    if (isMaximized || isFullscreen)
        return {eligible: false, reason: 'maximized/fullscreen'};

    // 1×1 helper (e.g. wl-clipboard) would get a shadow over nothing.
    if (frameWidth < MIN_DECORABLE_SIZE || frameHeight < MIN_DECORABLE_SIZE)
        return {eligible: false, reason: `too-small(${frameWidth}x${frameHeight})`};

    return {eligible: true, reason: ''};
}

/**
 * Whether the client declared a decoration ring of its own, on either axis.
 * Same question Mutter answers with the boolean `has_custom_frame_extents` (set
 * whenever the property exists, 4px as much as 40px; see docs/decoration-model.md),
 * and it reads the same way: a declared extent means the client draws its own frame.
 * @param {object} params
 * @param {boolean} [params.hasSsd=false]
 * @param {number} params.sideW - Widest declared margin on the horizontal axis, logical px
 * @param {number} params.sideH - Widest declared margin on the vertical axis, logical px
 * @returns {boolean}
 */
export function declaresOwnShadow({hasSsd = false, sideW, sideH}) {
    return !hasSsd && (sideW > 0 || sideH > 0);
}

/**
 * @param {object} params
 * @param {boolean} [params.hasSsd=false]
 * @param {boolean} [params.isX11=false]
 * @param {number} params.sideW - Widest declared margin on the horizontal axis, logical px
 * @param {number} params.sideH - Widest declared margin on the vertical axis, logical px
 * @returns {boolean}
 */
export function hasUnclearableShadow({hasSsd = false, isX11 = false, sideW, sideH}) {
    return hasSsd || (isX11 && sideW <= 0 && sideH <= 0);
}

/**
 * @param {object} params
 * @param {boolean} [params.isX11=false]
 * @param {number} params.sideW - Widest declared margin on the horizontal axis, logical px
 * @param {number} params.sideH - Widest declared margin on the vertical axis, logical px
 * @param {boolean} [params.hasSsd=false]
 * @param {boolean} [params.nativeLikeCorners=false]
 * @returns {{shadow: boolean, corners: boolean, reason: string}}
 */
export function inferDecorationBaseline({
    isX11 = false,
    sideW, sideH,
    hasSsd = false,
    nativeLikeCorners = false,
}) {
    const insets = `${sideW.toFixed(1)}x${sideH.toFixed(1)}`;

    let shadow = true;
    let reason = `no-csd(${insets})`;

    if (hasUnclearableShadow({hasSsd, isX11, sideW, sideH})) {
        shadow = false;
        reason = hasSsd ? 'has-ssd-frame' : 'x11-mutter-native-shadow';
    } else if (declaresOwnShadow({hasSsd, sideW, sideH})) {
        shadow = false;
        reason = `has-csd(${insets})`;
    }

    if (nativeLikeCorners)
        return {shadow, corners: false, reason: `native-like-corners; shadow: ${reason}`};

    return {shadow, corners: true, reason};
}

/**
 * @param {number|null|undefined} scale
 * @returns {boolean}
 */
export function isFractionalScale(scale) {
    if (scale === null || scale === undefined || !Number.isFinite(scale) || scale <= 0)
        return false;
    return Math.abs(scale - Math.round(scale)) > 0.001;
}

/**
 * @param {object} params
 * @param {boolean} [params.preferCrispText=false]
 * @param {number} [params.scale=1]
 * @returns {boolean}
 */
export function shouldClipWindow({preferCrispText = false, scale = 1}) {
    if (!preferCrispText)
        return true;
    return !isFractionalScale(scale);
}

/**
 * @param {object} win - Meta.Window instance
 * @returns {boolean}
 */
export function isWindowMaximized(win) {
    return Boolean(win?.is_maximized?.());
}

/**
 * @param {object} win - Meta.Window instance
 * @param {object} [options={}]
 * @param {boolean} [options.isMaximized]
 * @param {boolean} [options.hasTileMatch]
 * @returns {boolean}
 */
export function isWindowTiled(win, options = {}) {
    if (!win)
        return false;
    const isMax = options.isMaximized ?? isWindowMaximized(win);
    if (isMax)
        return false;
    const hasMatch = options.hasTileMatch ?? Boolean(win.get_tile_match?.());
    const hMax = Boolean(win.maximized_horizontally);
    const vMax = Boolean(win.maximized_vertically);
    return (hMax !== vMax) || hasMatch;
}

/**
 * @typedef {object} WindowEvaluationParams
 * @property {number} bufferWidth
 * @property {number} bufferHeight
 * @property {number} frameWidth
 * @property {number} frameHeight
 * @property {import('./frame.js').Insets|null} [insets=null] - Declared ring per side; the widths above are the totals fallback
 * @property {number} [monitorScale=1]
 * @property {boolean} [isMaximized=false]
 * @property {boolean} [isFullscreen=false]
 * @property {boolean} [hasSsd=false]
 * @property {boolean} [isX11=false]
 * @property {boolean} [nativeLikeCorners=false]
 * @property {number} [windowType=WindowType.NORMAL]
 * @property {boolean} [hasParent=false]
 * @property {boolean} [isAttachedDialog=false]
 * @property {boolean} [allowsResize=true]
 * @property {boolean} [hasTileMatch=false]
 * @property {boolean} [focused=false]
 * @property {boolean} [tiled=false]
 * @property {boolean} [highContrast=false]
 * @property {string} [wmClass]
 * @property {Record<string, string>} [rules={}]
 * @property {boolean} [preferCrispText=false]
 */

/**
 * The declared margin, read the two ways the two questions need. The ring is declared per
 * side (`_GTK_FRAME_EXTENTS` LTRB, read as `buffer_rect - frame_rect`), and a two-sided
 * total loses which side it came from, so neither reading is "the" margin:
 *  - `declaringSides` is the widest margin on each axis. A positive value then means "a ring
 *    on either side of this axis" - the question `declaresOwnShadow()` asks. On non-negative
 *    values `max > 0` is exactly "some side on this axis is positive".
 *  - `narrowestSides` is the smallest margin on each axis. "At least 12 on every side" is
 *    that minimum, not the per-axis average a two-sided total gives: a 0,24 ring is not 12 a
 *    side, so `shouldShowResizeBand()` reads this pair.
 * With only the two-sided totals both pairs are equal, which is right for a symmetric
 * measure. The widths are the fallback for a caller that only has totals.
 * @param {object} params
 * @param {import('./frame.js').Insets|null} params.insets
 * @returns {{declaringSides: {sideW: number, sideH: number},
 *            narrowestSides: {sideW: number, sideH: number}}}
 */
export function declaredSides({insets, bufferWidth, bufferHeight, frameWidth, frameHeight}) {
    if (!insets) {
        const {w, h} = computeInsets(bufferWidth, bufferHeight, frameWidth, frameHeight);
        const totals = {sideW: w / 2, sideH: h / 2};
        return {declaringSides: totals, narrowestSides: totals};
    }
    return {
        declaringSides: {
            sideW: Math.max(insets.left, insets.right),
            sideH: Math.max(insets.top, insets.bottom),
        },
        narrowestSides: {
            sideW: Math.min(insets.left, insets.right),
            sideH: Math.min(insets.top, insets.bottom),
        },
    };
}

/**
 * Whether the window gets the resize band. It follows the decoration: a window we draw
 * nothing on (a `none` rule, or a structurally ineligible one) keeps every click it had,
 * and a window that already handles its own resize never gets one. See
 * docs/decoration-model.md § The resize band.
 *
 * The declared-margin check is a **proxy**: the client's real handle width is not
 * observable (Chromium draws 10px no matter how wide its ring is), so this only skips a
 * window whose ring is *obviously* wide enough - at least `RESIZE_BAND` on every side, which
 * is the toolkit's own floor. The ring is the same reading the shadow axis uses
 * (`buffer_rect - frame_rect`), but the threshold is per side, so this asks for the
 * *narrowest* margin on each axis and not the widest one `declaresOwnShadow()` asks for.
 * @param {object} params
 * @param {boolean} [params.resizeBand=true]
 * @param {boolean} [params.decorated=true] - Whether we draw anything on the window at all
 * @param {boolean} [params.allowsResize=true]
 * @param {boolean} [params.isMaximized=false]
 * @param {boolean} [params.isFullscreen=false]
 * @param {boolean} [params.tiled=false]
 * @param {boolean} [params.hasTileMatch=false]
 * @param {boolean} [params.nativeLikeCorners=false]
 * @param {boolean} [params.hasSsd=false]
 * @param {import('./frame.js').Insets|null} [params.insets=null] - Declared ring, per side
 * @param {number} [params.bufferWidth=0]
 * @param {number} [params.bufferHeight=0]
 * @param {number} [params.frameWidth=0]
 * @param {number} [params.frameHeight=0]
 * @returns {boolean}
 */
export function shouldShowResizeBand({
    resizeBand = true,
    decorated = true,
    allowsResize = true,
    isMaximized = false, isFullscreen = false,
    tiled = false, hasTileMatch = false,
    nativeLikeCorners = false,
    hasSsd = false,
    insets = null,
    bufferWidth = 0, bufferHeight = 0,
    frameWidth = 0, frameHeight = 0,
} = {}) {
    if (!resizeBand || !allowsResize || !decorated)
        return false;
    if (isMaximized || isFullscreen || tiled || hasTileMatch)
        return false;
    // A window that already has the Adwaita look has a native-width band of its own.
    if (nativeLikeCorners)
        return false;
    // Mutter's own frame carries the resize handles; a band would only take clicks the
    // frame already owns. `win.decorated` is a policy flag, but no `_MUTTER_FRAME_FOR`
    // check exists on the GJS side, and the flag is the best reading there is.
    if (hasSsd)
        return false;

    const {narrowestSides} = declaredSides({insets, bufferWidth, bufferHeight, frameWidth, frameHeight});
    // Its own handle is already at least as wide as a native one on every side.
    if (narrowestSides.sideW >= RESIZE_BAND && narrowestSides.sideH >= RESIZE_BAND)
        return false;

    // `MIN_BAND_WINDOW` is only the ring's sanity bound (the band has to fit on the short
    // axis), never a native one: GTK's input region does not depend on the window size
    // (docs/decoration-model.md § The resize band).
    return frameWidth >= MIN_BAND_WINDOW && frameHeight >= MIN_BAND_WINDOW;
}

/**
 * @param {WindowEvaluationParams} params
 * @returns {{drawShadow: boolean, drawClip: boolean, clearRing: boolean, style: object, reason: string}}
 */
export function evaluateWindowActions({
    bufferWidth, bufferHeight, frameWidth, frameHeight,
    insets = null,
    monitorScale = 1,
    isMaximized = false, isFullscreen = false,
    hasSsd = false,
    isX11 = false,
    nativeLikeCorners = false,
    windowType = WindowType.NORMAL,
    hasParent = false,
    isAttachedDialog = false,
    allowsResize = true,
    hasTileMatch = false,
    focused = false,
    tiled = false,
    highContrast = false,
    wmClass,
    rules = {},
    preferCrispText = false,
}) {
    const style = styleForWindow({focused, maximized: isMaximized, fullscreen: isFullscreen, tiled, highContrast});

    const eligibility = checkDecorationEligibility({windowType, isMaximized, isFullscreen, frameWidth, frameHeight});
    if (!eligibility.eligible)
        return {drawShadow: false, drawClip: false, style, reason: eligibility.reason};

    // The shadow axis asks whether either side of an axis declares a ring, so it reads
    // the widest margin per axis (`declaringSides`).
    const {declaringSides} = declaredSides({insets, bufferWidth, bufferHeight, frameWidth, frameHeight});
    const {sideW, sideH} = declaringSides;
    const baseline = inferDecorationBaseline({
        isX11, sideW, sideH, hasSsd, nativeLikeCorners,
    });

    const rule = resolveRule(wmClass, rules, {
        clientType: isX11 ? CLIENT_TYPE_TOKEN_X11 : CLIENT_TYPE_TOKEN_WAYLAND,
        windowType,
        hasParent: Boolean(hasParent),
        allowsResize,
        isAttachedDialog,
    });

    let shadow = baseline.shadow;
    let corners = baseline.corners;
    if (rule) {
        corners = rule.has(RuleAxis.CORNERS);
        shadow = rule.has(RuleAxis.SHADOW);
    }

    // Clip needs something to draw; radius 0 + no outline would be a wasted offscreen pass.
    const ours = corners;
    corners = ours && shouldClipWindow({preferCrispText, scale: monitorScale}) &&
        (style.radius > 0 || Boolean(style.outline));

    const ownRing = declaresOwnShadow({hasSsd, sideW, sideH});

    // No rule: ring was painted for the corners we replace, so the shadow becomes ours.
    if (!rule && corners && ownRing)
        shadow = true;

    const shadowBeforeTiling = shadow;
    shadow = shadow && !hasTileMatch;

    // Ring is ours to clear exactly when the shadow we draw is ours.
    const clearRing = ownRing && shadow;

    let reason = rule
        ? `rule-applied(${wmClass}:${buildRuleState(rule)})`
        : baseline.reason;
    if (clearRing)
        reason = `ring-cleared(${reason})`;
    if (shadowBeforeTiling && !shadow)
        reason = `tile-match(shadow-off,${reason})`;

    return {drawShadow: shadow, drawClip: corners, clearRing, style, reason};
}

/**
 * @param {WindowEvaluationParams} params
 * @param {{key: string, state: string}} rule
 * @returns {boolean}
 */
function ruleWouldChangeActions(params, {key, state}) {
    const before = evaluateWindowActions(params);
    const after = evaluateWindowActions({
        ...params,
        rules: withRule(params.rules, key, state),
    });

    return before.drawShadow !== after.drawShadow ||
        before.drawClip !== after.drawClip;
}

/** Transient state normalized away; a rule outlives it. */
function kindParams(params) {
    return {
        ...params,
        isMaximized: false,
        isFullscreen: false,
        hasTileMatch: false,
        tiled: false,
    };
}

/**
 * @param {WindowEvaluationParams} params
 * @returns {string}
 */
export function suggestedRuleState(params) {
    const kind = kindParams(params);
    const {drawShadow, drawClip} = evaluateWindowActions(kind);
    if (drawShadow || drawClip)
        return RuleState.NONE;

    const {sideW, sideH} = declaredSides(kind).declaringSides;
    if (hasUnclearableShadow({hasSsd: kind.hasSsd, isX11: kind.isX11, sideW, sideH}))
        return RuleState.CORNERS;

    return RuleState.BOTH;
}

/**
 * @param {Record<string, string>} properties
 * @param {WindowEvaluationParams} params
 * @param {string} state
 * @returns {boolean|null} Null when the window cannot be identified
 */
export function suggestedRuleWouldChange(properties, params, state) {
    const key = buildRuleKeyFromProperties(properties);
    if (!key)
        return null;

    return ruleWouldChangeActions(kindParams(params), {key, state});
}
