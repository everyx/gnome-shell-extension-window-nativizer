import {MUTTER_CSD_MIN_INSET_THRESHOLD, WindowType} from './mutterRules.generated.js';

import {
    CLIENT_TYPE_TOKEN_WAYLAND,
    CLIENT_TYPE_TOKEN_X11,
    RULE_AXIS_ORDER,
    RuleAxis,
    RuleDirection,
    buildRuleValue,
    resolveRule,
    withRule,
} from './rules.js';
import {buildRuleKeyFromProperties} from './pick.js';
import {styleForWindow} from './style.js';
import {ADWAITA_STYLE} from './adwaitaStyle.generated.js';

/**
 * A window narrower or shorter than two corner radii cannot carry a rounded
 * rectangle - the two arcs on that axis would overlap - so it is a helper
 * surface, not a window. wl-clipboard maps a 1x1 transparent toplevel to hold
 * the selection; rounding or shadowing it paints a phantom decoration. Derived
 * from libadwaita's own radius so it tracks the real decoration.
 */
const MIN_DECORABLE_SIZE = 2 * ADWAITA_STYLE.window.radius;

/**
 * Decoration detection: what we would draw for a window, and whether a rule would
 * change it. The four-layer model behind that, and where it diverges from Mutter
 * on purpose, are in docs/decoration-model.md. Pure logic module, unit-testable.
 */
/**
 * Computes window content margins - how far the buffer extends past the frame on
 * each side pair - as {w, h} two-sided totals, each >= 0.
 *
 * Both rectangles carry the window's geometry scale, so the difference is the
 * margin the client declared: logical pixels on Wayland, and scaled by a factor
 * GJS cannot read on a backend that lays monitors out physically. See
 * docs/decoration-model.md.
 */
export function computeInsets(bufferWidth, bufferHeight, frameWidth, frameHeight) {
    return {
        w: Math.max(0, bufferWidth - frameWidth),
        h: Math.max(0, bufferHeight - frameHeight),
    };
}
/**
 * Whether the extension is allowed to decorate this window at all. Structural
 * facts, not guesses - no rule may override them.
 *
 * @param {object} [params={}]
 * @param {number} [params.windowType=WindowType.NORMAL] - Meta.WindowType
 * @param {boolean} [params.isMaximized=false]
 * @param {boolean} [params.isFullscreen=false]
 * @param {number} [params.frameWidth=Infinity] - On-screen window width, logical px
 * @param {number} [params.frameHeight=Infinity] - On-screen window height, logical px
 * @returns {{eligible: boolean, reason: string}}
 */
export function checkDecorationEligibility({
    windowType = WindowType.NORMAL,
    isMaximized = false, isFullscreen = false,
    frameWidth = Number.POSITIVE_INFINITY,
    frameHeight = Number.POSITIVE_INFINITY,
} = {}) {
    // Only normal, dialog, modal and utility windows are ours to decorate.
    if (windowType !== WindowType.NORMAL && windowType !== WindowType.DIALOG &&
        windowType !== WindowType.MODAL_DIALOG && windowType !== WindowType.UTILITY)
        return {eligible: false, reason: `window-type=${windowType}`};

    // Maximized / fullscreen: libadwaita gives them square corners and no shadow.
    if (isMaximized || isFullscreen)
        return {eligible: false, reason: 'maximized/fullscreen'};

    // Helper surfaces are not windows: decorating a 1x1 transparent toplevel
    // paints a shadow over nothing. wl-clipboard is the known case.
    if (frameWidth < MIN_DECORABLE_SIZE || frameHeight < MIN_DECORABLE_SIZE)
        return {eligible: false, reason: `too-small(${frameWidth}x${frameHeight})`};

    return {eligible: true, reason: ''};
}
/**
 * What we would draw with no user rule, one axis at a time: the shadow by who
 * already paints one, the corners by whether the window already looks like
 * libadwaita. The model behind both, and where it diverges from Mutter on
 * purpose, are in docs/decoration-model.md.
 *
 * @param {object} params
 * @param {boolean} [params.isX11=false]
 * @param {number} params.sideW - per-side declared margin, logical px
 * @param {number} params.sideH - per-side declared margin, logical px
 * @param {number} [params.insetThreshold]
 * @param {boolean} [params.hasSsd=false] - Mutter drew a frame/titlebar
 * @param {boolean} [params.nativeLikeCorners=false] - the client's corners already look like ours
 * @returns {{shadow: boolean, corners: boolean, reason: string}}
 */
export function inferDecorationBaseline({
    isX11 = false,
    sideW, sideH,
    insetThreshold = MUTTER_CSD_MIN_INSET_THRESHOLD,
    hasSsd = false,
    nativeLikeCorners = false,
}) {
    const insets = `${sideW.toFixed(1)}x${sideH.toFixed(1)}`;

    // The shadow axis stands only on what the window declares and on Mutter's own
    // gates, the two things that say who already paints a shadow.
    let shadow = true;
    let reason = `no-csd(${insets} < ${insetThreshold})`;

    if (hasSsd) {
        shadow = false;
        reason = 'has-ssd-frame';
    } else if (sideW >= insetThreshold && sideH >= insetThreshold) {
        shadow = false;
        reason = `has-csd(${insets} >= ${insetThreshold})`;
    } else if (isX11 && sideW <= 0 && sideH <= 0) {
        shadow = false;
        reason = 'x11-mutter-native-shadow';
    }

    // The corner axis has no such evidence to read - a surface never says whether it is
    // already rounded - so it rests on the one inference we allow ourselves. The shadow
    // keeps the reason it was decided by, which was a declared fact and not this.
    if (nativeLikeCorners)
        return {shadow, corners: false, reason: `native-like-corners; shadow: ${reason}`};

    return {shadow, corners: true, reason};
}
/**
 * Checks whether the scaling factor is fractional. Invalid or <= 0 counts as no.
 */
export function isFractionalScale(scale) {
    if (scale === null || scale === undefined || !Number.isFinite(scale) || scale <= 0)
        return false;
    return Math.abs(scale - Math.round(scale)) > 0.001;
}
/**
 * Whether to clip the window to its rounded corners: always, unless the user
 * prefers crisp text on a fractional-scale display, where clipping is what blurs.
 */
export function shouldClipWindow({preferCrispText = false, scale = 1}) {
    if (!preferCrispText)
        return true;
    return !isFractionalScale(scale);
}
/**
 * @param {object} win - Meta.Window instance
 * @returns {boolean} Whether the window is maximized
 */
export function isWindowMaximized(win) {
    return Boolean(win?.is_maximized?.());
}
/**
 * Checks whether a window is in a snap-tiled state: half-tiled on one axis, or
 * matched with a neighbour. Both flatten their corners, so the background cannot
 * leak past a flat screen edge or the split between two windows; only the matched
 * one also loses its shadow - see docs/decoration-model.md.
 *
 * @param {object} win - Meta.Window instance
 * @param {object} [options={}]
 * @param {boolean} [options.isMaximized] - Precomputed maximization state
 * @param {boolean} [options.hasTileMatch] - Precomputed tile match state
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
 * @property {number} bufferWidth - Buffer rectangle width
 * @property {number} bufferHeight - Buffer rectangle height
 * @property {number} frameWidth - Frame rectangle width
 * @property {number} frameHeight - Frame rectangle height
 * @property {number} [monitorScale=1] - Display scale factor
 * @property {boolean} [isMaximized=false] - Whether window is maximized
 * @property {boolean} [isFullscreen=false] - Whether window is fullscreen
 * @property {boolean} [hasSsd=false] - Whether native server-side decorations exist
 * @property {boolean} [isX11=false] - Whether client is X11 / XWayland
 * @property {boolean} [nativeLikeCorners=false] - Whether the client's corners already look like ours
 * @property {number} [windowType=WindowType.NORMAL] - Wayland/Meta window type
 * @property {boolean} [hasParent=false] - Whether window has transient parent
 * @property {boolean} [isAttachedDialog=false] - Whether modal dialog attached to parent
 * @property {boolean} [allowsResize=true] - Whether window allows resizing
 * @property {boolean} [hasTileMatch=false] - Whether window is snap-tiled with an adjacent matching window
 * @property {boolean} [focused=false] - Whether the window is focused (backdrop otherwise)
 * @property {boolean} [tiled=false] - Whether the window is snap-tiled (half-tiled or matched)
 * @property {boolean} [highContrast=false] - Whether the high-contrast theme is on
 * @property {string} [wmClass] - Window WM_CLASS / app ID
 * @property {{suppress?: Record<string, string>, force?: Record<string, string>}} [rules={}] - Both rule groups
 * @property {boolean} [preferCrispText=false] - Subpixel crisp text setting
 * @property {number} [insetThreshold] - Mutter CSD minimum margin threshold
 */
/**
 * Evaluates decoration actions based on geometric criteria and exclusion rules.
 *
 * @param {WindowEvaluationParams} params
 * @returns {{ drawShadow: boolean, drawClip: boolean, style: object, reason: string }}
 */
export function evaluateWindowActions({
    bufferWidth, bufferHeight, frameWidth, frameHeight,
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
    insetThreshold = MUTTER_CSD_MIN_INSET_THRESHOLD,
}) {
    // The state's style is resolved here, once, and returned with the decision, so a
    // caller paints from the very object the decision was made from rather than
    // deriving the style a second time (docs/decoration-model.md).
    const style = styleForWindow({focused, maximized: isMaximized, fullscreen: isFullscreen, tiled, highContrast});

    // 1. Structural eligibility - no rule may override it.
    // 2. Inferred baseline - what we would do with no rule at all.
    // 3. User rule - moves the axes it names; the only layer that can turn one on.
    // 4. State modifiers - policies, not inferences (docs/decoration-model.md).
    const eligibility = checkDecorationEligibility({windowType, isMaximized, isFullscreen, frameWidth, frameHeight});
    if (!eligibility.eligible)
        return {drawShadow: false, drawClip: false, style, reason: eligibility.reason};

    const {w, h} = computeInsets(bufferWidth, bufferHeight, frameWidth, frameHeight);
    const baseline = inferDecorationBaseline({
        isX11, sideW: w / 2, sideH: h / 2, insetThreshold, hasSsd, nativeLikeCorners,
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
        const forced = rule.direction === RuleDirection.FORCE;
        if (rule.axes.has(RuleAxis.SHADOW))
            shadow = forced;
        if (rule.axes.has(RuleAxis.CORNERS))
            corners = forced;
    }

    // 4. State modifiers, applied last: policies, not inferences about who already
    //    paints what (docs/decoration-model.md). The clip axis also needs the style to
    //    have something to draw: tiled and maximized give radius 0 and no outline, so
    //    the offscreen pass would be pure waste there.
    const shadowBeforeTiling = shadow;
    shadow = shadow && !hasTileMatch;
    corners = corners && shouldClipWindow({preferCrispText, scale: monitorScale}) &&
        (style.radius > 0 || Boolean(style.outline));

    let reason = rule
        ? `${rule.source === 'builtin' ? 'builtin-rule' : 'rule-applied'}(${wmClass}:${rule.direction}:${buildRuleValue(rule.axes)})`
        : baseline.reason;
    if (shadowBeforeTiling && !shadow)
        reason = `tile-match(suppress-shadow,${reason})`;

    return {drawShadow: shadow, drawClip: corners, style, reason};
}
/**
 * Whether a rule would change the actions we take for a window.
 *
 * A rule that changes nothing is a row that misrepresents what it does, so the
 * picker refuses to add one. Running the runtime's evaluator twice - with and
 * without the rule - covers every way a rule can be inert: an ineligible kind, a
 * baseline that already answers as asked, a policy that overrides it again. *
 * @param {WindowEvaluationParams} params - The window, evaluated without the rule
 * @param {{direction: string, key: string, axes: Iterable<string>}} rule
 * @returns {boolean}
 */
function ruleWouldChangeActions(params, {direction, key, axes}) {
    const before = evaluateWindowActions(params);
    const after = evaluateWindowActions({
        ...params,
        rules: withRule(params.rules, direction, key, axes),
    });

    return before.drawShadow !== after.drawShadow ||
        before.drawClip !== after.drawClip;
}
/**
 * Whether the rule a pick would add for `properties`' window kind would change
 * what we draw for the window `params` describes.
 *
 * A fresh pick names every axis (RULE_AXIS_ORDER) and the user narrows it down
 * from there. Transient window state must not decide this: a rule worth creating
 * for a restored window is worth creating while it is maximized or tiled, so those
 * are normalized away and the kind's attributes and the margins it declares are
 * what count. A policy that stands for the whole session is left live instead -
 * with crisp text on a fractional scale the clip is skipped entirely, so a corners
 * rule really is ineffective there and the picker refuses it.
 *
 * @param {Record<string, string>} properties - extractWindowProperties() output
 * @param {WindowEvaluationParams} params - The window as the runtime sees it
 * @param {string} direction - RuleDirection
 * @returns {boolean|null} null when the window cannot be identified
 */
export function pickedRuleWouldChange(properties, params, direction) {
    const key = buildRuleKeyFromProperties(properties);
    if (!key)
        return null;

    const asKind = {
        ...params,
        isMaximized: false,
        isFullscreen: false,
        hasTileMatch: false,
        tiled: false,
    };

    return ruleWouldChangeActions(asKind, {direction, key, axes: RULE_AXIS_ORDER});
}
