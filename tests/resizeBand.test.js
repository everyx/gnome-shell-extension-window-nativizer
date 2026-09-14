/**
 * resize band geometry and eligibility unit tests (jasmine-gjs).
 * Run: pnpm test
 */

import {
    computeResizeBands,
    MIN_BAND_WINDOW,
    REGION_DIRECTION,
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

/** @returns {boolean} Whether the half-open rect contains the point */
function contains(r, px, py) {
    return px >= r.x && px < r.x + r.width && py >= r.y && py < r.y + r.height;
}

/** @returns {number} Area shared by two rects */
function overlapArea(a, b) {
    const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return width > 0 && height > 0 ? width * height : 0;
}

/**
 * The band's expected union, stated independently of computeResizeBands: the 12px ring,
 * the four outward 24x24 corner squares, and the 24px arm each corner takes along an edge
 * (of which the outer 12px reaches past the ring).
 * @param {object} frame
 * @param {number} px
 * @param {number} py
 * @returns {boolean}
 */
function inExpectedUnion(frame, px, py) {
    const b = RESIZE_BAND;
    const c = RESIZE_CORNER;
    const {x, y, width, height} = frame;
    const ring = !contains(frame, px, py) &&
        contains(rect(x - b, y - b, width + 2 * b, height + 2 * b), px, py);
    const squares = [
        rect(x - c, y - c, c, c), rect(x + width, y - c, c, c),
        rect(x - c, y + height, c, c), rect(x + width, y + height, c, c),
    ];
    const arms = [
        rect(x, y - c, c, c - b), rect(x + width - c, y - c, c, c - b),
        rect(x, y + height + b, c, c - b), rect(x + width - c, y + height + b, c, c - b),
    ];
    return ring || squares.some(r => contains(r, px, py)) || arms.some(r => contains(r, px, py));
}

/**
 * @param {object} frame
 * @returns {number} Area of the expected union, for a frame at least 2*RESIZE_CORNER per side
 */
function unionArea(frame) {
    const b = RESIZE_BAND;
    const c = RESIZE_CORNER;
    const ring = (frame.width + 2 * b) * (frame.height + 2 * b) -
        frame.width * frame.height;
    const cornerExtra = 4 * (c * c - b * b);
    const armExtra = 4 * c * (c - b);
    return ring + cornerExtra + armExtra;
}

/**
 * @param {object} frame
 * @param {number} px
 * @param {number} py
 * @returns {string} A readable context for a failing sample
 */
function at(frame, px, py) {
    return `${px},${py} on ${frame.x},${frame.y} ${frame.width}x${frame.height}`;
}

describe('computeResizeBands', () => {
    it('lays the four edges between the corners and each corner out as two regions', () => {
        const bands = computeResizeBands({frame: rect(100, 50, 400, 300)});

        // Edges stop 24px short of each corner.
        expect(bands.n).toEqual(rect(124, 38, 352, 12));
        expect(bands.s).toEqual(rect(124, 350, 352, 12));
        expect(bands.w).toEqual(rect(88, 74, 12, 252));
        expect(bands.e).toEqual(rect(500, 74, 12, 252));

        // Each corner is two regions: the edge it reaches 24px along (merged with the
        // outward 24x24 quadrant), and the 24x12 it takes from the other edge.
        expect(bands.nw_n).toEqual(rect(76, 26, 48, 24));
        expect(bands.nw_w).toEqual(rect(88, 50, 12, 24));
        expect(bands.ne_n).toEqual(rect(476, 26, 48, 24));
        expect(bands.ne_e).toEqual(rect(500, 50, 12, 24));
        expect(bands.sw_s).toEqual(rect(76, 350, 48, 24));
        expect(bands.sw_w).toEqual(rect(88, 326, 12, 24));
        expect(bands.se_s).toEqual(rect(476, 350, 48, 24));
        expect(bands.se_e).toEqual(rect(500, 326, 12, 24));
    });

    it('keeps the twelve regions pairwise disjoint, so a point has one direction', () => {
        for (const frame of [rect(10, 20, 61, 43), rect(100, 100, 10, 8), rect(0, 0, 49, 51)]) {
            const bands = computeResizeBands({frame});
            const rects = RESIZE_BAND_REGIONS.map(r => bands[r]).filter(Boolean);
            for (let i = 0; i < rects.length; i++) {
                for (let j = i + 1; j < rects.length; j++)
                    expect(overlapArea(rects[i], rects[j])).toBe(0);
            }
        }
    });

    it('tiles the ring plus the corner squares and arms, edge to edge', () => {
        const frame = rect(10, 20, 61, 53);
        const bands = computeResizeBands({frame});
        const rects = RESIZE_BAND_REGIONS.map(r => bands[r]);

        expect(rects.every(Boolean)).toBeTrue();
        const area = rects.reduce((sum, r) => sum + r.width * r.height, 0);
        expect(area).toBe(unionArea(frame));

        // Every sampled point of the expected union is in exactly one region, and nothing
        // outside it is covered.
        for (let px = frame.x - RESIZE_CORNER; px < frame.x + frame.width + RESIZE_CORNER; px += 1) {
            for (let py = frame.y - RESIZE_CORNER; py < frame.y + frame.height + RESIZE_CORNER; py += 1) {
                const hits = RESIZE_BAND_REGIONS.filter(r => bands[r] && contains(bands[r], px, py));
                const expected = inExpectedUnion(frame, px, py) ? 1 : 0;
                if (hits.length !== expected)
                    fail(`expected ${expected} region at ${at(frame, px, py)}, got ${hits.length}`);
            }
        }
    });

    it('gives the 24x12 strip hugging the north edge next to the corner to the corner', () => {
        const frame = rect(100, 50, 400, 300);
        const bands = computeResizeBands({frame});

        // Previously the north edge claimed this strip, and the cursor flipped to N where
        // GTK reads NW (get_edge_for_coordinates). This is the regression this change fixes.
        for (const [region, px, py] of [
            ['nw_n', frame.x + 12, frame.y - 6],
            ['ne_n', frame.x + frame.width - 12, frame.y - 6],
            ['sw_s', frame.x + 12, frame.y + frame.height + 6],
            ['se_s', frame.x + frame.width - 12, frame.y + frame.height + 6],
        ]) {
            expect(contains(bands[region], px, py)).withContext(`${region} at ${px},${py}`).toBeTrue();
            expect(contains(bands.n, px, py)).toBeFalse();
            expect(contains(bands.s, px, py)).toBeFalse();
        }
    });

    it('still tiles when the window is smaller than two handles', () => {
        const frame = rect(100, 100, 10, 8);
        const bands = computeResizeBands({frame});
        const rects = RESIZE_BAND_REGIONS.map(r => bands[r]);

        // The edges vanish; the two corner reaches already meet at the midline.
        expect(bands.n).toBeNull();
        expect(bands.s).toBeNull();
        expect(bands.w).toBeNull();
        expect(bands.e).toBeNull();

        // Split at the midline, with neither side negative.
        expect(bands.nw_n).toEqual(rect(76, 76, 29, 24));
        expect(bands.ne_n).toEqual(rect(105, 76, 29, 24));
        expect(bands.nw_w).toEqual(rect(88, 100, 12, 4));
        expect(bands.sw_w).toEqual(rect(88, 104, 12, 4));
        for (const r of rects.filter(Boolean))
            expect(r.width > 0 && r.height > 0).toBeTrue();

        for (let px = frame.x - RESIZE_CORNER; px < frame.x + frame.width + RESIZE_CORNER; px += 1) {
            for (let py = frame.y - RESIZE_CORNER; py < frame.y + frame.height + RESIZE_CORNER; py += 1) {
                const hits = RESIZE_BAND_REGIONS.filter(r => bands[r] && contains(bands[r], px, py));
                const expected = inExpectedUnion(frame, px, py) ? 1 : 0;
                if (hits.length !== expected)
                    fail(`expected ${expected} region at ${at(frame, px, py)}, got ${hits.length}`);
            }
        }
    });

    it('drops every region that falls off the monitor', () => {
        const bounds = rect(0, 0, 1920, 1080);
        const bands = computeResizeBands({frame: rect(0, 0, 400, 300), bounds});

        // Left and top are off screen; so are the outward halves of the two top corners.
        expect(bands.n).toBeNull();
        expect(bands.ne_n).toBeNull();
        expect(bands.nw_n).toBeNull();
        expect(bands.nw_w).toBeNull();
        expect(bands.w).toBeNull();
        expect(bands.sw_w).toBeNull();

        // The on-screen half of a corner still counts: the south-west arm reaches 24px
        // along the south edge, and that part is on screen.
        expect(bands.e).toEqual(rect(400, 24, 12, 252));
        expect(bands.se_e).toEqual(rect(400, 276, 12, 24));
        expect(bands.se_s).toEqual(rect(376, 300, 48, 24));
        expect(bands.s).toEqual(rect(24, 300, 352, 12));
        expect(bands.sw_s).toEqual(rect(0, 300, 24, 24));
    });

    it('clips a region to the monitor edge', () => {
        const bounds = rect(0, 0, 1920, 1080);
        const bands = computeResizeBands({frame: rect(6, 980, 200, 90), bounds});

        // Left bands hang 6px over the edge: clipped, not dropped.
        expect(bands.w).toEqual(rect(0, 1004, 6, 42));
        expect(bands.nw_w).toEqual(rect(0, 980, 6, 24));
        expect(bands.nw_n).toEqual(rect(0, 956, 30, 24));
        // Bottom bands hang 2px over the bottom edge.
        expect(bands.s).toEqual(rect(30, 1070, 152, 10));
        expect(bands.sw_s).toEqual(rect(0, 1070, 30, 10));
        expect(bands.sw_w).toEqual(rect(0, 1046, 6, 24));
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
        expect(whole.nw_n.height).toBe(RESIZE_CORNER);
        expect(whole.nw_n.width).toBe(2 * RESIZE_CORNER);
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

describe('region directions', () => {
    it('gives every region one of the eight compass directions', () => {
        const compass = new Set(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']);
        for (const region of RESIZE_BAND_REGIONS)
            expect(compass.has(REGION_DIRECTION[region])).withContext(region).toBeTrue();
    });

    it('gives both halves of a corner the same direction, never a straight edge', () => {
        expect(REGION_DIRECTION.nw_n).toBe('nw');
        expect(REGION_DIRECTION.nw_w).toBe('nw');
        expect(REGION_DIRECTION.ne_n).toBe('ne');
        expect(REGION_DIRECTION.ne_e).toBe('ne');
        expect(REGION_DIRECTION.sw_s).toBe('sw');
        expect(REGION_DIRECTION.sw_w).toBe('sw');
        expect(REGION_DIRECTION.se_s).toBe('se');
        expect(REGION_DIRECTION.se_e).toBe('se');
    });

    it('keeps the straight edges straight', () => {
        expect(REGION_DIRECTION.n).toBe('n');
        expect(REGION_DIRECTION.s).toBe('s');
        expect(REGION_DIRECTION.e).toBe('e');
        expect(REGION_DIRECTION.w).toBe('w');
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
