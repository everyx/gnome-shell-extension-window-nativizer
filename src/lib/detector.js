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

/** 2× the radius: below it the corner arcs overlap, so no rounded rect fits a 1×1 helper. */
export const MIN_DECORABLE_SIZE = 2 * ADWAITA_STYLE.window.radius;

const SHADOW_REACH = Math.max(...ADWAITA_STYLE.window.shadows.map(({blur, spread}) => blur + spread));

/** Pill below 2.5× radius, shadow-dominated below 2× reach; read on the size first decided. */
export const VISUAL_MIN_DECORABLE_SIZE = Math.max(2.5 * ADWAITA_STYLE.window.radius, 2 * SHADOW_REACH);

export function computeInsets(bufferWidth, bufferHeight, frameWidth, frameHeight) {
    return {
        w: Math.max(0, bufferWidth - frameWidth),
        h: Math.max(0, bufferHeight - frameHeight),
    };
}

/** Transient menus, popups, tooltips, DND layers and docks have no independent form to decorate. */
export function isDecoratableWindowType(windowType = WindowType.NORMAL) {
    return windowType === WindowType.NORMAL ||
           windowType === WindowType.DIALOG ||
           windowType === WindowType.MODAL_DIALOG ||
           windowType === WindowType.UTILITY;
}

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

    // Geometric floor on the frame as it is now: below 2*radius the arcs have met, so nothing fits.
    if (frameWidth < MIN_DECORABLE_SIZE || frameHeight < MIN_DECORABLE_SIZE)
        return {eligible: false, reason: `too-small(${frameWidth}x${frameHeight})`};

    // The visual floor reads the size first decided, which no drag flips; 0, NaN, Infinity abstain.
    const initialSize = Number.isFinite(initialFrameWidth) && initialFrameWidth > 0 &&
        Number.isFinite(initialFrameHeight) && initialFrameHeight > 0
        ? {width: initialFrameWidth, height: initialFrameHeight} : null;
    // `reversible` is the rule exit: the gates above are capabilities, this floor a reading.
    if (initialSize &&
        (initialSize.width <= VISUAL_MIN_DECORABLE_SIZE || initialSize.height <= VISUAL_MIN_DECORABLE_SIZE))
        return {eligible: false, reason: `too-small-for-corners(${initialSize.width}x${initialSize.height})`, reversible: true};

    return {eligible: true, reason: ''};
}

/** Mutter's has_custom_frame_extents: any declared margin counts, an SSD frame's ring does not. */
export function declaresOwnShadow({hasSsd = false, sideW, sideH}) {
    return !hasSsd && (sideW > 0 || sideH > 0);
}

/** Mutter abstains on an ARGB32 buffer and paints an opaque one, so alpha means ours to paint. */
function bareX11ShadowOwner(bufferAlpha) {
    if (bufferAlpha === true)
        return 'ours';
    if (bufferAlpha === false)
        return 'mutter';
    return 'unknown';
}

/** Widest declared margin per axis, logical px; alpha is read only for a bare X11 window. */
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
        // Bare X11 only: a depth-24 client in a depth-32 SSD frame reports the frame's alpha.
        const owner = bareX11ShadowOwner(bufferAlpha);
        if (owner === 'mutter') {
            shadow = false;
            reason = 'x11-mutter-native-shadow';
        } else if (owner === 'ours') {
            reason = 'x11-rgba-shadow-ours';
        } else {
            // Unknown: no shadow of ours, and no corners: the clip would cut an unrounded body.
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

/** Shared with the picker's rule key so the two cannot disagree; totals when insets are absent. */
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
    // An unknown scale is its own state: clipping it blurs the text this setting protects, so skip.
    if (scale === null || scale === undefined)
        return false;
    return !isFractionalScale(scale);
}

export {isWindowMaximized, isWindowTiled};

/** The ring question reads the widest margin per axis, the band the narrowest: 0,24 is not 12. */
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

/** Independent of the decoration, so a resize-only rule is valid; reversal skips the GTK4 read. */
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
    if (!allowsResize || isMaximized || isFullscreen)
        return false;
    // Mutter's frame owns the handles; `win.decorated` is a policy flag and GJS has no frame check.
    if (hasSsd)
        return false;
    // Sanity bound only (the band must fit the short axis), never native: GTK's input region is free.
    if (!(frameWidth >= MIN_BAND_WINDOW) || !(frameHeight >= MIN_BAND_WINDOW))
        return false;

    // Only GTK4 sizes its own handle; GTK3 margins are the theme's shadow, a bare window has none.
    const {narrowestSides} =
        declaredSides({insets, bufferWidth, bufferHeight, frameWidth, frameHeight});
    const hasNativeHandle = hasGtk4Client &&
        narrowestSides.sideW >= RESIZE_BAND && narrowestSides.sideH >= RESIZE_BAND;

    return reversed ? hasNativeHandle : !hasNativeHandle;
}

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

    // The shadow axis asks whether either side declares a ring, so it reads the widest margin.
    const {declaringSides} = declaredSides({insets, bufferWidth, bufferHeight, frameWidth, frameHeight});
    const {sideW, sideH} = declaringSides;

    // A reading, not a capability: a rule reverses it on the axis it names; the gates below do not.
    const visuallyFloored = eligibility.reversible === true;
    const baseline = visuallyFloored
        ? {corners: false, shadow: false, reason: eligibility.reason}
        : inferDecorationBaseline({isX11, sideW, sideH, hasSsd, bufferAlpha, nativeLikeCorners});

    // `clientDeclaredRing` stays a pure question; clearing the SSD ring is strategy, handled here.
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

    const corners = resolveAxisValue(rule, RuleAxis.CORNERS, baseline.corners);

    // Clip needs something to draw; radius 0 + no outline would be a wasted offscreen pass.
    const clip = corners && shouldClipWindow({preferCrispText, scale: monitorScale}) &&
        (style.radius > 0 || Boolean(style.outline));

    const ssdRing = hasSsd && (sideW > 0 || sideH > 0);
    const ownRing = clientOwnRing || ssdRing;

    // Takeover first: the ring was painted for the corners we replace, so the shadow is ours.
    let shadow = baseline.shadow;
    if (clip && ownRing)
        shadow = true;
    shadow = resolveAxisValue(rule, RuleAxis.SHADOW, shadow);

    // Transient: a tile match says where the window sits now; the rule applies again on restore.
    const shadowBeforeTiling = shadow;
    shadow = shadow && !hasTileMatch;

    const drawResize = decideResizeBand({
        reversed: Boolean(rule?.has(RuleAxis.RESIZE)),
        allowsResize,
        isMaximized, isFullscreen,
        hasGtk4Client, hasSsd,
        insets, bufferWidth, bufferHeight, frameWidth, frameHeight,
    });

    // A tiled window gets upstream's 1px ring, not a shadow: `style.border` decides drawing it.
    const drawRing = Boolean(style.border) && (clip || shadow || drawResize);

    // Clear only the ring drawn by us: erasing one we do not replace would leave no edge.
    const clear = ownRing && (shadow || drawRing);

    // `clear` takes the ring over; `safeInset` clips inside it, flatness read per side, not totals.
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

    // Decoration stops at a structural disqualifier, the band keeps its gates; a dock gets neither.
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
