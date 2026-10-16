/**
 * Pure shadow geometry: the baked square and how it slices across a window.
 *
 * Kept free of GI imports so the degenerate-size rules stay unit-testable; the Cogl
 * bake lives in shadowTexture.js.
 */

import {ADWAITA_STYLE} from '../lib/adwaitaStyle.generated.js';
import {EFFECT_PADDING_ORIGIN, EFFECT_PADDING_EXTRA} from '../lib/clutterEffectPadding.generated.js';
import {clipFrameFor, ZERO_PHASE} from '../lib/snap.js';
import {resolvePaintBody, BODY_SETTLE_TOLERANCE} from './clipParams.js';
import {getAppliedSubpixelPhase, getWindowSubpixelOffset} from '../platform/window.js';

export const SHADOW_PAD = ADWAITA_STYLE.shadowPad;

/**
 * How far the clip's body authority and the shadow's own body may differ before it is a defect. One
 * logical pixel sits above the fractional-scale residue between `buffer / scale` and an integer
 * allocation, and below the whole-pixel defects this separates (the observed one was 2px).
 */
export const SHADOW_BODY_TOLERANCE = BODY_SETTLE_TOLERANCE;

// Offscreen padding matching Mutter clutter-actor-box conventions (2px origin, 3px extra).
const BAKE_ORIGIN = EFFECT_PADDING_ORIGIN;
const BAKE_EXTRA = EFFECT_PADDING_EXTRA;

/**
 * Canonical square 2*(pad+radius) with middle 2*pad (settled strip).
 * Corner slice spans 2*pad+radius so the cutline sits at the settled profile (C0 continuity).
 * @param radius - Corner radius in px
 * @returns sizes in px
 */
export function shadowGeometry(radius) {
    const corner = 2 * SHADOW_PAD + radius;
    const window = 2 * (SHADOW_PAD + radius);
    return {
        corner,
        window,
        buffer: 2 * corner + BAKE_EXTRA,
    };
}

/**
 * Computes the cast rect from an already-resolved body size: the expansion of the phase-free
 * `clipFrameFor` body by `SHADOW_PAD`, so the hole is the clip's frame edge rather than a second
 * derivation of it.
 */
export function shadowCastRectForBody(bodySize, insets, scale = 1.0) {
    const body = clipFrameFor(bodySize, insets, scale, ZERO_PHASE);
    return {
        x: body.x,
        y: body.y,
        width: body.width + SHADOW_PAD * 2,
        height: body.height + SHADOW_PAD * 2,
    };
}

/**
 * Computes the cast rect from the actor's live size by snapping the body frame and expanding it by
 * `SHADOW_PAD`, the same `clipFrameFor` expression the resolved-body form uses. The cast is
 * deliberately phase-free: the shadow actor carries the phase as a translation, which keeps the cast
 * actor-local for drag invariance.
 */
export function shadowCastRect(actorSize, insets, scale = 1.0) {
    return shadowCastRectForBody({
        width: actorSize.width - SHADOW_PAD * 2,
        height: actorSize.height - SHADOW_PAD * 2,
    }, insets, scale);
}

/**
 * The WARNING text for a shadow box that no longer describes the clip's body, or null when they agree
 * within `SHADOW_BODY_TOLERANCE`. It names the authority and the shadow's body (and the window actor
 * when known) with the signed delta, so a journal hit says which side moved and by how much.
 */
export function shadowBodyWarning(authority, shadowBox, windowActorBox = null) {
    if (!authority || !shadowBox)
        return null;
    const bodyWidth = shadowBox.width - SHADOW_PAD * 2;
    const bodyHeight = shadowBox.height - SHADOW_PAD * 2;
    if (Math.abs(authority.width - bodyWidth) <= SHADOW_BODY_TOLERANCE &&
        Math.abs(authority.height - bodyHeight) <= SHADOW_BODY_TOLERANCE)
        return null;

    const actor = windowActorBox
        ? ` (window actor ${fmt2(windowActorBox.width)}x${fmt2(windowActorBox.height)})`
        : '';
    // The delta is printed explicitly: the two sides are the *body* extents being compared (the
    // shadow box carries SHADOW_PAD per side), so a reader sees which side is larger and by how
    // much instead of reading three near-identical numbers next to a bare tolerance.
    const deltaWidth = authority.width - bodyWidth;
    const deltaHeight = authority.height - bodyHeight;
    return `[window-nativizer] Shadow body authority ${fmt2(authority.width)}x${fmt2(authority.height)} ` +
        `disagrees with the shadow body ${fmt2(bodyWidth)}x${fmt2(bodyHeight)}${actor} ` +
        `by ${fmt2(deltaWidth)}x${fmt2(deltaHeight)}px`;
}

/**
 * Whether a fresh clip-target read differs from the one the shadow last laid out from, so the caller
 * must schedule another layout. The authority is the read, not the object: a container resized in
 * place is a change, and an unknown read is a change from a known one.
 */
export function clipTargetReadChanged(previousTarget, nextTarget, previousSize, nextSize) {
    if (previousTarget !== nextTarget)
        return true;
    if (!previousSize || !nextSize)
        return Boolean(previousSize) !== Boolean(nextSize);
    return previousSize.width !== nextSize.width || previousSize.height !== nextSize.height;
}

/**
 * @returns The value with two decimal places, so a sub-pixel difference is visible
 */
function fmt2(value) {
    return Number(value).toFixed(2);
}

/**
 * The shadow actor's translation for a window actor: the window actor's own translation plus the
 * subpixel offset, so the cutout lands on the buffer's physical phase while the window's animation is
 * kept. Composed here so it can be asserted without a Clutter actor.
 */
export function shadowTranslation(windowActor, offset) {
    return {
        x: (windowActor?.translation_x ?? 0) + offset.x,
        y: (windowActor?.translation_y ?? 0) + offset.y,
    };
}

/**
 * The shadow actor's layout position for a window actor under a Clutter scale/pivot transform: it is
 * derived from that transform rather than from the actor's layout box, because `SHADOW_PAD` is baked
 * into both the layout box and the local cutout, and only the transform cancels the two at any scale
 * and pivot.
 */
export function shadowLayoutPosition(windowActor, pad = SHADOW_PAD) {
    const x = windowActor?.x ?? 0;
    const y = windowActor?.y ?? 0;
    const scaleX = windowActor?.scale_x ?? 1;
    const scaleY = windowActor?.scale_y ?? 1;
    const pivotX = windowActor?.pivot_point?.x ?? 0;
    const pivotY = windowActor?.pivot_point?.y ?? 0;
    return {
        x: x - pad * (scaleX + 2 * pivotX * (1 - scaleX)),
        y: y - pad * (scaleY + 2 * pivotY * (1 - scaleY)),
    };
}

/**
 * The subpixel phase the shadow translates by, chosen by the same strategy as the clip: the applied
 * transform on the container path, the mirrored arithmetic on the fallback path, so one source feeds
 * both cuts. Null when neither can answer, and the caller keeps its last good phase.
 */
export function shadowPhaseOffset(win, phaseInTransform, St = null) {
    if (phaseInTransform) {
        const applied = getAppliedSubpixelPhase(win, St);
        if (applied)
            return applied;
    }
    return getWindowSubpixelOffset(win, St);
}

/**
 * The shadow's slices: eight rects (four corners at 1:1, four edges stretched from a 1px strip) with an
 * empty middle. Sizes clamp at zero, since a resize can pass a degenerate cast, and a cast narrower
 * than two corners samples only the bake pixels its quad shows - the same inequality the decoration
 * floor is.
 */
export function shadowSlices({corner, window, buffer}, width, height) {
    const safeW = Math.max(0, width);
    const safeH = Math.max(0, height);
    const c = Math.max(0, Math.min(corner, safeW / 2, safeH / 2));
    const o = BAKE_ORIGIN;
    const near = o / buffer;
    const span = corner / buffer;
    const strip = 1 / buffer;
    const far = (buffer - corner - 1) / buffer;
    const edge = (o + SHADOW_PAD + window / 2) / buffer;
    const right = Math.max(c, safeW - c);
    const bottom = Math.max(c, safeH - c);

    // Bake px the corner shows: all of them when the cast is wide enough for both corners (which
    // is the only size the bake was sized for), `c` of them - the outer ones - when it is not.
    const shown = c / buffer;
    const innerNear = near + shown;
    const outerFar = far + span;
    const innerFar = outerFar - shown;

    return [
        {x1: 0, y1: 0, x2: c, y2: c, s1: near, t1: near, s2: innerNear, t2: innerNear},
        {x1: right, y1: 0, x2: safeW, y2: c, s1: innerFar, t1: near, s2: outerFar, t2: innerNear},
        {x1: 0, y1: bottom, x2: c, y2: safeH, s1: near, t1: innerFar, s2: innerNear, t2: outerFar},
        {x1: right, y1: bottom, x2: safeW, y2: safeH, s1: innerFar, t1: innerFar, s2: outerFar, t2: outerFar},
        {x1: c, y1: 0, x2: right, y2: c, s1: edge, t1: near, s2: edge + strip, t2: innerNear},
        {x1: c, y1: bottom, x2: right, y2: safeH, s1: edge, t1: innerFar, s2: edge + strip, t2: outerFar},
        {x1: 0, y1: c, x2: c, y2: bottom, s1: near, t1: edge, s2: innerNear, t2: edge + strip},
        {x1: right, y1: c, x2: safeW, y2: bottom, s1: innerFar, t1: edge, s2: outerFar, t2: edge + strip},
    ];
}

/**
 * Decides one paint's layout: the cast rect, the slices, the corner, whether the cast moved enough to
 * rebuild them, and the body authority it settled on. The settle runs on the actor's allocation clock,
 * so the cast tracks the frame the compositor draws; without `bodySource` the body is the actor box
 * minus `SHADOW_PAD`.
 */
export function shadowLayout(style, actorSize, insets, scale = 1.0, bodySource = null) {
    const settled = bodySource
        ? resolvePaintBody(bodySource.targetSize, bodySource.windowActorSize, bodySource.windowSize,
            bodySource.bodyPlan)
        : null;
    const authority = settled?.authority ?? null;
    const body = settled?.body ?? null;
    const cast = body
        ? shadowCastRectForBody(body, insets, scale)
        : shadowCastRect(actorSize, insets, scale);
    const previous = style.cast;
    const castChanged = !previous ||
        previous.x !== cast.x || previous.y !== cast.y ||
        previous.width !== cast.width || previous.height !== cast.height;

    let slices = style.slices;
    let corner = style.corner;
    if (castChanged || !slices) {
        const geometry = shadowGeometry(style.radius);
        slices = shadowSlices(geometry, cast.width, cast.height);
        corner = geometry.corner;
    }

    return {cast, slices, corner, castChanged, authority, body};
}
