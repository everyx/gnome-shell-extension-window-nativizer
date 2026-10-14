/**
 * RoundedClipEffect upload-decision unit tests (jasmine-gjs).
 * Run: pnpm test
 */

import {BODY_SETTLE_TOLERANCE, clipGeometryChanges, clipParamChanges, outlineVector, resolveBodyAuthority, resolveClipSize, resolvePaintBody, settleClipBody, windowResizedSince} from '../src/effects/clipParams.js';

const insets = (left, top, right, bottom) => ({left, top, right, bottom});

/** @returns {object} A cached params state built from raw setParams arguments */
function state({inset = insets(0, 0, 0, 0), radius = 8, outline = null,
    erase = false, clearStroke = false, scale = 1.0} = {}) {
    return {
        insets: inset,
        radius,
        outline: outlineVector(outline),
        erase,
        clearStroke,
        scale,
    };
}

/** @returns {object} A setParams call payload */
function params({inset = insets(0, 0, 0, 0), radius = 8, outline = null,
    erase = false, clearStroke = false, scale = 1.0} = {}) {
    return {insets: inset, radius, outline, erase, clearStroke, scale};
}

describe('clipParamChanges', () => {
    it('changes nothing for an identical call, so setParams does not repaint', () => {
        const changes = clipParamChanges(state(), params());
        expect(changes.changed).toBe(false);
        expect(changes.scale).toBeUndefined();
        expect(changes.radius).toBeUndefined();
        expect(changes.outline).toBeUndefined();
        expect(changes.erase).toBeUndefined();
        expect(changes.clearStroke).toBeUndefined();
        expect(changes.frame).toBeUndefined();
    });

    it('reports only the radius when the radius moves', () => {
        const changes = clipParamChanges(state({radius: 8}), params({radius: 12}));
        expect(changes.changed).toBe(true);
        expect(changes.radius).toBe(12);
        expect(changes.scale).toBeUndefined();
        expect(changes.outline).toBeUndefined();
        expect(changes.erase).toBeUndefined();
        expect(changes.clearStroke).toBeUndefined();
        expect(changes.frame).toBeUndefined();
    });

    it('invalidates the cached frame when the insets move', () => {
        const changes = clipParamChanges(state(), params({inset: insets(1, 2, 3, 4)}));
        expect(changes.changed).toBe(true);
        expect(changes.frame).toBe(true);
        expect(changes.radius).toBeUndefined();
        expect(changes.scale).toBeUndefined();
    });

    it('reports every decision from a null previous', () => {
        const changes = clipParamChanges(null, params({
            inset: insets(1, 2, 3, 4), radius: 14, outline: {color: [255, 0, 0], alpha: 0.5},
            erase: true, clearStroke: true, scale: 2,
        }));
        expect(changes.changed).toBe(true);
        expect(changes.scale).toBe(2);
        expect(changes.radius).toBe(14);
        expect(changes.outline).toEqual([1, 0, 0, 0.5]);
        expect(changes.erase).toBe(true);
        expect(changes.clearStroke).toBe(true);
        expect(changes.frame).toBe(true);
    });

    it('normalizes an outline against the cached vec4, not the raw object', () => {
        const cached = state({outline: {color: [255, 128, 0], alpha: 0.25}});
        expect(cached.outline).toEqual([1, 128 / 255, 0, 0.25]);
        expect(clipParamChanges(cached, params({outline: {color: [1, 128 / 255, 0], alpha: 0.25}})).outline)
            .toBeUndefined();
        expect(clipParamChanges(cached, params({outline: {color: [1, 0.5, 0], alpha: 0.25}})).outline)
            .toEqual([1, 0.5, 0, 0.25]);
    });

    it('leaves an invalid scale out of the decisions', () => {
        expect(clipParamChanges(state({scale: 1}), params({scale: 0})).changed).toBe(false);
        expect(clipParamChanges(state({scale: 1}), params({scale: Number.NaN})).changed).toBe(false);
    });
});

describe('resolveClipSize', () => {
    it('prefers the target read while it is usable', () => {
        expect(resolveClipSize({width: 825, height: 960}, {width: 825, height: 960}))
            .toEqual({width: 825, height: 960});
        expect(resolveClipSize({width: 800, height: 600}, {width: 825, height: 960}))
            .toEqual({width: 800, height: 600});
    });

    it('falls back to the window actor when the target read is not usable', () => {
        // The Wayland surface container at 0x0 while the window actor is healthy: the container's
        // surface child still paints at full size, so the window actor is the authority.
        expect(resolveClipSize({width: 0, height: 0}, {width: 825, height: 960}))
            .toEqual({width: 825, height: 960});
        expect(resolveClipSize({width: 0, height: 960}, {width: 825, height: 960}))
            .toEqual({width: 825, height: 960});
        expect(resolveClipSize({width: 825, height: -1}, {width: 825, height: 960}))
            .toEqual({width: 825, height: 960});
    });

    it('is degenerate only when neither the target nor the window actor has an extent', () => {
        expect(resolveClipSize({width: 0, height: 0}, {width: 0, height: 0})).toBeNull();
        expect(resolveClipSize(null, null)).toBeNull();
        expect(resolveClipSize({width: 0, height: 0}, undefined)).toBeNull();
    });

    it('holds one verdict across successive paints for a healthy window, whatever the target reads', () => {
        const windowActor = {width: 825, height: 960};
        // The container's allocation read flaps 0 -> real -> 0 across paints (a buffer swap while
        // opening, a lagging layout during a drag). The resolved size must not follow the unusable
        // reads, so the clip neither suspends nor re-enables per paint.
        for (const targetRead of [0, 825, 0, 0, 825]) {
            const size = resolveClipSize(
                {width: targetRead, height: targetRead ? 960 : 0}, windowActor);
            expect(size).withContext(`target read ${targetRead}`).toEqual({width: 825, height: 960});
        }
    });
});

describe('windowResizedSince (is a resize in flight)', () => {
    it('reports a moved window size and not a standing one', () => {
        expect(windowResizedSince({width: 802, height: 600}, {width: 800, height: 600})).toBeTrue();
        expect(windowResizedSince({width: 800, height: 602}, {width: 800, height: 600})).toBeTrue();
        expect(windowResizedSince({width: 800, height: 600}, {width: 800, height: 600})).toBeFalse();
    });

    it('treats an unknown size on either side as not a resize', () => {
        // With no previous pass there is nothing to compare, and a failed read is not movement.
        expect(windowResizedSince({width: 800, height: 600}, null)).toBeFalse();
        expect(windowResizedSince(null, {width: 800, height: 600})).toBeFalse();
        expect(windowResizedSince({width: 0, height: 0}, {width: 800, height: 600})).toBeFalse();
    });
});

describe('resolveBodyAuthority (resize-aware body authority)', () => {
    it('keeps the target preference in steady state', () => {
        expect(resolveBodyAuthority({width: 800, height: 600}, {width: 825, height: 960}, false))
            .toEqual({width: 800, height: 600});
    });

    it('prefers the window actor while a resize is in flight', () => {
        // The container trails the actor by 2px; the actor is the fresh read the cut must follow.
        expect(resolveBodyAuthority({width: 798, height: 600}, {width: 800, height: 600}, true))
            .toEqual({width: 800, height: 600});
    });

    it('falls back to the other read when the preferred one has no extent', () => {
        expect(resolveBodyAuthority({width: 800, height: 600}, {width: 0, height: 0}, true))
            .toEqual({width: 800, height: 600});
        expect(resolveBodyAuthority({width: 0, height: 0}, {width: 800, height: 600}, false))
            .toEqual({width: 800, height: 600});
        expect(resolveBodyAuthority({width: 0, height: 0}, {width: 0, height: 0}, true)).toBeNull();
    });
});

describe('settleClipBody (do not act on an unsettled target/actor pair)', () => {
    it('acts on the fresh body when the target and the window actor agree', () => {
        const settled = settleClipBody({width: 400, height: 300}, {width: 400, height: 300}, null);
        expect(settled.authority).toEqual({width: 400, height: 300});
        expect(settled.body).toEqual({width: 400, height: 300});
        expect(settled.unsettled).toBeFalse();
    });

    it('holds the previous body while the two disagree, and re-arms when they agree', () => {
        const previous = {width: 402, height: 300};
        const held = settleClipBody({width: 400, height: 300}, {width: 402, height: 300}, previous);
        expect(held.unsettled).toBeTrue();
        expect(held.body).toEqual(previous);
        // The fresh read is still named, so the shadow can warn on it while the cut stays put.
        expect(held.authority).toEqual({width: 400, height: 300});

        // The two reads agree again: the fresh body is acted on at once - no latch to the held one.
        const restored = settleClipBody({width: 404, height: 300}, {width: 404, height: 300}, held.body);
        expect(restored.unsettled).toBeFalse();
        expect(restored.body).toEqual({width: 404, height: 300});
    });

    it('is silent for a sub-pixel difference and uses the target read', () => {
        // `buffer / scale` on a fractional monitor leaves this residue by construction. 0.8px is
        // below the settle tolerance and above the old 0.5px body tolerance.
        const settled = settleClipBody({width: 400.8, height: 300}, {width: 400, height: 300}, null);
        expect(settled.unsettled).toBeFalse();
        expect(settled.body).toEqual({width: 400.8, height: 300});
    });

    it('treats a degenerate target read as the documented fallback, not a disagreement', () => {
        const settled = settleClipBody({width: 0, height: 0}, {width: 400, height: 300}, null);
        expect(settled.unsettled).toBeFalse();
        expect(settled.body).toEqual({width: 400, height: 300});
    });

    it('treats a difference of exactly the tolerance as agreement, as the warning does', () => {
        const atTolerance = settleClipBody(
            {width: 400 + BODY_SETTLE_TOLERANCE, height: 300}, {width: 400, height: 300},
            {width: 402, height: 300});
        expect(atTolerance.unsettled).toBeFalse();
        expect(atTolerance.body).toEqual({width: 400 + BODY_SETTLE_TOLERANCE, height: 300});
    });

    it('holds the previous body once the difference passes the tolerance', () => {
        const past = settleClipBody(
            {width: 400 + BODY_SETTLE_TOLERANCE + 0.01, height: 300}, {width: 400, height: 300},
            {width: 402, height: 300});
        expect(past.unsettled).toBeTrue();
        expect(past.body).toEqual({width: 402, height: 300});
    });

    // A window that declares a ring: the surface container is the client's surface, so its box is
    // wider than the frame by the declared margins. Comparing the raw reads called that a permanent
    // disagreement (the journal showed 44 px on a 22 px-per-side window) and froze the body.
    it('compares target and actor as bodies when the client declares a ring', () => {
        const insets = {left: 22, top: 22, right: 22, bottom: 22};
        const actor = {width: 800, height: 600};
        const target = {width: 800 + 44, height: 600 + 44};
        const settled = settleClipBody(target, actor, null, null, null, null,
            BODY_SETTLE_TOLERANCE, insets, insets);
        expect(settled.unsettled).toBeFalse();
        expect(settled.body).toEqual(target);
    });

    // A flat window: target and actor agree, and the 1 px safe inset trims inside the actor, so that
    // trim must not read as a disagreement either.
    it('does not read our own flat safe inset as a disagreement', () => {
        const insets = {left: 1, top: 1, right: 1, bottom: 1};
        const declared = {left: 0, top: 0, right: 0, bottom: 0};
        const settled = settleClipBody({width: 800, height: 600}, {width: 800, height: 600},
            null, null, null, null, BODY_SETTLE_TOLERANCE, insets, declared);
        expect(settled.unsettled).toBeFalse();
    });

    it('holds the previous body when it moves between passes and the window size stands still', () => {
        // The focus hand-off: the target and the window actor trail together by a whole pixel, so
        // the pair comparison sees agreement, while the window's own frame has not changed. The
        // body's movement since the previous pass is the tell, and both cuts keep the old body.
        const held = settleClipBody({width: 798, height: 600}, {width: 798, height: 600},
            {width: 800, height: 600}, {width: 800, height: 600},
            {width: 800, height: 600}, {width: 800, height: 600});
        expect(held.unsettled).toBeTrue();
        expect(held.body).toEqual({width: 800, height: 600});
        // The fresh authority is still named, so the body-authority warning can report it.
        expect(held.authority).toEqual({width: 798, height: 600});
    });

    it('uses the new body when the window resized with it', () => {
        // The precondition is the focus-hand-off hold; the resize then moves the body and the
        // window's own frame together, so the new body is real and must be used.
        const held = settleClipBody({width: 798, height: 600}, {width: 798, height: 600},
            {width: 800, height: 600}, {width: 800, height: 600},
            {width: 800, height: 600}, {width: 800, height: 600});
        expect(held.unsettled).toBeTrue();
        const fresh = settleClipBody({width: 700, height: 600}, {width: 700, height: 600},
            held.body, held.authority, {width: 700, height: 600}, {width: 800, height: 600});
        expect(fresh.unsettled).toBeFalse();
        expect(fresh.body).toEqual({width: 700, height: 600});
    });

    it('follows the window actor while a resize is in flight and the container lags', () => {
        // The interactive-resize case: the window actor has taken the new, larger size and the
        // surface container's allocation trails it by a frame, so the pair differs by 2px. The
        // window's own size moved with the actor, which says the actor is the fresh read; the cut
        // must track the frame the user is dragging, not the older, smaller container box. The
        // lagging pair is expected here, so it is not held.
        const resized = settleClipBody({width: 798, height: 600}, {width: 800, height: 600},
            {width: 796, height: 600}, {width: 798, height: 600},
            {width: 800, height: 600}, {width: 798, height: 600});
        expect(resized.unsettled).toBeFalse();
        expect(resized.authority).toEqual({width: 800, height: 600});
        expect(resized.body).toEqual({width: 800, height: 600});
    });

    it('keeps the container authority in steady state when the window did not resize', () => {
        // The same 2px disagreement with the window's own size standing still is the focus
        // hand-off: there is no fresh read to trust, so the authority stays the container and the
        // body is held rather than following the window actor. The new branch must not leak here.
        const held = settleClipBody({width: 798, height: 600}, {width: 800, height: 600},
            {width: 798, height: 600}, {width: 798, height: 600},
            {width: 800, height: 600}, {width: 800, height: 600});
        expect(held.unsettled).toBeTrue();
        expect(held.authority).toEqual({width: 798, height: 600});
        expect(held.body).toEqual({width: 798, height: 600});
    });

    it('does not hold a body change below the tolerance', () => {
        // Precondition: a whole-pixel move from 799.5 to 798 is held.
        const held = settleClipBody({width: 798, height: 600}, {width: 798, height: 600},
            {width: 800, height: 600}, {width: 799.5, height: 600},
            {width: 800, height: 600}, {width: 800, height: 600});
        expect(held.unsettled).toBeTrue();
        // A sub-pixel move from the held authority is the normal residue, not a hold.
        const normal = settleClipBody({width: 798.5, height: 600}, {width: 798.5, height: 600},
            held.body, held.authority, {width: 800, height: 600}, {width: 800, height: 600});
        expect(normal.unsettled).toBeFalse();
        expect(normal.body).toEqual({width: 798.5, height: 600});
    });

    it('treats a between-pass move of exactly the tolerance as movement', () => {
        const at = settleClipBody({width: 799, height: 600}, {width: 799, height: 600},
            {width: 800, height: 600}, {width: 800, height: 600},
            {width: 800, height: 600}, {width: 800, height: 600});
        expect(at.unsettled).toBeTrue();
        expect(at.body).toEqual({width: 800, height: 600});
    });

    it('does not latch: the hold clears once the body authority stops moving', () => {
        // The focus hand-off pass holds the previous body...
        const held = settleClipBody({width: 798, height: 600}, {width: 798, height: 600},
            {width: 800, height: 600}, {width: 800, height: 600},
            {width: 800, height: 600}, {width: 800, height: 600});
        expect(held.unsettled).toBeTrue();
        // ...and the very next pass acts on the fresh body, even though it still differs from the
        // held one: the authority no longer moved since the previous pass.
        const restored = settleClipBody({width: 798, height: 600}, {width: 798, height: 600},
            held.body, held.authority, {width: 800, height: 600}, {width: 800, height: 600});
        expect(restored.unsettled).toBeFalse();
        expect(restored.body).toEqual({width: 798, height: 600});
    });
});

describe('resolvePaintBody (the paint clock)', () => {
    const size = (width, height = 600) => ({width, height});
    // The plan the decoration hands for a pass: the reference points and the window's own size as
    // of the previous pass. The current window size is the third argument, read live at paint.
    const plan = ({
        previousBody = size(800), previousAuthority = size(800),
        previousWindowSize = size(800),
    } = {}) => ({previousBody, previousAuthority, previousWindowSize});

    it('tracks the live window actor at every paint while a drag is in flight', () => {
        // The manager resolves once per debounced pass, so the plan is fixed with the reference
        // points from before; the window's own size and the actor grow every paint while the target
        // (surface container) trails. The body must follow the live actor, not freeze at the pass.
        const p = plan();
        const actorReads = [802, 804, 806, 808, 810];
        const containerReads = [800, 802, 804, 806, 808];
        for (let i = 0; i < actorReads.length; i++) {
            const settled = resolvePaintBody(size(containerReads[i]), size(actorReads[i]),
                size(actorReads[i]), p);
            expect(settled.body).withContext(`paint ${i}: actor ${actorReads[i]}, container ${containerReads[i]}`)
                .toEqual(size(actorReads[i]));
            expect(settled.unsettled).withContext(`paint ${i}`).toBeFalse();
        }
    });

    it('sees a resize on the first paint, before any pass has recorded it', () => {
        // The drag starts between two passes: the plan still carries the resting window size, but
        // the live window size has moved. The pair disagreement is then a resize, not an unsettled
        // read, so the actor is followed instead of holding the resting body.
        const p = plan({previousWindowSize: size(800)});
        const settled = resolvePaintBody(size(900), size(901), size(901), p);
        expect(settled.authority).toEqual(size(901));
        expect(settled.body).toEqual(size(901));
        expect(settled.unsettled).toBeFalse();
    });

    it('holds the previous body on an unsettled pair while the window size stands still', () => {
        const settled = resolvePaintBody(size(798), size(800), size(800), plan());
        expect(settled.authority).toEqual(size(798));
        expect(settled.body).toEqual(size(800));
        expect(settled.unsettled).toBeTrue();
    });

    it('holds the previous body when it moves between passes with the window size unchanged', () => {
        // The focus hand-off: the target and the actor trail together, so the pair agrees while
        // the body moved since the previous pass. The window's own size is the independent tell:
        // it is still the previous one, so the fresh pair is stale and the body is held.
        const settled = resolvePaintBody(size(798), size(798), size(800), plan());
        expect(settled.authority).toEqual(size(798));
        expect(settled.body).toEqual(size(800));
        expect(settled.unsettled).toBeTrue();
    });

    it('is unchanged in steady state', () => {
        const settled = resolvePaintBody(size(800), size(800), size(800), plan());
        expect(settled.authority).toEqual(size(800));
        expect(settled.body).toEqual(size(800));
        expect(settled.unsettled).toBeFalse();
    });

    it('does not latch: once the authority stops moving the next paint uses the fresh body', () => {
        // The focus hand-off holds 800 against a 798 authority. The next pass carries that 798 as
        // the previous authority, so the fresh body is acted on rather than held forever.
        const held = resolvePaintBody(size(798), size(798), size(800), plan());
        expect(held.body).toEqual(size(800));
        const restored = resolvePaintBody(size(798), size(798), size(800),
            plan({previousBody: held.body, previousAuthority: held.authority}));
        expect(restored.body).toEqual(size(798));
        expect(restored.unsettled).toBeFalse();
    });

    it('treats a null plan as an unknown previous read, like the first pass', () => {
        const settled = resolvePaintBody(size(400), size(400), size(400), null);
        expect(settled.body).toEqual(size(400));
        expect(settled.unsettled).toBeFalse();
    });
});

describe('clipGeometryChanges', () => {
    const frame = (x, y, width, height) => ({x, y, width, height});

    it('reports nothing when the size and frame are unchanged', () => {
        const prev = {scale: 1, width: 800, height: 600, frame: frame(0, 0, 800, 600)};
        expect(clipGeometryChanges(prev, {scale: 1, width: 800, height: 600, frame: frame(0, 0, 800, 600)}))
            .toEqual({});
    });

    it('reports the frame alone when an inset invalidation changed its width', () => {
        const prev = {scale: 1, width: 800, height: 600, frame: frame(0, 0, -1, 600)};
        const changes = clipGeometryChanges(prev, {scale: 1, width: 800, height: 600, frame: frame(0, 0, 780, 600)});
        expect(changes.frame).toEqual([0, 0, 780, 600]);
        expect(changes.scale).toBeUndefined();
        expect(changes.size).toBeUndefined();
    });

    it('reports scale and size independently of the frame', () => {
        const prev = {scale: 1, width: 800, height: 600, frame: frame(0, 0, 800, 600)};
        const changes = clipGeometryChanges(prev, {scale: 2, width: 810, height: 600, frame: frame(0, 0, 800, 600)});
        expect(changes.scale).toBe(2);
        expect(changes.size).toEqual([810, 600]);
        expect(changes.frame).toBeUndefined();
    });
});
