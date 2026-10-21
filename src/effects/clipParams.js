/** Pure decisions: which uniforms changed, when the frame is stale; the effect only uploads. */

import {INVARIANT_STRIKES} from '../lib/diagnosticInvariants.js';

/** Outline as the shader's vec4, 0..255 channels scaled to 0..1; `null` (no outline) is alpha 0. */
export function outlineVector(outline) {
    return outline
        ? [
            outline.color[0] > 1 ? outline.color[0] / 255 : outline.color[0],
            outline.color[1] > 1 ? outline.color[1] / 255 : outline.color[1],
            outline.color[2] > 1 ? outline.color[2] / 255 : outline.color[2],
            outline.alpha,
        ]
        : [0, 0, 0, 0];
}

/** Not a no-op: a zero-extent frame zeroes `inSquare`, so the window reads as fully transparent. */
export function isPaintableFrame(frame) {
    return Boolean(frame) && frame.width > 0 && frame.height > 0;
}

/** Target allocation, else the window actor: a container can read 0 while its child paints. */
export function resolveClipSize(targetSize, windowActorSize) {
    if (isPaintableFrame(targetSize))
        return {width: targetSize.width, height: targetSize.height};
    if (isPaintableFrame(windowActorSize))
        return {width: windowActorSize.width, height: windowActorSize.height};
    return null;
}

/** One logical pixel: above the `buffer / scale` residue, below the whole-pixel defects. */
export const BODY_SETTLE_TOLERANCE = 1.0;

/** Integer rects, so `!==` is a whole-pixel test; an unreadable size on either side is no move. */
export function windowResizedSince(windowSize, previousWindowSize) {
    if (!isPaintableFrame(windowSize) || !isPaintableFrame(previousWindowSize))
        return false;
    return windowSize.width !== previousWindowSize.width ||
        windowSize.height !== previousWindowSize.height;
}

/** Mid-resize the actor leads and the container trails, so the preference flips. */
export function resolveBodyAuthority(targetSize, windowActorSize, resizeInFlight) {
    if (!resizeInFlight)
        return resolveClipSize(targetSize, windowActorSize);
    if (isPaintableFrame(windowActorSize))
        return {width: windowActorSize.width, height: windowActorSize.height};
    if (isPaintableFrame(targetSize))
        return {width: targetSize.width, height: targetSize.height};
    return null;
}

/** A disagreement gives up after INVARIANT_STRIKES unconfirmed passes instead of holding on. */
export function settleClipBody(targetSize, windowActorSize, previousBody = null,
    previousAuthority = null, windowSize = null, previousWindowSize = null,
    tolerance = BODY_SETTLE_TOLERANCE, pairDisagreementStrikes = 0) {
    const windowResized = windowResizedSince(windowSize, previousWindowSize);
    const authority = resolveBodyAuthority(targetSize, windowActorSize, windowResized);
    // Deciding and reporting both need the window size now and last pass; without it, blind.
    const windowKnown = isPaintableFrame(windowSize) && isPaintableFrame(previousWindowSize);
    if (!authority)
        return {authority: null, body: null, unsettled: false, pairDisagreementStrikes: 0, windowKnown};
    // Not a disagreement: a target with no extent is handled by the window actor by construction.
    if (!isPaintableFrame(targetSize) || !isPaintableFrame(windowActorSize))
        return {authority, body: authority, unsettled: false, pairDisagreementStrikes: 0, windowKnown};
    // Strictly greater: exactly the tolerance is agreement, the same boundary the warning uses.
    const pairDisagrees =
        Math.abs(targetSize.width - windowActorSize.width) > tolerance ||
        Math.abs(targetSize.height - windowActorSize.height) > tolerance;
    // Inclusive: between-pass residue stays under it; only a whole-pixel move crosses the line.
    const bodyMoved = isPaintableFrame(previousAuthority) &&
        (Math.abs(authority.width - previousAuthority.width) >= tolerance ||
         Math.abs(authority.height - previousAuthority.height) >= tolerance);
    // Unknown size counts as moved here: it vetoes the hold, and a frozen cut is worst mid-drag.
    const windowMoved = !windowKnown ||
        Math.abs(windowSize.width - previousWindowSize.width) >= tolerance ||
        Math.abs(windowSize.height - previousWindowSize.height) >= tolerance;

    // A resize explains the disagreement: trust the actor. Else the confirmed read, else a strike.
    if (pairDisagrees && !windowResized) {
        const targetMatches = windowKnown &&
            Math.abs(targetSize.width - windowSize.width) <= tolerance &&
            Math.abs(targetSize.height - windowSize.height) <= tolerance;
        const actorMatches = windowKnown &&
            Math.abs(windowActorSize.width - windowSize.width) <= tolerance &&
            Math.abs(windowActorSize.height - windowSize.height) <= tolerance;
        if (targetMatches !== actorMatches) {
            return {
                authority,
                body: targetMatches ? targetSize : windowActorSize,
                unsettled: false,
                pairDisagreementStrikes: 0,
                windowKnown,
            };
        }
        const strikes = pairDisagreementStrikes + 1;
        if (strikes >= INVARIANT_STRIKES) {
            return {
                authority,
                body: windowActorSize,
                unsettled: false,
                pairDisagreementStrikes: strikes,
                windowKnown,
            };
        }
        return {
            authority,
            body: isPaintableFrame(previousBody) ? {...previousBody} : authority,
            unsettled: true,
            pairDisagreementStrikes: strikes,
            windowKnown,
        };
    }

    const unsettled = bodyMoved && !windowMoved;
    if (!unsettled)
        return {authority, body: authority, unsettled: false, pairDisagreementStrikes: 0, windowKnown};
    return {
        authority,
        body: isPaintableFrame(previousBody) ? {...previousBody} : authority,
        unsettled: true,
        pairDisagreementStrikes: 0,
        windowKnown,
    };
}

/** Body one paint acts on: settle's rules, reads live at paint, previous values from the pass. */
export function resolvePaintBody(targetSize, windowActorSize, windowSize, plan = null) {
    return settleClipBody(targetSize, windowActorSize,
        plan?.previousBody ?? null, plan?.previousAuthority ?? null,
        windowSize, plan?.previousWindowSize ?? null,
        plan?.tolerance ?? BODY_SETTLE_TOLERANCE,
        plan?.pairDisagreementStrikes ?? 0);
}

function sameInsets(a, b) {
    return Boolean(a) && Boolean(b) &&
        a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

function sameVector(a, b) {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/** Empty and null both mean no candidates, and a changed set must re-run the paint's pick. */
function sameCandidates(a, b) {
    const left = a ?? [];
    const right = b ?? [];
    return left.length === right.length && left.every((value, i) => value === right[i]);
}

/** Diffs what setParams() stores; `frame: true` invalidates the cached frame, not an upload. */
export function clipParamChanges(prev, next) {
    const scaleValid = typeof next.scale === 'number' && next.scale > 0 && Number.isFinite(next.scale);
    const scaleChanged = scaleValid && (!prev || prev.scale !== next.scale);

    const nextCandidates = Array.isArray(next.candidates) && next.candidates.length
        ? next.candidates : null;
    const candidatesChanged = !prev || !sameCandidates(prev.candidates ?? null, nextCandidates);

    const insetsChanged = !prev || !sameInsets(prev.insets, next.insets);
    const radiusChanged = !prev || prev.radius !== next.radius;

    const nextOutline = outlineVector(next.outline);
    const outlineChanged = !prev || !prev.outline || !sameVector(prev.outline, nextOutline);

    const nextErase = Boolean(next.erase);
    const nextClearStroke = Boolean(next.clearStroke);
    const eraseChanged = !prev || prev.erase !== nextErase;
    const clearStrokeChanged = !prev || prev.clearStroke !== nextClearStroke;

    const changed = insetsChanged || radiusChanged || outlineChanged ||
        eraseChanged || clearStrokeChanged || scaleChanged || candidatesChanged;

    return {
        changed,
        scale: scaleChanged ? next.scale : undefined,
        candidates: candidatesChanged ? nextCandidates : undefined,
        radius: radiusChanged ? next.radius : undefined,
        outline: outlineChanged ? nextOutline : undefined,
        erase: eraseChanged ? nextErase : undefined,
        clearStroke: clearStrokeChanged ? nextClearStroke : undefined,
        frame: insetsChanged || undefined,
    };
}

/** Diffs the paint-time geometry caches; `next.frame` is reused from the snap, not copied. */
export function clipGeometryChanges(prev, next) {
    const changes = {};
    if (!prev || prev.scale !== next.scale)
        changes.scale = next.scale;
    if (!prev || prev.width !== next.width || prev.height !== next.height)
        changes.size = [next.width, next.height];
    const frame = next.frame;
    const previous = prev?.frame;
    if (!previous || previous.x !== frame.x || previous.y !== frame.y ||
        previous.width !== frame.width || previous.height !== frame.height)
        changes.frame = [frame.x, frame.y, frame.width, frame.height];
    return changes;
}
