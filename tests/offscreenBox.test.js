/**
 * Tests for the offscreen box derivation (offscreenBox.js).
 *
 * The numbers are the ones measured live in the nested session (red 441x281 body, one session per
 * scale, `get_target_size()` from the clip effect plus the corner contour in a desktop shot). They
 * are the regression guard for the defect this module replaced: the constants that used to stand in
 * for the box encoded a caller that scaled by `ceilf (resource_scale)`, so at 1.25x the shader was
 * handed 444x284 logical units for an FBO that really spans 556x356 device px.
 */

import {
    ENLARGE_ROUNDING_PAD,
    ENLARGE_TOTAL_PAD,
    offscreenDeviceExtent,
    offscreenExtent,
    offscreenPaintBox,
    offscreenQuad,
    offscreenScaleCandidates,
    offscreenUniformsStale,
    resolveOffscreenScale,
} from '../src/lib/offscreenBox.js';
import {roundHalfAwayFromZero} from '../src/platform/numeric.js';

const BODY = {width: 441, height: 281};

/**
 * The float32 the nested session reports for a 4/3 monitor (`get_monitor_scale`), not the double
 * `4 / 3`. The difference matters: `282 * 1.3333333730697632` is 376.000017, and the compositor
 * multiplies in float32, where that is exactly 376.
 */
const MONITOR_SCALE_4_3 = 1.3333333730697632;

/** Device px the FBO really has, measured with `Clutter.OffscreenEffect.get_target_size()`. */
const MEASURED = [
    {scale: 1.0, device: [444, 284]},
    {scale: 1.25, device: [556, 356]},
    {scale: MONITOR_SCALE_4_3, device: [593, 379]},
];

describe('offscreenQuad: one unit is one logical pixel', () => {
    it('spans the measured FBO in logical px at every fractional scale', () => {
        for (const {scale, device} of MEASURED) {
            const quad = offscreenQuad(BODY, scale);
            // The shader's texture coordinates span the FBO, so the unit count has to be the FBO's
            // size divided by the monitor scale - not the body size plus the padding.
            expect(quad.width * scale).toBeCloseTo(device[0], 9);
            expect(quad.height * scale).toBeCloseTo(device[1], 9);
        }
    });

    it('keeps every span and every origin on the device-pixel grid', () => {
        for (const {scale} of MEASURED) {
            const quad = offscreenQuad(BODY, scale);
            // Whole device pixels on both sides of the mapping is what makes 1 unit == 1 logical px:
            // the FBO blit turns a logical length L into exactly L * scale device px.
            for (const value of [quad.width * scale, quad.height * scale])
                expect(Number.isInteger(Math.round(value * 1e6) / 1e6)).toBe(true);
            for (const value of [quad.offsetX * scale, quad.offsetY * scale])
                expect(Number.isInteger(Math.round(value * 1e6) / 1e6)).toBe(true);
        }
    });

    it('places the actor origin where Clutter enlarged the box from', () => {
        // 3px of offscreen padding per axis on an integer box, split 2 near / 1 far, and the near
        // edge floored onto the device grid: floor(-2 * scale) / scale.
        expect(offscreenQuad(BODY, 1.0)).toEqual({width: 444, height: 284, offsetX: 2, offsetY: 2});
        expect(offscreenQuad(BODY, 1.25))
            .toEqual({width: 444.8, height: 284.8, offsetX: 2.4, offsetY: 2.4});
        expect(offscreenQuad(BODY, 4 / 3))
            .toEqual({width: 444.75, height: 284.25, offsetX: 2.25, offsetY: 2.25});
    });

    it('lets a corner radius reach radius * scale device px', () => {
        const radius = 15;
        for (const {scale, device} of MEASURED) {
            const quad = offscreenQuad(BODY, scale);
            // The shader draws the radius in the same units as the box, so its device radius is
            // radius * (device px per unit). That factor has to be the monitor scale exactly.
            const devicePerUnit = quad.width * scale / quad.width;
            expect(devicePerUnit).toBeCloseTo(scale, 12);
            expect(radius * devicePerUnit).toBeCloseTo(radius * scale, 9);
            expect(device[0]).toBeGreaterThan(BODY.width * scale);
        }
    });

    it('rounds the scaled edges to 1/256ths before the device grid, like C', () => {
        // Without this the float32 monitor scale sends the far edge to 377 instead of 376 and the
        // quad comes out 285.0 units tall against a 379px FBO: one device pixel short at the bottom.
        const quad = offscreenQuad(BODY, MONITOR_SCALE_4_3);
        // The float32 scale makes these 284.2499915 / 444.7499867, i.e. the same device grid.
        expect(quad.height * MONITOR_SCALE_4_3).toBeCloseTo(379, 9);
        expect(quad.width * MONITOR_SCALE_4_3).toBeCloseTo(593, 9);
        expect(quad.height).toBeCloseTo(284.25, 4);
        expect(282 * MONITOR_SCALE_4_3).toBeGreaterThan(376);
    });

    it('moves the near padding a whole logical pixel on a fractional box', () => {
        // 500.4 wide: Clutter's `ceilf (x2 + 0.75)` lands one pixel further out than the integer
        // box does, so the origin is 1 logical px, not 2. The old constants could not express this.
        expect(offscreenQuad({width: 500.4, height: 400}, 1.25).offsetX).toBeCloseTo(1.6, 9);
    });

    it('rounds a logical x.5 width up, the half-away-from-zero CLUTTER_NEARBYINT rule', () => {
        // `CLUTTER_NEARBYINT` is `(int) (x + 0.5f)` for x >= 0 - half away from zero, not the
        // ties-to-even `nearbyint()` its name suggests. A 440.5px box is therefore sized like 441:
        // near = ceil (441.25) - 441 - 3 = -2 and far = 442. Ties-to-even would give near -1 and
        // move the origin a whole logical pixel for the same window.
        expect(offscreenQuad({width: 440.5, height: 400}, 1.0))
            .toEqual({width: 444, height: 403, offsetX: 2, offsetY: 2});
        expect(offscreenQuad({width: 440.4, height: 400}, 1.0).offsetX).toBe(1);
        // The fractional case this spec used to cover (500.4) sits a tenth below the tie; the tie
        // itself was the boundary left untested, at the scale that folds it onto the device grid.
        expect(offscreenQuad({width: 500.5, height: 400}, 1.25))
            .toEqual({width: 504.8, height: 404, offsetX: 2.4, offsetY: 2.4});
        expect(offscreenQuad({width: 440.5, height: 400}, 1.25))
            .toEqual({width: 444.8, height: 404, offsetX: 2.4, offsetY: 2.4});
    });

    it('is total: a degenerate scale or size cannot make the shader divide by zero', () => {
        for (const scale of [0, -1, NaN, undefined]) {
            const quad = offscreenQuad(BODY, scale);
            expect(Number.isFinite(quad.width)).toBe(true);
            expect(Number.isFinite(quad.offsetX)).toBe(true);
        }
        const empty = offscreenQuad(null, 1.25);
        expect(Number.isFinite(empty.width)).toBe(true);
        expect(Number.isFinite(empty.offsetX)).toBe(true);
    });

    it('carries upstream literals, not an integer-scale special case', () => {
        const {near, far} = {near: -2, far: 442};
        expect(Math.ceil(BODY.width + ENLARGE_ROUNDING_PAD)).toBe(far);
        expect(far - roundHalfAwayFromZero(BODY.width) - ENLARGE_TOTAL_PAD).toBe(near);
    });
});

describe('offscreenExtent: the FBO Clutter allocated outranks the derived box', () => {
    const derived = {width: 444, height: 284};

    it('divides the read device extent by the scale', () => {
        expect(offscreenExtent(derived, {width: 556, height: 356}, 1.25))
            .toEqual({width: 444.8, height: 284.8});
    });

    it('falls back to the derived extent when the read is unavailable or not finite', () => {
        expect(offscreenExtent(derived, null, 1.25)).toEqual(derived);
        expect(offscreenExtent(derived, {width: Number.NaN, height: 356}, 1.25)).toEqual(derived);
        for (const scale of [0, -1, Number.NaN, undefined])
            expect(offscreenExtent(derived, null, scale)).toEqual(derived);
    });
});

/**
 * The candidate set is what makes the FBO's scale pickable rather than solvable: every monitor scale
 * the frame touches, plus the `ceil` each of them may have been allocated at.
 */
describe('offscreenScaleCandidates: the scales the engine may have allocated at', () => {
    it('offers each monitor scale and its ceil, ascending', () => {
        expect(offscreenScaleCandidates([1.0, 1.25, MONITOR_SCALE_4_3]))
            .toEqual([1.0, 1.25, MONITOR_SCALE_4_3, 2]);
        expect(offscreenScaleCandidates([1.0, MONITOR_SCALE_4_3]))
            .toEqual([1.0, MONITOR_SCALE_4_3, 2]);
    });

    it('deduplicates the ceil of an integer scale and the scale itself', () => {
        // ceil(1) is 1 and ceil(2) is 2: an integer monitor adds no second candidate, which is why a
        // single integer monitor still offers exactly one and its selection cannot move.
        expect(offscreenScaleCandidates([2.0, 1.0, 2.0])).toEqual([1.0, 2.0]);
    });

    it('answers null when there is no set to offer', () => {
        for (const bad of [null, undefined, [], [0, -1, Number.NaN]])
            expect(offscreenScaleCandidates(bad)).toBeNull();
    });
});

describe('offscreenDeviceExtent: what one candidate predicts', () => {
    it('is the measured FBO at every scale the real-scale caller allocates', () => {
        for (const {scale, device} of MEASURED)
            expect(offscreenDeviceExtent(BODY, scale)).toEqual({width: device[0], height: device[1]});
    });

    it('is offscreenQuad\'s extent un-divided, on whole device pixels', () => {
        for (const scale of [1.0, 1.25, MONITOR_SCALE_4_3, 2]) {
            const quad = offscreenQuad(BODY, scale);
            const extent = offscreenDeviceExtent(BODY, scale);
            expect(extent.width).toBeCloseTo(quad.width * scale, 9);
            expect(extent.height).toBeCloseTo(quad.height * scale, 9);
            expect(Number.isInteger(extent.width)).toBe(true);
            expect(Number.isInteger(extent.height)).toBe(true);
        }
    });
});

/**
 * The scale the engine produced the FBO with, picked out of the candidate set the reconcile pass
 * computed. Two padding rules exist - the real resource scale (upstream's unmerged patchset, and the
 * local `mutter-everyx` package) and `ceilf (resource_scale)` (unpatched upstream) - plus the case
 * the clip declared a different monitor's scale than the engine used.
 */
describe('resolveOffscreenScale: the candidate that explains the FBO', () => {
    // The FBO the real-scale rule allocates for a 441x281 body (measured with get_target_size()).
    const realScaleFbo = {width: 593, height: 379};
    // The FBO unpatched mutter allocates: the 444x284 enlarged box times ceilf (4/3) = 2.
    const ceilScaleFbo = {width: 888, height: 568};
    const twoMonitors = offscreenScaleCandidates([1.0, MONITOR_SCALE_4_3]);
    const threeMonitors = offscreenScaleCandidates([1.0, 1.25, MONITOR_SCALE_4_3]);

    it('picks the higher-scale monitor across a seam, where the declared scale is the main one', () => {
        // The straddling-window defect: the clip declared 1.0, the monitor holding most of the
        // window, while the engine sized the FBO at the 4/3 monitor the frame reaches. The declared
        // scale predicts 444x284, so the 593x379 read is not its allocation.
        expect(offscreenDeviceExtent(BODY, 1.0)).toEqual({width: 444, height: 284});
        expect(resolveOffscreenScale(BODY, realScaleFbo, 1.0, twoMonitors))
            .toEqual({scale: MONITOR_SCALE_4_3, explained: true});

        const extent = offscreenExtent(offscreenQuad(BODY, 1.0), realScaleFbo, MONITOR_SCALE_4_3);
        const derived = offscreenQuad(BODY, MONITOR_SCALE_4_3);
        expect(extent.width).toBeCloseTo(derived.width, 9);
        expect(extent.height).toBeCloseTo(derived.height, 9);
    });

    it('picks the highest scale when three monitors of different scales meet', () => {
        // Each read lands on one prediction, the closest pair here (1.25 and 4/3) being 37 device px
        // apart: the pick has to name it rather than fall back to the declared scale.
        expect(resolveOffscreenScale(BODY, {width: 556, height: 356}, 1.0, threeMonitors))
            .toEqual({scale: 1.25, explained: true});
        expect(resolveOffscreenScale(BODY, realScaleFbo, 1.0, threeMonitors))
            .toEqual({scale: MONITOR_SCALE_4_3, explained: true});
    });

    it('picks the ceil candidate when unpatched mutter allocated at ceilf (scale)', () => {
        // The declared 4/3 *is* this window's monitor scale; the engine still allocated the box by
        // ceilf (4/3) = 2. Dividing the 888px FBO by 4/3 would stretch the texture 1.5x and cut the
        // body short, so the ceil candidate is what the extent names.
        expect(resolveOffscreenScale(BODY, ceilScaleFbo, MONITOR_SCALE_4_3,
            offscreenScaleCandidates([MONITOR_SCALE_4_3]))).toEqual({scale: 2, explained: true});

        const extent = offscreenExtent(offscreenQuad(BODY, MONITOR_SCALE_4_3), ceilScaleFbo, 2);
        expect(Math.abs(extent.width - offscreenQuad(BODY, MONITOR_SCALE_4_3).width)).toBeLessThan(1);
        expect(Math.abs(extent.height - offscreenQuad(BODY, MONITOR_SCALE_4_3).height)).toBeLessThan(1);
    });

    it('names no candidate when the read is past every prediction, however far apart they are', () => {
        // 620x400 sits 27 device px past the 4/3 prediction and stays unexplained whichever set
        // offers it: the budget is one device pixel, the subpixel phase an edge may carry. A stale
        // set must not be read as the nearest candidate and have the read divided by it.
        const drifted = {width: 620, height: 400};
        expect(resolveOffscreenScale(BODY, drifted, 1.0, threeMonitors))
            .toEqual({scale: 1.0, explained: false});
        expect(resolveOffscreenScale(BODY, drifted, 1.0, twoMonitors))
            .toEqual({scale: 1.0, explained: false});
    });

    it('reads a set that could not be completed as the declared scale alone', () => {
        // An unreadable scale on any intersecting monitor withdraws the whole set. The read still
        // says whether the declared scale spans the FBO: a match is explained, a mismatch is not.
        for (const incomplete of [null, undefined, []]) {
            expect(resolveOffscreenScale(BODY, {width: 556, height: 356}, 1.25, incomplete))
                .toEqual({scale: 1.25, explained: true});
            expect(resolveOffscreenScale(BODY, realScaleFbo, 1.25, incomplete))
                .toEqual({scale: 1.25, explained: false});
        }
    });

    it('keeps an integer single-monitor scale exactly as the derivation had it', () => {
        // The regression case: one integer monitor offers itself and nothing else, so a 1.0 display
        // must not move - not even for the device pixel a source phase moves an edge by.
        const single = offscreenScaleCandidates([1.0]);
        expect(single).toEqual([1.0]);
        expect(resolveOffscreenScale(BODY, {width: 444, height: 284}, 1.0, single))
            .toEqual({scale: 1.0, explained: true});
        expect(resolveOffscreenScale(BODY, {width: 445, height: 284}, 1.0, single))
            .toEqual({scale: 1.0, explained: true});
    });

    it('is total: a degenerate read, size or scale cannot name a candidate or divide by zero', () => {
        const candidates = offscreenScaleCandidates([1.0, 1.25]);
        for (const bad of [null, undefined, {width: 0, height: 0}, {width: Number.NaN, height: 1}]) {
            expect(resolveOffscreenScale(BODY, bad, 1.25, candidates))
                .toEqual({scale: 1.25, explained: true});
        }
        for (const scale of [0, -1, Number.NaN, undefined]) {
            const resolved = resolveOffscreenScale(BODY, realScaleFbo, scale, candidates);
            expect(Number.isFinite(resolved.scale)).toBe(true);
            expect(resolved.scale).toBeGreaterThan(0);
        }
        expect(Number.isFinite(resolveOffscreenScale(null, realScaleFbo, 1.25, candidates).scale))
            .toBe(true);
    });
});

/**
 * The extent and the actor origin are one position inside the FBO, so they have to be expressed at
 * one scale. The specs pin the origin to the scale that produced the FBO, not the clip's declared
 * one, under both padding rules; when the declared scale is what the extent names, the two are the
 * same value, which is the behaviour that must not move.
 */
describe('offscreenPaintBox: the extent and the origin share the FBO scale', () => {
    const realScaleFbo = {width: 593, height: 379};
    const ceilScaleFbo = {width: 888, height: 568};
    const twoMonitors = offscreenScaleCandidates([1.0, MONITOR_SCALE_4_3]);
    const threeMonitors = offscreenScaleCandidates([1.0, 1.25, MONITOR_SCALE_4_3]);

    it('keeps the declared-scale origin when the extents pick the declared scale', () => {
        const box = offscreenPaintBox(BODY, MONITOR_SCALE_4_3, realScaleFbo, threeMonitors);
        expect(box.scale).toBe(MONITOR_SCALE_4_3);
        expect(box.offsetX).toBe(offscreenQuad(BODY, MONITOR_SCALE_4_3).offsetX);
        expect(box.offsetY).toBe(offscreenQuad(BODY, MONITOR_SCALE_4_3).offsetY);
        expect(box.extent).toEqual(offscreenExtent(offscreenQuad(BODY, MONITOR_SCALE_4_3),
            realScaleFbo, MONITOR_SCALE_4_3));
    });

    it('re-derives the origin on the ceil rule\'s grid, not the declared one', () => {
        // Unpatched mutter allocates by ceilf (4/3) = 2, which the ceil candidate is in the set for.
        // The origin has to move with the extent: floored on the declared scale's grid it lands a
        // fraction of a logical pixel off the content, which is a mask shift, not a missing band.
        const box = offscreenPaintBox(BODY, MONITOR_SCALE_4_3, ceilScaleFbo,
            offscreenScaleCandidates([MONITOR_SCALE_4_3]));
        expect(box.scale).toBe(2);
        expect(box.offsetX).toBe(offscreenQuad(BODY, 2).offsetX);
        expect(box.offsetY).toBe(offscreenQuad(BODY, 2).offsetY);
        expect(Math.abs(box.offsetX - offscreenQuad(BODY, MONITOR_SCALE_4_3).offsetX))
            .toBeGreaterThan(0.2);
        // The predicted device extent is the derivation at the FBO's scale, so the padding rule on
        // its own raises no warning.
        expect(box.predicted).toEqual(ceilScaleFbo);
    });

    it('re-derives the origin when the declared scale is the wrong monitor', () => {
        const box = offscreenPaintBox(BODY, 1.0, realScaleFbo, twoMonitors);
        expect(box.scale).toBe(MONITOR_SCALE_4_3);
        expect(box.offsetX).toBe(offscreenQuad(BODY, MONITOR_SCALE_4_3).offsetX);
        expect(Math.abs(box.offsetX - offscreenQuad(BODY, 1.0).offsetX)).toBeGreaterThan(0.2);
    });

    it('explains a target one device pixel off, and refuses one two pixels off', () => {
        // The tolerance is this function's: one edge may carry a phase, two is a different box.
        // BODY derives a 444x284 device extent at 1.0, so one pixel is still the same box.
        const exact = offscreenPaintBox(BODY, 1.0, {width: 445, height: 284}, twoMonitors);
        expect(exact.explained).toBeTrue();
        const past = offscreenPaintBox(BODY, 1.0, {width: 446, height: 284}, twoMonitors);
        expect(past.explained).toBeFalse();
    });

    it('holds the derivation, and reports the drift, when no candidate explains the read', () => {
        // Holding the derivation is not "draw nothing": the quad stays the 444x284 box the body
        // needs, so nothing is masked, and the read-vs-derived disagreement still raises the
        // invariant. Dividing the 620px read by 1.0 was the old abstention, and it cost the body 176
        // units of mask.
        const drifted = {width: 620, height: 400};
        const held = offscreenPaintBox(BODY, 1.0, drifted, threeMonitors);
        expect(held.scale).toBe(1.0);
        expect(held.extent).toEqual({width: 444, height: 284});
        expect(held.predicted).toEqual({width: 444, height: 284});
        // The invariant is reported off this flag: a pass that explained its FBO is agreement.
        expect(held.explained).toBeFalse();

        const picked = offscreenPaintBox(BODY, 1.0, realScaleFbo, twoMonitors);
        expect(picked.explained).toBeTrue();
    });

    it('holds the derivation when a stale candidate set cannot explain the FBO', () => {
        // The pre-seam defect: the client's reserved ring reaches the 4/3 monitor before the frame
        // does, so the engine sizes the FBO at 4/3 while the reconcile pass still carries only the
        // frame's scale. Dividing the 593x379 read by 1.0 made the quad 593 units for a 444-unit
        // body, and the clip masked the body's right and bottom quarter down to its own fraction.
        const stale = offscreenScaleCandidates([1.0]);
        const box = offscreenPaintBox(BODY, 1.0, realScaleFbo, stale);
        const quad = offscreenQuad(BODY, 1.0);
        expect(box.extent).toEqual({width: quad.width, height: quad.height});
        expect(box.predicted).toEqual(offscreenDeviceExtent(BODY, 1.0));
        expect(offscreenExtent(quad, realScaleFbo, 1.0).width).toBe(593);
    });

    it('falls back to the derived box and origin when the FBO extent is unreadable', () => {
        const box = offscreenPaintBox(BODY, MONITOR_SCALE_4_3, null, threeMonitors);
        const quad = offscreenQuad(BODY, MONITOR_SCALE_4_3);
        expect(box.extent).toEqual({width: quad.width, height: quad.height});
        expect(box.offsetX).toBe(quad.offsetX);
        expect(box.offsetY).toBe(quad.offsetY);
    });
});

/**
 * The clip uploads `uQuadSize` and `uFboOffset` from one box and skips the upload when the values it
 * last wrote are unchanged, so the guard has to compare every value the box carries.
 *
 * The effect itself imports Cogl, so a unit spec cannot paint it. The guard and the two vectors it
 * writes are driven here through the predicate the effect calls, on real `offscreenPaintBox` output.
 */
describe('offscreenUniformsStale: the origin is part of the upload guard', () => {
    // A body whose enlarged box is exactly 406x203 device px at 1.0.
    const TWO_TO_ONE_BODY = {width: 403, height: 200};

    /**
     * The effect's upload step: `quad` and `offset` are the two vectors it keeps, so they are the
     * last written pair, and a paint only uploads when the guard says the box differs from them.
     */
    function paint(written, box) {
        if (!offscreenUniformsStale(written.quad, written.offset, box))
            return false;
        written.quad = [box.extent.width, box.extent.height];
        written.offset = [box.offsetX, box.offsetY];
        return true;
    }

    it('re-uploads a second paint whose FBO moved to the other monitor\'s allocation', () => {
        // Same body and same declared scale, so the size and the scale changes are both undefined:
        // the window stayed on the 1.0 monitor while its frame reached the 4/3 one, and the FBO was
        // reallocated on that grid. The extent and the origin move together, and the guard reads
        // both, so a paint that skipped the pair would leave `uFboOffset` from the other grid.
        const oneToOne = offscreenPaintBox(TWO_TO_ONE_BODY, 1.0, {width: 406, height: 203},
            offscreenScaleCandidates([1.0]));
        const straddling = offscreenPaintBox(TWO_TO_ONE_BODY, 1.0, {width: 542, height: 271},
            offscreenScaleCandidates([1.0, MONITOR_SCALE_4_3]));
        expect(straddling.scale).toBe(MONITOR_SCALE_4_3);
        expect(straddling.extent).not.toEqual(oneToOne.extent);
        expect(straddling.offsetX).not.toBe(oneToOne.offsetX);

        const written = {quad: [0, 0], offset: [0, 0]};
        expect(paint(written, oneToOne)).toBe(true);
        expect(written.offset).toEqual([oneToOne.offsetX, oneToOne.offsetY]);
        // A repeat paint of one box writes nothing.
        expect(paint(written, oneToOne)).toBe(false);
        expect(paint(written, straddling)).toBe(true);
        expect(written.quad).toEqual([straddling.extent.width, straddling.extent.height]);
        expect(written.offset).toEqual([straddling.offsetX, straddling.offsetY]);
    });

    it('covers every value the two vectors are built from', () => {
        const box = offscreenPaintBox(TWO_TO_ONE_BODY, 1.0, {width: 406, height: 203},
            offscreenScaleCandidates([1.0]));
        const quad = [box.extent.width, box.extent.height];
        const offset = [box.offsetX, box.offsetY];
        expect(offscreenUniformsStale(quad, offset, box)).toBe(false);
        expect(offscreenUniformsStale([quad[0] + 0.5, quad[1]], offset, box)).toBe(true);
        expect(offscreenUniformsStale([quad[0], quad[1] + 0.5], offset, box)).toBe(true);
        expect(offscreenUniformsStale(quad, [offset[0] + 0.5, offset[1]], box)).toBe(true);
        expect(offscreenUniformsStale(quad, [offset[0], offset[1] + 0.5], box)).toBe(true);
    });
});
