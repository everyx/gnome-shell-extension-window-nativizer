/**
 * resize band geometry and eligibility unit tests (jasmine-gjs).
 * Run: pnpm test
 */

import {
    computeResizeBands,
    MIN_BAND_WINDOW,
    RESIZE_BAND,
    RESIZE_BAND_REGIONS,
    RESIZE_CORNER,
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

/**
 * @param {object} frame
 * @returns {number} Area of the union the band must tile: the 12px ring plus the
 * outward half of each 24×24 corner square (the inward half is already in the ring).
 */
function bandArea(frame) {
    const ring = (frame.width + 2 * RESIZE_BAND) * (frame.height + 2 * RESIZE_BAND) -
        frame.width * frame.height;
    const addedPerCorner = RESIZE_CORNER * RESIZE_CORNER - RESIZE_BAND * RESIZE_BAND;
    return ring + 4 * addedPerCorner;
}

/**
 * @param {object} frame
 * @returns {Record<string, object>} The union the eight regions must tile exactly
 */
function expectedCornerRects(frame) {
    const {x, y, width, height} = frame;
    const c = RESIZE_CORNER;
    return {
        nw: rect(x - c, y - c, c, c),
        ne: rect(x + width, y - c, c, c),
        sw: rect(x - c, y + height, c, c),
        se: rect(x + width, y + height, c, c),
    };
}

describe('computeResizeBands', () => {
    it('rings the frame with 12px edges and 24x24 corners', () => {
        const bands = computeResizeBands({frame: rect(100, 50, 400, 300)});

        expect(bands.n).toEqual(rect(100, 38, 400, 12));
        expect(bands.s).toEqual(rect(100, 350, 400, 12));
        expect(bands.w).toEqual(rect(88, 50, 12, 300));
        expect(bands.e).toEqual(rect(500, 50, 12, 300));
        expect(bands.nw).toEqual(rect(76, 26, 24, 24));
        expect(bands.ne).toEqual(rect(500, 26, 24, 24));
        expect(bands.sw).toEqual(rect(76, 350, 24, 24));
        expect(bands.se).toEqual(rect(500, 350, 24, 24));
    });

    it('tiles the ring plus the corner squares: eight disjoint regions, no overlap and no gap', () => {
        const frame = rect(10, 20, 61, 43);
        const bands = computeResizeBands({frame});
        const rects = RESIZE_BAND_REGIONS.map(region => bands[region]);

        expect(rects.every(Boolean)).toBeTrue();
        for (let i = 0; i < rects.length; i++) {
            for (let j = i + 1; j < rects.length; j++)
                expect(overlapArea(rects[i], rects[j])).toBe(0);
        }

        const area = rects.reduce((sum, r) => sum + r.width * r.height, 0);
        expect(area).toBe(bandArea(frame));

        // Every corner is the outward 24px square, and every edge keeps to the frame side.
        const corners = expectedCornerRects(frame);
        for (const [region, corner] of Object.entries(corners))
            expect(bands[region]).toEqual(corner);
        expect(bands.n.x).toBe(frame.x);
        expect(bands.n.width).toBe(frame.width);
    });

    it('still tiles when the window is smaller than two handles', () => {
        const frame = rect(100, 100, 10, 8);
        const bands = computeResizeBands({frame});
        const rects = RESIZE_BAND_REGIONS.map(region => bands[region]);

        // Short sides, not clamped: the edge spans the frame either way.
        expect(bands.n).toEqual(rect(100, 88, 10, 12));
        expect(bands.w).toEqual(rect(88, 100, 12, 8));
        expect(rects.every(Boolean)).toBeTrue();

        const area = rects.reduce((sum, r) => sum + r.width * r.height, 0);
        expect(area).toBe(bandArea(frame));
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
        expect(bands.se).toEqual(rect(400, 300, 24, 24));
        expect(bands.s).toEqual(rect(0, 300, 400, 12));
    });

    it('clips a region to the monitor edge', () => {
        const bounds = rect(0, 0, 1920, 1080);
        const bands = computeResizeBands({frame: rect(6, 980, 200, 90), bounds});

        // Left band hangs 6px over the edge: clipped, not dropped.
        expect(bands.w).toEqual(rect(0, 980, 6, 90));
        expect(bands.nw).toEqual(rect(0, 956, 6, 24));
        // Bottom band hangs 2px over the bottom edge.
        expect(bands.s).toEqual(rect(6, 1070, 200, 10));
        expect(bands.sw).toEqual(rect(0, 1070, 6, 10));
    });

    it('returns nothing when the window lies outside the monitor', () => {
        const bounds = rect(0, 0, 1920, 1080);
        expect(computeResizeBands({frame: rect(-500, -400, 100, 100), bounds}))
            .toEqual(emptyBands());
    });

    it('is 12 logical pixels deep at a fractional scale too', () => {
        const frame = rect(100, 50, 400, 300);
        const whole = computeResizeBands({frame, scale: 1});
        expect(computeResizeBands({frame, scale: 1.3333})).toEqual(whole);
        expect(computeResizeBands({frame, scale: 2})).toEqual(whole);
        expect(whole.n.height).toBe(RESIZE_BAND);
        expect(whole.nw.width).toBe(RESIZE_CORNER);
        expect(whole.nw.height).toBe(RESIZE_CORNER);
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

    it('skips a window whose declared margin is already a native-width handle', () => {
        // buffer - frame = 24 on each axis → 12px per side, GTK4's floor.
        const wide = {...plain, bufferWidth: 824, bufferHeight: 624};
        expect(shouldShowResizeBand(wide)).toBeFalse();
    });

    it('keeps the band while either axis is narrower than a native handle', () => {
        // One axis already native, the other a hair under: still awkward to grab.
        expect(shouldShowResizeBand({
            ...plain, bufferWidth: 824, bufferHeight: 622,
        })).toBeTrue();
        expect(shouldShowResizeBand({
            ...plain, bufferWidth: 822, bufferHeight: 624,
        })).toBeTrue();
    });

    it('does not read a margin when the window has no ring at all', () => {
        expect(shouldShowResizeBand({...plain, bufferWidth: 800, bufferHeight: 600})).toBeTrue();
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
