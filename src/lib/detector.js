import {WindowType} from './mutterRules.generated.js';

import {
    CLIENT_TYPE_TOKEN_WAYLAND,
    CLIENT_TYPE_TOKEN_X11,
    RuleAxis,
    buildRuleState,
    resolveRule,
} from './rules.js';
import {styleForWindow} from './style.js';
import {ADWAITA_STYLE} from './adwaitaStyle.generated.js';
import {MIN_BAND_WINDOW, RESIZE_BAND} from './resizeBand.js';
import {isWindowMaximized, isWindowTiled} from '../platform/window.js';

// 2× the libadwaita radius: below it the two corner arcs overlap, so no rounded rect fits (helper surface, e.g. wl-clipboard 1×1).
export const MIN_DECORABLE_SIZE = 2 * ADWAITA_STYLE.window.radius;

// How far the farthest shadow layer reaches out: blur plus spread, the layer's own extent.
const SHADOW_REACH = Math.max(...ADWAITA_STYLE.window.shadows.map(({blur, spread}) => blur + spread));

/**
 * Visual floor, in logical px: at or below 2.5× the radius the corners read as a pill, at or below
 * 2× the shadow reach the shadow dominates the body it sits behind. It is judged on the size a
 * window was first decided at, never on the size it is in now.
 */
export const VISUAL_MIN_DECORABLE_SIZE = Math.max(2.5 * ADWAITA_STYLE.window.radius, 2 * SHADOW_REACH);

/**
 * @returns Two-sided totals, each >= 0
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
 */
export function isDecoratableWindowType(windowType = WindowType.NORMAL) {
    return windowType === WindowType.NORMAL ||
           windowType === WindowType.DIALOG ||
           windowType === WindowType.MODAL_DIALOG ||
           windowType === WindowType.UTILITY;
}

/**
 * @param [params.frameWidth=Infinity] - Current frame width, logical px
 * @param [params.frameHeight=Infinity] - Current frame height, logical px
 * @param [params.initialFrameWidth=null] - Frame width the window was first decided at, logical px
 * @param [params.initialFrameHeight=null] - Frame height the window was first decided at, logical px
 */
export function checkDecorationEligibility({
    windowType = WindowType.NORMAL,
    isMaximized = false, isFullscreen = false,
    frameWidth = Number.POSITIVE_INFINITY,
    frameHeight = Number.POSITIVE_INFINITY,
    initialFrameWidth = null, initialFrameHeight = null,
} = {}) {
    if (!isDecoratableWindowType(windowType))
        return {eligible: false, reason: `window-type=${windowType}`};

    // libadwaita: maximized/fullscreen have square corners, no shadow.
    if (isMaximized || isFullscreen)
        return {eligible: false, reason: 'maximized/fullscreen'};

    // Two floors in one place, reading two sizes. This one is geometric and reads the frame as it
    // is right now: below 2*radius the two arcs have met, so no rounded rect fits and a 1×1 helper
    // (wl-clipboard) would get a shadow over nothing. A drag under it drops the decoration.
    if (frameWidth < MIN_DECORABLE_SIZE || frameHeight < MIN_DECORABLE_SIZE)
        return {eligible: false, reason: `too-small(${frameWidth}x${frameHeight})`};

    // The visual floor reads the size the window was FIRST decided at, which the user never chose,
    // so no drag can flip it. 0, NaN and Infinity are unreadable rather than small: they abstain,
    // and the caller's latch stays open for a pass that can read one.
    const initialSize = Number.isFinite(initialFrameWidth) && initialFrameWidth > 0 &&
        Number.isFinite(initialFrameHeight) && initialFrameHeight > 0
        ? {width: initialFrameWidth, height: initialFrameHeight} : null;
    // `reversible` is the rule exit: the gates above are capabilities, this floor a reading.
    if (initialSize &&
        (initialSize.width <= VISUAL_MIN_DECORABLE_SIZE || initialSize.height <= VISUAL_MIN_DECORABLE_SIZE))
        return {eligible: false, reason: `too-small-for-corners(${initialSize.width}x${initialSize.height})`, reversible: true};

    return {eligible: true, reason: ''};
}

/**
 * Whether the client declared a decoration ring of its own, on either axis - the same question
 * Mutter's boolean `has_custom_frame_extents` answers (any declared margin counts).
 * An SSD window's ring is drawn by the frame client, not the client, so it is not a declaration.
 */
export function declaresOwnShadow({hasSsd = false, sideW, sideH}) {
    return !hasSsd && (sideW > 0 || sideH > 0);
}

/**
 * Who paints a bare X11 window's shadow, read from the buffer's alpha channel. Mutter's has_shadow()
 * abstains for a non-opaque (ARGB32) window and paints one for an opaque one, so a buffer with
 * alpha leaves the shadow to us while an RGB one is what Mutter already paints. A null read
 * abstains from both.
 */
function bareX11ShadowOwner(bufferAlpha) {
    if (bufferAlpha === true)
        return 'ours';
    if (bufferAlpha === false)
        return 'mutter';
    return 'unknown';
}

/**
 * @param params.sideW - Widest declared margin on the horizontal axis, logical px
 * @param params.sideH - Widest declared margin on the vertical axis, logical px
 */
export function inferDecorationBaseline({
    isX11 = false,
    sideW, sideH,
    hasSsd = false,
    bufferAlpha = null,
    nativeLikeCorners = false,
}) {
    const insets = `${sideW.toFixed(1)}x${sideH.toFixed(1)}`;

    let shadow = true;
    let corners = true;
    let reason = `no-csd(${insets})`;

    if (!hasSsd && isX11 && !(sideW > 0 || sideH > 0)) {
        // The alpha read is meaningful only for a bare X11 window: a depth-24 client wrapped in a
        // depth-32 SSD frame reports the frame's alpha, so hasSsd must be false for the number to
        // be the client's own.
        const owner = bareX11ShadowOwner(bufferAlpha);
        if (owner === 'mutter') {
            shadow = false;
            reason = 'x11-mutter-native-shadow';
        } else if (owner === 'ours') {
            reason = 'x11-rgba-shadow-ours';
        } else {
            // Unknown: no shadow of ours, so it can never be a second one, and no corners either,
            // since a clip with nothing under it would cut a body we did not round for.
            shadow = false;
            corners = false;
            reason = 'x11-shadow-unknown';
        }
    } else if (hasSsd) {
        shadow = false;
        reason = 'has-ssd-frame';
    } else if (declaresOwnShadow({hasSsd, sideW, sideH})) {
        shadow = false;
        reason = `has-csd(${insets})`;
    }

    if (nativeLikeCorners)
        return {shadow, corners: false, reason: `native-like-corners; shadow: ${reason}`};

    return {shadow, corners, reason};
}

/**
 * The ring the client declared, read the one way both the decision and the picker's rule key
 * need, so the two cannot disagree. Reads per-side rectangles, falling back to two-sided totals.
 */
export function clientDeclaredRing({
    hasSsd = false,
    insets = null,
    bufferWidth = 0, bufferHeight = 0,
    frameWidth = 0, frameHeight = 0,
} = {}) {
    const {declaringSides} = declaredSides({insets, bufferWidth, bufferHeight, frameWidth, frameHeight});
    return declaresOwnShadow({hasSsd, sideW: declaringSides.sideW, sideH: declaringSides.sideH});
}

export function isFractionalScale(scale) {
    if (scale === null || scale === undefined || !Number.isFinite(scale) || scale <= 0)
        return false;
    return Math.abs(scale - Math.round(scale)) > 0.001;
}

export function shouldClipWindow({preferCrispText = false, scale = 1}) {
    if (!preferCrispText)
        return true;
    // An unknown scale is its own state, not an integer: the read can be fractional, and
    // clipping it would blur the text this setting exists to protect. Skip the clip for this
    // pass - the next reconcile retries the scale read - rather than guess an integer.
    if (scale === null || scale === undefined)
        return false;
    return !isFractionalScale(scale);
}

export {isWindowMaximized, isWindowTiled};


/**
 * What `evaluateWindowActions` decides for one window, per axis plus the resolved style.
 */

/**
 * The declared margin, read the two ways the questions need. `declaringSides` is the widest margin
 * per axis - "a ring on either side", the shadow question. `narrowestSides` is the smallest: the band
 * needs `RESIZE_BAND` on every side, not an average, where a 0,24 ring is not 12. Totals serve as both.
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
 * Whether the window gets the resize band - independent of the decoration, so a `resize-only`
 * rule is valid. Capability gates (unresizable, maximized/fullscreen, SSD, too small) are never
 * overridden; a reversed axis bypasses only the GTK4 handle reading below.
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
    // axis), never a native one: GTK's input region does not depend on the window size.
    if (!(frameWidth >= MIN_BAND_WINDOW) || !(frameHeight >= MIN_BAND_WINDOW))
        return false;

    // The automatic reading: the client's own handle is already at least RESIZE_BAND on every
    // side. Only GTK4 proves this from its margins - it sizes the handle itself; a GTK3
    // window's margins are its theme's shadow. A bare window reserves no ring.
    const {narrowestSides} =
        declaredSides({insets, bufferWidth, bufferHeight, frameWidth, frameHeight});
    const hasNativeHandle = hasGtk4Client &&
        narrowestSides.sideW >= RESIZE_BAND && narrowestSides.sideH >= RESIZE_BAND;

    // A rule reverses that reading and nothing else: the gates above are physics.
    return reversed ? hasNativeHandle : !hasNativeHandle;
}

/**
 * Resolves one axis: a rule reverses the automatic decision on the axes it names.
 * @param baseline - What the heuristic decided
 */
function resolveAxisValue(reversedAxes, axis, baseline) {
    return reversedAxes?.has(axis) ? !baseline : baseline;
}

export function evaluateWindowActions({
    bufferWidth, bufferHeight, frameWidth, frameHeight,
    initialFrameWidth = null, initialFrameHeight = null,
    insets = null,
    monitorScale = 1,
    isMaximized = false, isFullscreen = false,
    hasSsd = false,
    isX11 = false,
    bufferAlpha = null,
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
    animationsEnabled = true,
    dark = false,
    wmClass,
    rules = {},
    preferCrispText = false,
}) {
    const style = styleForWindow({focused, maximized: isMaximized, fullscreen: isFullscreen, tiled, highContrast, animationsEnabled, dark});

    const eligibility = checkDecorationEligibility({
        windowType, isMaximized, isFullscreen,
        frameWidth, frameHeight,
        initialFrameWidth, initialFrameHeight,
    });

    // The shadow axis asks whether either side of an axis declares a ring, so it reads
    // the widest margin per axis (`declaringSides`).
    const {declaringSides} = declaredSides({insets, bufferWidth, bufferHeight, frameWidth, frameHeight});
    const {sideW, sideH} = declaringSides;

    // The visual floor is a reading of how the decoration carries at a size the user never chose,
    // not a capability: it answers both axes off, and a rule naming an axis reverses it there like
    // any other reading. The geometric floor and the structural gates return below, out of reach.
    const visuallyFloored = eligibility.reversible === true;
    const baseline = visuallyFloored
        ? {corners: false, shadow: false, reason: eligibility.reason}
        : inferDecorationBaseline({isX11, sideW, sideH, hasSsd, bufferAlpha, nativeLikeCorners});

    // Semantics vs strategy: `clientDeclaredRing` answers "did the client declare a ring?" (an SSD
    // frame's ring is frame-drawn, so no). The strategy "the SSD ring is ours to clear when we
    // clip" is separate and handled here, so the predicate can stay pure.
    const clientOwnRing = clientDeclaredRing({hasSsd, insets, bufferWidth, bufferHeight, frameWidth, frameHeight});

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

    // A rule reverses the automatic decision on the axes it names.
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

    const drawResize = decideResizeBand({
        reversed: Boolean(rule?.has(RuleAxis.RESIZE)),
        allowsResize,
        isMaximized, isFullscreen,
        hasGtk4Client, hasSsd,
        insets, bufferWidth, bufferHeight, frameWidth, frameHeight,
    });

    // The tiled ring is not a shadow: upstream gives a tiled window a 1px ring instead, marked by
    // style.border. One predicate decides both whether it is drawn and whether the client's ring is
    // erased - erasing a ring we do not replace leaves no edge.
    const drawRing = Boolean(style.border) && (clip || shadow || drawResize);

    // Ring is ours to clear exactly when the ring we draw is ours.
    const clear = ownRing && (shadow || drawRing);

    // The ring, resolved once: whether it is ours to take over (`clear`) and whether the clip must
    // sit `flatSafeInsets` inside because the client painted a border up to the actor edge instead
    // of declaring one (`safeInset`). Flatness reads the side insets, not the two-sided totals.
    const flat = !insets ||
        (insets.left <= 0 && insets.top <= 0 && insets.right <= 0 && insets.bottom <= 0);
    const ring = {
        clear,
        safeInset: flat && (clip || shadow),
    };

    let reason = rule
        ? `rule-applied(${wmClass}:${buildRuleState(rule)})`
        : baseline.reason;
    if (clear)
        reason = `ring-cleared(${reason})`;
    if (shadowBeforeTiling && !shadow)
        reason = `tile-match(shadow-off,${reason})`;

    // Decoration stops at a structural disqualifier, but the band keeps its own physics
    // gates: a window too small for corners can still be grabbable. A kind that is ours on
    // no axis (dock, desktop) gets neither.
    if (!eligibility.eligible && !visuallyFloored) {
        return {
            drawShadow: false, drawClip: false, drawRing: false,
            drawResize: isDecoratableWindowType(windowType) && drawResize,
            ring: {...ring, clear: false, safeInset: false},
            style, reason: eligibility.reason,
        };
    }

    return {drawShadow: shadow, drawClip: clip, drawRing, drawResize, ring, style, reason};
}
