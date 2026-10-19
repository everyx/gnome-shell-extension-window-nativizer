/**
 * Pure uniform-upload decisions for RoundedClipEffect: the effect hands over the previous and next
 * values, this module decides what changed, and the effect only performs the uploads. The diff is
 * arithmetic that used to live inside a Cogl/Clutter class, where no unit test could reach it.
 */

import {INVARIANT_STRIKES} from '../lib/diagnosticInvariants.js';

/**
 * Normalizes an outline to the shader's vec4. `null` means "no outline", which the shader
 * reads as alpha 0.
 */
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

/**
 * Whether a derived body frame can be painted. A frame with a non-positive extent has no body, and
 * compositing it is not a no-op: the shader's `inSquare` is 0 everywhere, so the window reads as fully
 * transparent while its shadow sibling keeps drawing. The caller suspends the clip instead.
 */
export function isPaintableFrame(frame) {
    return Boolean(frame) && frame.width > 0 && frame.height > 0;
}

/**
 * The size the clip derives its frame from: the target's own allocation, falling back to the window
 * actor when that read is not positive - a Wayland container's allocation can read 0 while its surface
 * child still paints at full size - or null when neither has an extent, which suspends the clip.
 */
export function resolveClipSize(targetSize, windowActorSize) {
    if (isPaintableFrame(targetSize))
        return {width: targetSize.width, height: targetSize.height};
    if (isPaintableFrame(windowActorSize))
        return {width: windowActorSize.width, height: windowActorSize.height};
    return null;
}

/**
 * How far the clip target's read and the window actor may differ before the body is unsettled: one
 * logical pixel, which sits above the fractional-scale residue between `buffer / scale` and an integer
 * allocation, and below the whole-pixel defects this separates. The settle and the authority warning
 * share it.
 */
export const BODY_SETTLE_TOLERANCE = 1.0;

/**
 * Whether the window's own size moved since the previous pass, i.e. a resize is in flight. The read is an
 * integer rectangle, so `!==` draws the same boundary a one-pixel tolerance would. An unknown size on
 * either side is not a resize: a failed read is no evidence of movement.
 */
export function windowResizedSince(windowSize, previousWindowSize) {
    if (!isPaintableFrame(windowSize) || !isPaintableFrame(previousWindowSize))
        return false;
    return windowSize.width !== previousWindowSize.width ||
        windowSize.height !== previousWindowSize.height;
}

/**
 * The body authority for a pass: the read the clip's cut and the shadow's cast must follow. The clip
 * target's read wins in steady state, the window actor is its fallback; while a resize is in flight
 * the preference flips, because the actor takes its new size first and the container trails by a
 * frame or two.
 */
export function resolveBodyAuthority(targetSize, windowActorSize, resizeInFlight) {
    if (!resizeInFlight)
        return resolveClipSize(targetSize, windowActorSize);
    if (isPaintableFrame(windowActorSize))
        return {width: windowActorSize.width, height: windowActorSize.height};
    if (isPaintableFrame(targetSize))
        return {width: targetSize.width, height: targetSize.height};
    return null;
}

/**
 * The body the clip and the shadow should act on. A pair disagreement resolves to the read the
 * window's own size confirms; after `INVARIANT_STRIKES` passes with no confirmation it falls
 * back to the window actor instead of holding forever. A body that moved between passes with
 * the window's own size standing still is held for that pass.
 */
export function settleClipBody(targetSize, windowActorSize, previousBody = null,
    previousAuthority = null, windowSize = null, previousWindowSize = null,
    tolerance = BODY_SETTLE_TOLERANCE, pairDisagreementStrikes = 0) {
    const windowResized = windowResizedSince(windowSize, previousWindowSize);
    const authority = resolveBodyAuthority(targetSize, windowActorSize, windowResized);
    if (!authority)
        return {authority: null, body: null, unsettled: false, pairDisagreementStrikes: 0};
    // The fallback path is not a disagreement: a target with no extent is handled by the window
    // actor by construction, and the actor is the authority for whether the window has a body.
    if (!isPaintableFrame(targetSize) || !isPaintableFrame(windowActorSize))
        return {authority, body: authority, unsettled: false, pairDisagreementStrikes: 0};
    // Strictly greater: a difference of exactly the tolerance is agreement, the same boundary the warning
    // uses. Both sides are compared raw, because they name the same rectangle - Mutter sizes the actor from
    // the buffer rect and the target is adopted only when it matches - so a declared ring widens both or
    // neither.
    const pairDisagrees =
        Math.abs(targetSize.width - windowActorSize.width) > tolerance ||
        Math.abs(targetSize.height - windowActorSize.height) > tolerance;
    // Between passes the body's normal residue (`buffer / scale` on a fractional monitor) is below
    // the tolerance and a whole-pixel move is the defect, so this boundary is inclusive.
    const bodyMoved = isPaintableFrame(previousAuthority) &&
        (Math.abs(authority.width - previousAuthority.width) >= tolerance ||
         Math.abs(authority.height - previousAuthority.height) >= tolerance);
    // An unknown window size counts as moved here, deliberately: `windowResizedSince` reads it as "not a
    // resize" because there it only picks the authority. Here it vetoes the hold, and vetoing freezes the
    // cut - an unreadable size is a drag, where a frame of lag shows most.
    const windowKnown = isPaintableFrame(windowSize) && isPaintableFrame(previousWindowSize);
    const windowMoved = !windowKnown ||
        Math.abs(windowSize.width - previousWindowSize.width) >= tolerance ||
        Math.abs(windowSize.height - previousWindowSize.height) >= tolerance;

    // A resize in flight already explains a pair disagreement: the container trails the actor, so
    // the actor is trusted and there is nothing to hold. Otherwise the window's own size picks the
    // read it confirms, and a disagreement no read confirms is bounded by the strike count below.
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
            };
        }
        const strikes = pairDisagreementStrikes + 1;
        if (strikes >= INVARIANT_STRIKES) {
            return {
                authority,
                body: windowActorSize,
                unsettled: false,
                pairDisagreementStrikes: strikes,
            };
        }
        return {
            authority,
            body: isPaintableFrame(previousBody) ? {...previousBody} : authority,
            unsettled: true,
            pairDisagreementStrikes: strikes,
        };
    }

    // The between-pass hold is unchanged: `windowMoved` vetoes it as before.
    const unsettled = bodyMoved && !windowMoved;
    if (!unsettled)
        return {authority, body: authority, unsettled: false, pairDisagreementStrikes: 0};
    return {
        authority,
        body: isPaintableFrame(previousBody) ? {...previousBody} : authority,
        unsettled: true,
        pairDisagreementStrikes: 0,
    };
}

/**
 * The body one paint (or the shadow's matching relayout) acts on, resolved from live actor reads and the
 * pass's plan. The settle rules are `settleClipBody`'s; what this adds is their clock: the reads are live
 * at paint, while the previous values stay on the pass clock.
 */
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

/**
 * Whether two candidate scale sets hold the same scales. An empty set and a null one are the same
 * answer - no candidates - and a pass that changes only the set has to re-run the paint's pick.
 */
function sameCandidates(a, b) {
    const left = a ?? [];
    const right = b ?? [];
    return left.length === right.length && left.every((value, i) => value === right[i]);
}

/**
 * Diffs the styling decisions `setParams()` stores and uploads. `prev` is the cached state, or null when
 * nothing is cached. A returned `frame: true` is not an upload: it invalidates the cached frame, because
 * the insets moved the body the next paint recomputes from.
 */
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

/**
 * Diffs the paint-time geometry caches.
 *
 * The effect compares the actor's live size and the frame it snapped from it against the
 * last values it uploaded. `next.frame` is reused from the snap, not copied.
 *
 * @param prev - {scale, width, height, frame:{x,y,width,height}}
 * @param next - {scale, width, height, frame}
 */
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
