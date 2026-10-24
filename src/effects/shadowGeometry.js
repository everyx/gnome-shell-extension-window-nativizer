/** Pure geometry without GI imports, so the degenerate-size rules stay unit-testable. */

import {rectEquals, sameSize} from '../platform/rect.js';
import {ADWAITA_STYLE} from '../lib/adwaitaStyle.generated.js';
import {SHADOW_BAKE_ORIGIN, SHADOW_BAKE_EXTRA} from '../lib/shadowBake.js';
import {twoDecimals} from '../lib/diagnosticInvariants.js';
import {clipFrameFor, ZERO_PHASE} from '../lib/snap.js';
import {resolvePaintBody, BODY_SETTLE_TOLERANCE} from './clipParams.js';
import {getAppliedSubpixelPhase, getWindowSubpixelOffset} from '../platform/window.js';

export const SHADOW_PAD = ADWAITA_STYLE.shadowPad;

/** One logical px: above the scale residue, below the whole-pixel defects it separates. */
export const SHADOW_BODY_TOLERANCE = BODY_SETTLE_TOLERANCE;

// 2px near + 1px far, the shape Clutter's box-enlarge rule gives on an integer box.
const BAKE_ORIGIN = SHADOW_BAKE_ORIGIN;
const BAKE_EXTRA = SHADOW_BAKE_EXTRA;

/** 2*(pad+radius) square, middle 2*pad; the corner spans 2*pad+radius so the cutline stays C0. */
export function shadowGeometry(radius) {
    const corner = 2 * SHADOW_PAD + radius;
    const window = 2 * (SHADOW_PAD + radius);
    return {
        corner,
        window,
        buffer: 2 * corner + BAKE_EXTRA,
    };
}

/** The hole is the clip's phase-free frame edge plus SHADOW_PAD, not a second derivation of it. */
export function shadowCastRectForBody(bodySize, insets, scale = 1.0) {
    const body = clipFrameFor(bodySize, insets, scale, ZERO_PHASE);
    return {
        x: body.x,
        y: body.y,
        width: body.width + SHADOW_PAD * 2,
        height: body.height + SHADOW_PAD * 2,
    };
}

/** Phase-free: the actor carries the phase as a translation, so the cast stays actor-local. */
export function shadowCastRect(actorSize, insets, scale = 1.0) {
    return shadowCastRectForBody({
        width: actorSize.width - SHADOW_PAD * 2,
        height: actorSize.height - SHADOW_PAD * 2,
    }, insets, scale);
}

/** Names both body extents and the signed delta, so a journal line says which side moved. */
export function shadowBodyWarning(authority, shadowBox, windowActorBox = null, state = null) {
    if (!authority || !shadowBox)
        return null;
    const bodyWidth = shadowBox.width - SHADOW_PAD * 2;
    const bodyHeight = shadowBox.height - SHADOW_PAD * 2;
    if (Math.abs(authority.width - bodyWidth) <= SHADOW_BODY_TOLERANCE &&
        Math.abs(authority.height - bodyHeight) <= SHADOW_BODY_TOLERANCE)
        return null;

    const actor = windowActorBox
        ? ` (window actor ${twoDecimals(windowActorBox.width)}x${twoDecimals(windowActorBox.height)})`
        : '';
    // Both sides are body extents, so three near-identical numbers need the printed sign.
    const deltaWidth = authority.width - bodyWidth;
    const deltaHeight = authority.height - bodyHeight;
    return `Shadow body authority ${twoDecimals(authority.width)}x${twoDecimals(authority.height)} ` +
        `disagrees with the shadow body ${twoDecimals(bodyWidth)}x${twoDecimals(bodyHeight)}${actor} ` +
        `by ${twoDecimals(deltaWidth)}x${twoDecimals(deltaHeight)}px` +
        // A hold and spent strikes print the same extents; only this says which the code was in.
        `${state ? ` (${state})` : ''}`;
}

/** Names why the settle could not decide; null when it did, or when the size is unreadable. */
export function settleUndecidedState({unsettled = false, pairDisagreementStrikes = 0, windowKnown = false} = {}) {
    if (!windowKnown)
        return null;
    if (unsettled) {
        return pairDisagreementStrikes > 0
            ? 'neither read is confirmed by the window size'
            : 'the authority moved while the window did not';
    }
    return pairDisagreementStrikes > 0 ? 'settled out of strikes on the window actor' : null;
}

/** The read, not the reference, is the authority: a container resized in place is a change. */
export function clipTargetReadChanged(previousTarget, nextTarget, previousSize, nextSize) {
    if (previousTarget !== nextTarget)
        return true;
    if (!previousSize || !nextSize)
        return Boolean(previousSize) !== Boolean(nextSize);
    return previousSize.width !== nextSize.width || previousSize.height !== nextSize.height;
}

/** Actor translation plus the subpixel offset, so the cutout lands on the buffer's phase. */
export function shadowTranslation(windowActor, offset) {
    return {
        x: (windowActor?.translation_x ?? 0) + offset.x,
        y: (windowActor?.translation_y ?? 0) + offset.y,
    };
}

/** From the transform, not the layout box: only it cancels SHADOW_PAD at any scale or pivot. */
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

/** Same strategy as the clip, so one source feeds both cuts; null keeps the caller's last phase. */
export function shadowPhaseOffset(win, phaseInTransform, St = null) {
    if (phaseInTransform) {
        const applied = getAppliedSubpixelPhase(win, St);
        if (applied)
            return applied;
    }
    return getWindowSubpixelOffset(win, St);
}

/** Corners at 1:1, edges stretched from a 1px strip, empty middle; sizes clamp at zero. */
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

    // A cast narrower than two corners shows only its outer `c` bake px, not the same ones scaled.
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

/** Runs on the actor's allocation clock, so the cast tracks the frame the compositor draws. */
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
    const castChanged = !rectEquals(previous, cast);
    // Only the corner clamp reads the cast size, so a moved origin reuses the slice table.
    const sizeChanged = !sameSize(previous, cast);

    let slices = style.slices;
    let corner = style.corner;
    if (sizeChanged || !slices) {
        const geometry = shadowGeometry(style.radius);
        slices = shadowSlices(geometry, cast.width, cast.height);
        corner = geometry.corner;
    }

    return {
        cast, slices, corner, castChanged, authority, body,
        unsettled: settled?.unsettled ?? false,
        pairDisagreementStrikes: settled?.pairDisagreementStrikes ?? 0,
        windowKnown: settled?.windowKnown ?? false,
    };
}
