import {WindowType} from './mutterRules.generated.js';

import {
    CLIENT_TYPE_TOKEN_WAYLAND,
    CLIENT_TYPE_TOKEN_X11,
    RuleAxis,
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
 * Whether the window type has an independent, full-fledged form that can accept
 * Adwaita decoration. Transient menus, popups, tooltips, DND layers, and desktop
 * docks are excluded.
 * @param {number} [windowType=WindowType.NORMAL]
 * @returns {boolean}
 */
export function isDecoratableWindowType(windowType = WindowType.NORMAL) {
    return windowType === WindowType.NORMAL ||
           windowType === WindowType.DIALOG ||
           windowType === WindowType.MODAL_DIALOG ||
           windowType === WindowType.UTILITY;
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
    if (!isDecoratableWindowType(windowType))
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
 * An SSD window's ring is drawn by the frame client (`mutter-x11-frames`), not by the
 * client itself, so it does not count as a declaration (`hasSsd ⇒ false`). The policy
 * "the SSD ring is ours to clear when we clip" lives in `inferDecorationBaseline`
 * (`hasSsd ⇒ shadow=false, reason='has-ssd-frame'`) and in the ring-clearing logic of
 * `evaluateWindowActions`, not here.
 * @param {object} params
 * @param {boolean} [params.hasSsd=false] - SSD frame ring is not a client declaration
 * @param {number} params.sideW - Widest declared margin on the horizontal axis, logical px
 * @param {number} params.sideH - Widest declared margin on the vertical axis, logical px
 * @returns {boolean}
 */
export function declaresOwnShadow({hasSsd = false, sideW, sideH}) {
    return !hasSsd && (sideW > 0 || sideH > 0);
}

/**
 * Whether the window keeps a Mutter X11 shadow we could never clear: a bare X11 window,
 * with no declared ring and no compositor frame. The remedy is a rule, not our shadow.
 * @param {object} params
 * @param {boolean} [params.hasSsd=false]
 * @param {boolean} [params.isX11=false]
 * @param {boolean} [params.hasRing=false] - Whether the window declared a margin ring
 * @returns {boolean}
 */
export function hasUnclearableShadow({hasSsd = false, isX11 = false, hasRing = false} = {}) {
    return !hasSsd && isX11 && !hasRing;
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

    if (hasUnclearableShadow({hasSsd, isX11, hasRing: sideW > 0 || sideH > 0})) {
        shadow = false;
        reason = 'x11-mutter-native-shadow';
    } else if (hasSsd) {
        shadow = false;
        reason = 'has-ssd-frame';
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
    // Mutter's tile modes land here: `meta_window_tile_internal()` gives every mode but
    // META_TILE_MAXIMIZED `META_MAXIMIZE_VERTICAL` - so one flag alone is a half tile - a
    // pair of tiles matches each other, and a full maximize is both flags, the case that is
    // not tiled. Read from these rather than from where the frame sits: a window the user
    // merely placed flush against the work area is not tiled.
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
 * @property {boolean} [hasGtk4Client=false] - Whether the client is GTK4, whose own handle
 *        the declared margins can prove
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
 *  - `narrowestSides` is the smallest margin on each axis. "At least `RESIZE_BAND` on every
 *    side" is that minimum, not the per-axis average a two-sided total gives: a 0,24 ring is
 *    not 12 a side, so `decideResizeBand()` reads this pair.
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
 * Whether the window gets the resize band. Independent of the decoration: a
 * `resize-only` rule is valid, and a window we draw nothing else on can still be
 * grabbable. Capability gates (unresizable, maximized/fullscreen, SSD, too small)
 * are never overridden; reversing the axis bypasses only the GTK4 reading below.
 * See docs/decoration-model.md § The resize band.
 * @param {object} params
 * @param {boolean} [params.reversed=false] - Whether the rule reverses this axis
 * @param {boolean} [params.allowsResize=true]
 * @param {boolean} [params.isMaximized=false]
 * @param {boolean} [params.isFullscreen=false]
 * @param {boolean} [params.hasGtk4Client=false] - Whether the client is GTK4, whose own handle
 *        the declared margins can prove
 * @param {boolean} [params.hasSsd=false]
 * @param {import('./frame.js').Insets|null} [params.insets=null] - Declared ring, per side
 * @param {number} [params.bufferWidth=0]
 * @param {number} [params.bufferHeight=0]
 * @param {number} [params.frameWidth=0]
 * @param {number} [params.frameHeight=0]
 * @returns {boolean}
 */
export function decideResizeBand({
    reversed = false,
    allowsResize = true,
    isMaximized = false, isFullscreen = false,
    hasGtk4Client = false,
    hasSsd = false,
    insets = null,
    bufferWidth = 0, bufferHeight = 0,
    frameWidth = 0, frameHeight = 0,
} = {}) {
    // Capability, never overridable: no explicit value conjures these.
    if (!allowsResize || isMaximized || isFullscreen)
        return false;
    // Mutter's own frame carries the resize handles; a band would only take clicks the
    // frame already owns. `win.decorated` is a policy flag, but no `_MUTTER_FRAME_FOR`
    // check exists on the GJS side, and the flag is the best reading there is.
    if (hasSsd)
        return false;
    // `MIN_BAND_WINDOW` is only the ring's sanity bound (the band has to fit on the short
    // axis), never a native one: GTK's input region does not depend on the window size
    // (docs/decoration-model.md § The resize band).
    if (!(frameWidth >= MIN_BAND_WINDOW) || !(frameHeight >= MIN_BAND_WINDOW))
        return false;

    // The automatic reading. The band is the inner part of the ring the client reserved for
    // its own shadow, so a window that reserves nothing - an undecorated toplevel, a video
    // popup - gets none unless a rule reverses this axis.
    const {declaringSides, narrowestSides} =
        declaredSides({insets, bufferWidth, bufferHeight, frameWidth, frameHeight});
    const hasRing = declaringSides.sideW > 0 || declaringSides.sideH > 0;
    // Its own handle is already at least as wide as a native one on every side. Only GTK4 can
    // be read this way: it sizes the handle itself, so its declared margins prove it, while a
    // GTK3 window's margins are its shadow and say nothing about the theme's handle
    // (docs/decoration-model.md § The resize band).
    const hasNativeHandle = hasGtk4Client &&
        narrowestSides.sideW >= RESIZE_BAND && narrowestSides.sideH >= RESIZE_BAND;
    const heuristic = hasRing && !hasNativeHandle;

    // A rule reverses that reading and nothing else: the gates above are physics.
    return reversed ? !heuristic : heuristic;
}

/**
 * Resolves one axis: a rule reverses the automatic decision on the axes it names.
 * @param {Set<string>|null} reversedAxes
 * @param {string} axis
 * @param {boolean} baseline - What the heuristic decided
 * @returns {boolean}
 */
function resolveAxisValue(reversedAxes, axis, baseline) {
    return reversedAxes?.has(axis) ? !baseline : baseline;
}

/**
 * @param {WindowEvaluationParams} params
 * @returns {{drawShadow: boolean, drawClip: boolean, clearRing: boolean, drawResize: boolean, style: object, reason: string}}
 */
export function evaluateWindowActions({
    bufferWidth, bufferHeight, frameWidth, frameHeight,
    insets = null,
    monitorScale = 1,
    isMaximized = false, isFullscreen = false,
    hasSsd = false,
    isX11 = false,
    nativeLikeCorners = false,
    hasGtk4Client = false,
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

    // The shadow axis asks whether either side of an axis declares a ring, so it reads
    // the widest margin per axis (`declaringSides`).
    const {declaringSides} = declaredSides({insets, bufferWidth, bufferHeight, frameWidth, frameHeight});
    const {sideW, sideH} = declaringSides;
    const baseline = inferDecorationBaseline({
        isX11, sideW, sideH, hasSsd, nativeLikeCorners,
    });

    // Semantics vs strategy: declaresOwnShadow answers "did the client declare a ring?"
    // (SSD's ring is frame-drawn ⇒ false). The strategy "SSD ring is ours to clear when
    // we clip" is separate and handled here so the predicate can stay pure without
    // changing observable behavior (inferDecorationBaseline already handles hasSsd first).
    const clientOwnRing = declaresOwnShadow({hasSsd, sideW, sideH});

    const rule = resolveRule(wmClass, rules, {
        clientType: isX11 ? CLIENT_TYPE_TOKEN_X11 : CLIENT_TYPE_TOKEN_WAYLAND,
        windowType,
        hasParent: Boolean(hasParent),
        allowsResize,
        isAttachedDialog,
        hasRing: clientOwnRing,
        hasSsd,
        frameWidth,
        frameHeight,
    });

    // A rule reverses the automatic decision on the axes it names; see docs/rule-model.md.
    const corners = resolveAxisValue(rule, RuleAxis.CORNERS, baseline.corners);

    // Clip needs something to draw; radius 0 + no outline would be a wasted offscreen pass.
    const clip = corners && shouldClipWindow({preferCrispText, scale: monitorScale}) &&
        (style.radius > 0 || Boolean(style.outline));

    const ssdRing = hasSsd && (sideW > 0 || sideH > 0);
    const ownRing = clientOwnRing || ssdRing;

    // The automatic shadow decision, takeover included: the ring was painted for the
    // corners we replace, so the shadow is ours by default. A rule then reverses that
    // decision, and only that decision - which is why the takeover comes first.
    let shadow = baseline.shadow;
    if (clip && ownRing)
        shadow = true;
    shadow = resolveAxisValue(rule, RuleAxis.SHADOW, shadow);

    // Transient window state, not a judgment: a tile match reports where the window
    // sits right now, and the rule - which outlives it - applies again on restore.
    const shadowBeforeTiling = shadow;
    shadow = shadow && !hasTileMatch;

    // Ring is ours to clear exactly when the shadow we draw is ours.
    const clearRing = ownRing && shadow;

    const drawResize = decideResizeBand({
        reversed: Boolean(rule?.has(RuleAxis.RESIZE)),
        allowsResize,
        isMaximized, isFullscreen,
        hasGtk4Client, hasSsd,
        insets, bufferWidth, bufferHeight, frameWidth, frameHeight,
    });

    let reason = rule
        ? `rule-applied(${wmClass}:${buildRuleState(rule)})`
        : baseline.reason;
    if (clearRing)
        reason = `ring-cleared(${reason})`;
    if (shadowBeforeTiling && !shadow)
        reason = `tile-match(shadow-off,${reason})`;

    // Decoration stops at a structural disqualifier, but the band keeps its own physics
    // gates: a window too small for corners can still be grabbable. A kind that is ours on
    // no axis (dock, desktop) gets neither.
    if (!eligibility.eligible) {
        return {
            drawShadow: false, drawClip: false, clearRing: false,
            drawResize: isDecoratableWindowType(windowType) && drawResize,
            style, reason: eligibility.reason,
        };
    }

    return {drawShadow: shadow, drawClip: clip, clearRing, drawResize, style, reason};
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
        before.drawClip !== after.drawClip ||
        before.drawResize !== after.drawResize;
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
 * Picker suggestion under the never-maintain-status-quo principle: retract exactly the axes
 * currently on screen, or step in on the ones that are not. See docs/rule-model.md § The
 * pick heuristic.
 * @param {WindowEvaluationParams} params
 * @returns {string} Canonical stored state, never ''
 */
export function suggestedRuleState(params) {
    const kind = kindParams(params);
    const {drawShadow, drawClip, drawResize} = evaluateWindowActions(kind);
    if (drawShadow || drawClip || drawResize) {
        // Retract exactly what is on screen: reverse those axes.
        const reversed = [];
        if (drawClip)
            reversed.push(RuleAxis.CORNERS);
        if (drawShadow)
            reversed.push(RuleAxis.SHADOW);
        if (drawResize)
            reversed.push(RuleAxis.RESIZE);
        return buildRuleState(reversed);
    }

    // Nothing of ours is on screen: step in, reversing the axes the heuristic kept off.
    // The shadow stays out where Mutter's own X11 shadow cannot be cleared - reversing it
    // would paint a second one.
    const {sideW, sideH} = declaredSides(kind).declaringSides;
    const reversed = [RuleAxis.CORNERS];
    if (!hasUnclearableShadow({hasSsd: kind.hasSsd, isX11: kind.isX11, hasRing: sideW > 0 || sideH > 0}))
        reversed.push(RuleAxis.SHADOW);
    return buildRuleState(reversed);
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
