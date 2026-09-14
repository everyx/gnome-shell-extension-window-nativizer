/**
 * resize band geometry and eligibility unit tests (jasmine-gjs).
 * Run: pnpm test
 */

import {
    computeResizeBands,
    MIN_BAND_WINDOW,
    RESIZE_BAND,
    RESIZE_BAND_REGIONS,
} from '../src/lib/resizeBand.js';
import {shouldShowResizeBand} from '../src/lib/detector.js';

const rect = (x, y, width, height) => ({x, y, width, height});

/** @returns {Record<string, object|null>} All regions null */
function emptyBands() {
    const bands = {};
    for (const region of RESIZE_BAND_REGIONS)
        bands[region] = null;
    return bands;
}

/** @returns {number} Area shared by two rects */
function overlapArea(a, b) {
    const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return width > 0 && height > 0 ? width * height : 0;
}

/** @returns {number} Area of a ring around `frame` grown by the band */
function ringArea(frame) {
    return (frame.width + 2 * RESIZE_BAND) * (frame.height + 2 * RESIZE_BAND) -
        frame.width * frame.height;
}

describe('computeResizeBands', () => {
    it('rings the frame with 12px edges and 12x12 corners', () => {
        const bands = computeResizeBands({frame: rect(100, 50, 400, 300)});

        expect(bands.n).toEqual(rect(100, 38, 400, 12));
        expect(bands.s).toEqual(rect(100, 350, 400, 12));
        expect(bands.w).toEqual(rect(88, 50, 12, 300));
        expect(bands.e).toEqual(rect(500, 50, 12, 300));
        expect(bands.nw).toEqual(rect(88, 38, 12, 12));
        expect(bands.ne).toEqual(rect(500, 38, 12, 12));
        expect(bands.sw).toEqual(rect(88, 350, 12, 12));
        expect(bands.se).toEqual(rect(500, 350, 12, 12));
    });

    it('tiles the ring: eight disjoint regions, no overlap and no gap', () => {
        const frame = rect(10, 20, 61, 43);
        const bands = computeResizeBands({frame});
        const rects = RESIZE_BAND_REGIONS.map(region => bands[region]);

        expect(rects.every(Boolean)).toBeTrue();
        for (let i = 0; i < rects.length; i++) {
            for (let j = i + 1; j < rects.length; j++)
                expect(overlapArea(rects[i], rects[j])).toBe(0);
        }

        const area = rects.reduce((sum, r) => sum + r.width * r.height, 0);
        expect(area).toBe(ringArea(frame));
    });

    it('still tiles when the window is smaller than two handles', () => {
        const frame = rect(100, 100, 10, 8);
        const bands = computeResizeBands({frame});
        const rects = RESIZE_BAND_REGIONS.map(region => bands[region]);

        // Short sides, not clamped: the corner squares sit outside the frame either way.
        expect(bands.n).toEqual(rect(100, 88, 10, 12));
        expect(bands.w).toEqual(rect(88, 100, 12, 8));
        expect(rects.every(Boolean)).toBeTrue();

        const area = rects.reduce((sum, r) => sum + r.width * r.height, 0);
        expect(area).toBe(ringArea(frame));
    });

    it('drops every region that falls off the monitor', () => {
        const bounds = rect(0, 0, 1920, 1080);
        const bands = computeResizeBands({frame: rect(0, 0, 400, 300), bounds});

        expect(bands.n).toBeNull();
        expect(bands.ne).toBeNull();
        expect(bands.nw).toBeNull();
        expect(bands.w).toBeNull();
        expect(bands.sw).toBeNull();

        expect(bands.e).toEqual(rect(400, 0, 12, 300));
        expect(bands.se).toEqual(rect(400, 300, 12, 12));
        expect(bands.s).toEqual(rect(0, 300, 400, 12));
    });

    it('clips a region to the monitor edge', () => {
        const bounds = rect(0, 0, 1920, 1080);
        const bands = computeResizeBands({frame: rect(6, 980, 200, 90), bounds});

        // Left band hangs 6px over the edge: clipped, not dropped.
        expect(bands.w).toEqual(rect(0, 980, 6, 90));
        expect(bands.nw).toEqual(rect(0, 968, 6, 12));
        // Bottom band hangs 2px over the bottom edge.
        expect(bands.s).toEqual(rect(6, 1070, 200, 10));
        expect(bands.sw).toEqual(rect(0, 1070, 6, 10));
    });

    it('returns nothing when the window lies outside the monitor', () => {
        const bounds = rect(0, 0, 1920, 1080);
        expect(computeResizeBands({frame: rect(-500, -400, 100, 100), bounds}))
            .toEqual(emptyBands());
    });

    it('is 12 logical pixels at a fractional scale too', () => {
        const frame = rect(100, 50, 400, 300);
        const whole = computeResizeBands({frame, scale: 1});
        expect(computeResizeBands({frame, scale: 1.3333})).toEqual(whole);
        expect(computeResizeBands({frame, scale: 2})).toEqual(whole);
        expect(whole.n.height).toBe(RESIZE_BAND);
    });

    it('refuses a scale that cannot place the regions', () => {
        for (const scale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
            expect(computeResizeBands({frame: rect(0, 0, 100, 100), scale})).toEqual(emptyBands());
    });

    it('returns nothing for a degenerate or missing frame', () => {
        expect(computeResizeBands({frame: rect(10, 10, 0, 100)})).toEqual(emptyBands());
        expect(computeResizeBands({frame: rect(10, 10, 100, 0)})).toEqual(emptyBands());
        expect(computeResizeBands({frame: null})).toEqual(emptyBands());
        expect(computeResizeBands({})).toEqual(emptyBands());
        expect(computeResizeBands()).toEqual(emptyBands());
    });
});

describe('shouldShowResizeBand', () => {
    const plain = {frameWidth: 800, frameHeight: 600, allowsResize: true, resizeBand: true};

    it('shows the band on a plain resizable window', () => {
        expect(shouldShowResizeBand(plain)).toBeTrue();
    });

    it('builds nothing when the setting is off', () => {
        expect(shouldShowResizeBand({...plain, resizeBand: false})).toBeFalse();
    });

    it('skips a window that cannot be resized', () => {
        expect(shouldShowResizeBand({...plain, allowsResize: false})).toBeFalse();
    });

    it('skips maximized, fullscreen, tiled and tile-matched windows', () => {
        expect(shouldShowResizeBand({...plain, isMaximized: true})).toBeFalse();
        expect(shouldShowResizeBand({...plain, isFullscreen: true})).toBeFalse();
        expect(shouldShowResizeBand({...plain, tiled: true})).toBeFalse();
        expect(shouldShowResizeBand({...plain, hasTileMatch: true})).toBeFalse();
    });

    it('skips a window whose own corners already look native', () => {
        expect(shouldShowResizeBand({...plain, nativeLikeCorners: true})).toBeFalse();
    });

    it('skips a window smaller than two handles', () => {
        expect(shouldShowResizeBand({...plain, frameWidth: MIN_BAND_WINDOW - 1})).toBeFalse();
        expect(shouldShowResizeBand({...plain, frameHeight: MIN_BAND_WINDOW - 1})).toBeFalse();
        expect(shouldShowResizeBand({...plain, frameWidth: MIN_BAND_WINDOW, frameHeight: MIN_BAND_WINDOW}))
            .toBeTrue();
    });

    it('does not build a band from a missing frame size', () => {
        expect(shouldShowResizeBand({resizeBand: true})).toBeFalse();
        expect(shouldShowResizeBand()).toBeFalse();
    });
});
