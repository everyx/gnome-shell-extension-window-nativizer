/**
 * Rounded overview-mask bytes unit tests (jasmine-gjs).
 * Run: pnpm test
 */

import {roundedMaskBytes} from '../src/effects/overviewMaskBytes.js';
import {probeWouldChangeScreenshot} from '../src/effects/overviewMaskProbe.js';

/** @returns {number} Alpha of the pixel at (x, y) */
function alpha(mask, x, y) {
    return mask.data[y * mask.width + x];
}

describe('roundedMaskBytes', () => {
    const geometry = (overrides = {}) => ({
        width: 8, height: 8, frameX: 1, frameY: 1, frameW: 6, frameH: 6, radius: 2, erase: true,
        ...overrides,
    });

    it('returns null for a degenerate mask or body, exactly as buildRoundedMask did', () => {
        expect(roundedMaskBytes(geometry({width: 0}))).toBeNull();
        expect(roundedMaskBytes(geometry({width: 0.4}))).toBeNull();
        expect(roundedMaskBytes(geometry({height: 0}))).toBeNull();
        expect(roundedMaskBytes(geometry({frameW: 0}))).toBeNull();
        expect(roundedMaskBytes(geometry({frameH: 0}))).toBeNull();
        // A body entirely past the texture edge has no rows to fill either.
        expect(roundedMaskBytes(geometry({frameX: 100}))).toBeNull();
        expect(roundedMaskBytes(geometry({frameY: 100}))).toBeNull();
    });

    it('returns the rounded size the upload must use, not the raw geometry', () => {
        const mask = roundedMaskBytes(geometry({width: 8.6, height: 7.4}));
        expect(mask.width).toBe(9);
        expect(mask.height).toBe(7);
        expect(mask.data.length).toBe(9 * 7);
    });

    it('erases everything outside the body when erase', () => {
        const mask = roundedMaskBytes(geometry());
        // The body is [1, 7) on both axes; outside it is transparent.
        for (const [x, y] of [[0, 0], [0, 4], [4, 0], [7, 7], [7, 4], [4, 7]])
            expect(alpha(mask, x, y)).withContext(`outside ${x},${y}`).toBe(0);
        // The flat middle of the body is fully opaque.
        for (const [x, y] of [[3, 3], [4, 4], [3, 4], [4, 3]])
            expect(alpha(mask, x, y)).withContext(`inside ${x},${y}`).toBe(255);
    });

    it('keeps the ring opaque when it is not being erased', () => {
        const mask = roundedMaskBytes(geometry({erase: false}));
        expect(alpha(mask, 0, 0)).toBe(255);
        expect(alpha(mask, 7, 7)).toBe(255);
        // The corner is still carved out of that opaque field.
        expect(alpha(mask, 1, 1)).toBeLessThan(255);
    });

    it('carves an anti-aliased arc at each corner', () => {
        const mask = roundedMaskBytes(geometry());
        const topLeft = alpha(mask, 1, 1);
        // The extreme pixel centre sits outside the disc, so it keeps partial coverage...
        expect(topLeft).toBeGreaterThan(0);
        expect(topLeft).toBeLessThan(255);
        // ...and coverage rises monotonically towards the body.
        expect(alpha(mask, 1, 2)).toBeGreaterThanOrEqual(topLeft);
        expect(alpha(mask, 2, 2)).toBeGreaterThanOrEqual(alpha(mask, 1, 2));
        // The disc is centred, so the two inner neighbours agree.
        expect(alpha(mask, 1, 2)).toBe(alpha(mask, 2, 1));
        // Past the arc the body is full.
        expect(alpha(mask, 2, 2)).toBe(255);
        // The arc only touches the corner squares: the straight edges stay opaque.
        expect(alpha(mask, 4, 1)).toBe(255);
        expect(alpha(mask, 1, 4)).toBe(255);
    });

    it('leaves square corners when the radius is below half a pixel', () => {
        const mask = roundedMaskBytes(geometry({radius: 0.25}));
        expect(alpha(mask, 1, 1)).toBe(255);
        expect(alpha(mask, 0, 0)).toBe(0);
    });
});

describe('maskWouldChangeScreenshot', () => {
    it('never calls the 50-era get_image(), and probes only paint_to_bitmap', () => {
        let getImageCalls = 0;
        let paintCalls = 0;

        // A pre-51 shaped texture: get_image() exists, paint_to_bitmap() does not. Calling the
        // old member with a NULL surface aborts the process from GJS's marshaller, so the probe
        // must call nothing and answer "unsafe" instead.
        const legacy = {
            get_image() {
                getImageCalls++;
                return {tag: 'surface'};
            },
        };
        expect(probeWouldChangeScreenshot(legacy, {clip: {}, format: 0})).toBeTrue();
        expect(getImageCalls).toBe(0);

        // A 51+ shaped texture: paint_to_bitmap() is the probe, and get_image() is never reached.
        const modern = {
            get_image() {
                getImageCalls++;
                return {tag: 'surface'};
            },
            paint_to_bitmap() {
                paintCalls++;
                return {tag: 'bitmap'};
            },
        };
        expect(probeWouldChangeScreenshot(modern, {clip: {}, format: 0})).toBeTrue();
        expect(paintCalls).toBe(1);
        expect(getImageCalls).toBe(0);
    });

    it('reads the NULL bitmap as the offscreen path already in use, so the mask is safe', () => {
        // Every NULL branch leaves the screenshot path where the mask would put it (or there is
        // no content to move), so it is a "does not change" answer, not a refusal.
        expect(probeWouldChangeScreenshot({paint_to_bitmap: () => null}, {clip: {}, format: 0}))
            .toBeFalse();
    });

    it('treats a missing or throwing probe as unsafe', () => {
        expect(probeWouldChangeScreenshot(null, {clip: {}, format: 0})).toBeTrue();
        expect(probeWouldChangeScreenshot(undefined, {clip: {}, format: 0})).toBeTrue();
        expect(probeWouldChangeScreenshot(
            {paint_to_bitmap: () => { throw new Error('boom'); }}, {clip: {}, format: 0}))
            .toBeTrue();
    });
});
