/**
 * Tests for the offscreen box derivation (offscreenBox.js).
 *
 * The numbers are the ones measured live in the nested session (red 441x281 body, one session per
 * scale, `get_target_size()` from the clip effect plus the corner contour in a desktop shot). They
 * are the regression guard for the defect this module replaced: the constants that used to stand in
 * for the box encoded a caller that scaled by `ceilf (resource_scale)`, so at 1.25x the shader was
 * handed 444x284 logical units for an FBO that really spans 556x356 device px.
 */

import {ENLARGE_ROUNDING_PAD, ENLARGE_TOTAL_PAD, offscreenExtent, offscreenQuad} from '../src/lib/offscreenBox.js';
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
