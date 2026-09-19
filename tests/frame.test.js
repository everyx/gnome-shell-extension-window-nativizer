/**
 * frame.js — the body inside a buffer, as a pure function (jasmine-gjs).
 * Run: pnpm test
 */

import {bodyFrame, frameFromInsets, insetsFromRects, hasDeclaredMarginRing, ZERO_INSETS} from '../src/lib/frame.js';

const rect = (x, y, width, height) => ({x, y, width, height});
const insets = (left, top, right, bottom) => ({left, top, right, bottom});

describe('frameFromInsets', () => {
    it('places the body inside the actor', () => {
        expect(frameFromInsets({width: 440, height: 280}, insets(25, 25, 25, 25)))
            .toEqual(rect(25, 25, 390, 230));
    });

    it('takes the whole actor when there is no inset', () => {
        expect(frameFromInsets({width: 440, height: 280})).toEqual(rect(0, 0, 440, 280));
        expect(frameFromInsets({width: 440, height: 280}, ZERO_INSETS)).toEqual(rect(0, 0, 440, 280));
    });

    it('keeps asymmetric insets where they are', () => {
        expect(frameFromInsets({width: 100, height: 100}, insets(12, 0, 4, 20)))
            .toEqual(rect(12, 0, 84, 80));
    });

    it('uses the live actor size, so a grown actor grows the body', () => {
        const inset = insets(12, 12, 12, 12);
        expect(frameFromInsets({width: 100, height: 100}, inset).width).toBe(76);
        expect(frameFromInsets({width: 300, height: 200}, inset).width).toBe(276);
        expect(frameFromInsets({width: 300, height: 200}, inset).height).toBe(176);
    });

    it('yields a non-positive body when the insets do not fit', () => {
        expect(frameFromInsets({width: 20, height: 100}, insets(12, 0, 12, 0)).width).toBe(-4);
        expect(frameFromInsets({width: 100, height: 20}, insets(0, 12, 0, 12)).height).toBe(-4);
    });
});

describe('bodyFrame', () => {
    it('is frameFromInsets while the ring still leaves a body', () => {
        expect(bodyFrame({width: 440, height: 280}, insets(25, 25, 25, 25)))
            .toEqual(rect(25, 25, 390, 230));
        expect(bodyFrame({width: 100, height: 100}, insets(12, 0, 4, 20)))
            .toEqual(rect(12, 0, 84, 80));
    });

    it('falls back to the whole actor when the ring outruns it, so the pass is not skipped', () => {
        // The insets are debounced and the actor is not: a resize can hand the paint insets
        // wider than the actor for one frame. The effect and the shadow both call this, so
        // neither can end up with a non-positive body - the clip must keep painting the
        // actor (it is the window's own content) instead of returning before super.
        expect(bodyFrame({width: 20, height: 100}, insets(12, 0, 12, 0)))
            .toEqual(rect(0, 0, 20, 100));
        expect(bodyFrame({width: 100, height: 20}, insets(0, 12, 0, 12)))
            .toEqual(rect(0, 0, 100, 20));
        // A negative body becomes the actor too; a negative cast would put x2 < x1 into
        // add_texture_rectangle.
        expect(bodyFrame({width: 10, height: 10}, insets(30, 30, 30, 30)))
            .toEqual(rect(0, 0, 10, 10));
    });

    it('never returns a non-positive body for a positive actor', () => {
        for (const inset of [insets(0, 0, 0, 0), insets(12, 12, 12, 12), insets(99, 0, 0, 99)]) {
            const frame = bodyFrame({width: 40, height: 40}, inset);
            expect(frame.width > 0 && frame.height > 0).withContext(JSON.stringify(inset)).toBeTrue();
        }
    });
});

describe('insetsFromRects', () => {
    it('reads the ring between a centered buffer and its frame', () => {
        expect(insetsFromRects(rect(100, 50, 440, 280), rect(125, 75, 390, 230)))
            .toEqual(insets(25, 25, 25, 25));
    });

    it('reads an asymmetric ring', () => {
        expect(insetsFromRects(rect(0, 0, 100, 100), rect(12, 0, 84, 80)))
            .toEqual(insets(12, 0, 4, 20));
    });

    it('reads no ring as zero insets, not as null', () => {
        expect(insetsFromRects(rect(0, 0, 100, 100), rect(0, 0, 100, 100))).toEqual(ZERO_INSETS);
    });

    it('refuses a frame that is larger than its buffer', () => {
        expect(insetsFromRects(rect(0, 0, 100, 100), rect(-4, -4, 120, 120))).toBeNull();
        expect(insetsFromRects(rect(0, 0, 100, 100), rect(0, 0, 100, 120))).toBeNull();
    });

    it('refuses a degenerate or missing rect', () => {
        expect(insetsFromRects(rect(0, 0, 100, 100), rect(10, 10, 0, 80))).toBeNull();
        expect(insetsFromRects(rect(0, 0, 0, 100), rect(0, 0, 100, 100))).toBeNull();
        expect(insetsFromRects(null, rect(0, 0, 100, 100))).toBeNull();
        expect(insetsFromRects(rect(0, 0, 100, 100), null)).toBeNull();
        expect(insetsFromRects(rect(0, 0, 100, 100), rect(10, 10, -10, 80))).toBeNull();
        expect(insetsFromRects(rect(0, 0, -100, 100), rect(0, 0, 100, 100))).toBeNull();
    });

    it('reads insets with fractional / subpixel coordinates', () => {
        expect(insetsFromRects(rect(0.5, 0.5, 100.5, 100.5), rect(12.5, 0.5, 84.0, 80.0)))
            .toEqual(insets(12, 0, 4.5, 20.5));
    });
});

describe('hasDeclaredMarginRing', () => {
    it('returns true when buffer extends past frame on any side', () => {
        expect(hasDeclaredMarginRing({
            buffer: rect(0, 0, 860, 660),
            frame: rect(30, 30, 800, 600),
        })).toBeTrue();
    });

    it('returns false when buffer exactly matches frame (compact/PiP window)', () => {
        expect(hasDeclaredMarginRing({
            buffer: rect(100, 100, 400, 225),
            frame: rect(100, 100, 400, 225),
        })).toBeFalse();
    });

    it('returns false for SSD windows even when buffer extends past frame', () => {
        expect(hasDeclaredMarginRing({
            buffer: rect(0, 0, 860, 660),
            frame: rect(30, 30, 800, 600),
            hasSsd: true,
        })).toBeFalse();
    });

    it('returns false for null or degenerate rects', () => {
        expect(hasDeclaredMarginRing({buffer: null, frame: null})).toBeFalse();
        expect(hasDeclaredMarginRing()).toBeFalse();
        expect(hasDeclaredMarginRing({
            buffer: rect(0, 0, 100, 100),
            frame: rect(10, 10, 0, 80),
        })).toBeFalse();
        expect(hasDeclaredMarginRing({
            buffer: rect(0, 0, -100, 100),
            frame: rect(0, 0, 50, 50),
        })).toBeFalse();
        expect(hasDeclaredMarginRing({
            buffer: rect(0, 0, 100, 100),
            frame: rect(10, 10, -20, -20),
        })).toBeFalse();
    });

    it('handles fractional / subpixel rect coordinates correctly', () => {
        expect(hasDeclaredMarginRing({
            buffer: rect(0.5, 0.5, 860.5, 660.5),
            frame: rect(30.5, 30.5, 800.0, 600.0),
        })).toBeTrue();

        expect(hasDeclaredMarginRing({
            buffer: rect(10.25, 20.75, 400.0, 300.0),
            frame: rect(10.25, 20.75, 400.0, 300.0),
        })).toBeFalse();
    });
});

