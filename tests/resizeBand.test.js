/**
 * resize band geometry, direction and eligibility unit tests (jasmine-gjs).
 * Run: pnpm test
 */

import {
    computeResizeBands,
    edgeForPoint,
    MIN_BAND_WINDOW,
    normalizeConstrainedEdges,
    RESIZE_BAND,
    RESIZE_BAND_REGIONS,
    RESIZE_CORNER,
} from '../src/lib/resizeBand.js';
import {decideResizeBand, evaluateWindowActions} from '../src/lib/detector.js';
import {buildRuleKey} from '../src/lib/rules.js';

const rect = (x, y, width, height) => ({x, y, width, height});

/** @returns {Record<string, object|null>} All surfaces null */
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
 * The band's expected union, stated independently of computeResizeBands: exactly the ring
 * the frame grows by RESIZE_BAND, half-open. The corners add nothing outward - GTK's input
 * region stops at RESIZE_HANDLE_SIZE, so the ring is as far as the band can reach.
 * @param {object} frame
 * @param {number} px
 * @param {number} py
 * @returns {boolean}
 */
function inExpectedUnion(frame, px, py) {
    const b = RESIZE_BAND;
    const {x, y, width, height} = frame;
    return !contains(frame, px, py) &&
        contains(rect(x - b, y - b, width + 2 * b, height + 2 * b), px, py);
}

/**
 * @param {object} frame
 * @returns {number} Area of the expected union: the 12px ring, nothing beyond it
 */
function unionArea(frame) {
    const b = RESIZE_BAND;
    return (frame.width + 2 * b) * (frame.height + 2 * b) - frame.width * frame.height;
}

/**
 * The oracle: GTK's `get_edge_for_coordinates()` transcribed straight from
 * research/gtk/gtk/gtkwindow.c, with handle_size = RESIZE_BAND and
 * resize_handle_size = RESIZE_CORNER. Deliberately independent of the source module, so a
 * transcription slip in either one shows up as a disagreement. The rounded-corner fallback
 * past the four bands is left out: it is inside the body, which is the client's surface.
 * @param {object} frame
 * @param {number} x
 * @param {number} y
 * @returns {string|null}
 */
function gtkEdge(frame, x, y) {
    const left = frame.x;
    const top = frame.y;
    const right = left + frame.width;
    const bottom = top + frame.height;
    const b = RESIZE_BAND;
    const c = RESIZE_CORNER;

    if (x < left && x >= left - b) {
        if (y < top + c && y >= top - b)
            return 'nw';
        if (y > bottom - c && y <= bottom + b)
            return 'sw';
        return 'w';
    } else if (x > right && x <= right + b) {
        if (y < top + c && y >= top - b)
            return 'ne';
        if (y > bottom - c && y <= bottom + b)
            return 'se';
        return 'e';
    } else if (y < top && y >= top - b) {
        if (x < left + c && x >= left - b)
            return 'nw';
        if (x > right - c && x <= right + b)
            return 'ne';
        return 'n';
    } else if (y > bottom && y <= bottom + b) {
        if (x < left + c && x >= left - b)
            return 'sw';
        if (x > right - c && x <= right + b)
            return 'se';
        return 's';
    }
    return null;
}

/**
 * @param {object} frame
 * @param {number} px
 * @param {number} py
 * @returns {boolean} Whether the point is in the outer ring: inside the grown box (half-open)
 *   and outside the body (half-open), the domain the band promises to classify
 */
function inRing(frame, px, py) {
    const b = RESIZE_BAND;
    return contains(rect(frame.x - b, frame.y - b, frame.width + 2 * b, frame.height + 2 * b), px, py) &&
        !contains(frame, px, py);
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

/**
 * Every ring point on a 1px grid: our direction must equal the oracle's, and every point
 * off the ring must be null.
 * @param {object} frame
 */
function assertOracleAgreement(frame) {
    const b = RESIZE_BAND;
    const mismatches = [];
    for (let px = frame.x - b; px < frame.x + frame.width + b; px += 1) {
        for (let py = frame.y - b; py < frame.y + frame.height + b; py += 1) {
            const actual = edgeForPoint(frame, px, py);
            const expected = inRing(frame, px, py) ? gtkEdge(frame, px, py) : null;
            if (actual !== expected)
                mismatches.push(`${at(frame, px, py)}: ${actual} != ${expected}`);
        }
    }
    expect(mismatches)
        .withContext(`oracle disagreement on ${frame.x},${frame.y} ${frame.width}x${frame.height}`)
        .toEqual([]);
}

describe('edgeForPoint', () => {
    // The core defence: on regular windows, on a side shorter than two corner reaches
    // (24-47px), and on a window too small for both corners to fit, the direction must be
    // GTK's, first-match-wins order included.
    it('agrees with GTK on every ring pixel, across window sizes', () => {
        for (const frame of [
            rect(100, 50, 400, 300),   // regular
            rect(0, 0, 24, 24),        // at the origin, the sanity floor exactly
            rect(100, 100, 40, 600),   // 40px wide: top and bottom have no edge left
            rect(100, 100, 600, 40),   // 40px tall: left and right have no edge left
            rect(100, 100, 25, 300),   // 25px wide, just above the sanity floor
            rect(100, 100, 30, 30),    // both sides overlap
            rect(100, 100, 10, 8),     // no side reaches, all four corners live
            rect(-500, -400, 100, 100) // negative origin
        ])
            assertOracleAgreement(frame);
    });

    it('hands a short side to the earlier corner, not to the midpoint', () => {
        // 30px wide: GTK's north band tests the west corner first (`x < left + 24`), so it
        // takes the first 24px and the remaining 6px are NE. The old half/half split would
        // have put the boundary at left + 15.
        const frame = rect(100, 100, 30, 30);
        expect(edgeForPoint(frame, 123, 99)).toBe('nw');
        expect(edgeForPoint(frame, 124, 99)).toBe('ne');
        expect(edgeForPoint(frame, 115, 99)).toBe('nw');
        // The west band does the same down the left edge: NW to top + 24, then SW.
        expect(edgeForPoint(frame, 99, 123)).toBe('nw');
        expect(edgeForPoint(frame, 99, 124)).toBe('sw');
        // Both reaches overlap, so the straight edges never appear on this window.
        expect(edgeForPoint(frame, 124, 99)).not.toBe('n');
        expect(edgeForPoint(frame, 99, 124)).not.toBe('w');
    });

    it('keeps the left and right edges on a window that is narrow but tall', () => {
        const frame = rect(100, 100, 40, 600);
        // The top edge has no middle: NW up to left + 24, then NE.
        expect(edgeForPoint(frame, 123, 99)).toBe('nw');
        expect(edgeForPoint(frame, 124, 99)).toBe('ne');
        // The left edge has one, because the height is long enough for two reaches.
        expect(edgeForPoint(frame, 99, 123)).toBe('nw');
        expect(edgeForPoint(frame, 99, 124)).toBe('w');
        expect(edgeForPoint(frame, 99, 676)).toBe('w');   // bottom - 24, still the edge
        expect(edgeForPoint(frame, 99, 677)).toBe('sw');  // one past it, the corner
    });

    it('keeps GTK strict inequality at the right and bottom corner reach', () => {
        // `x > right - 24` and `y > bottom - 24`: the line at exactly right - 24 is the
        // edge, which is the one column the old inclusive rectangles called the corner.
        const frame = rect(100, 100, 400, 300);
        const x = frame.x + frame.width - RESIZE_CORNER;
        expect(edgeForPoint(frame, x, 99)).toBe('n');
        expect(edgeForPoint(frame, x + 1, 99)).toBe('ne');
        const y = frame.y + frame.height - RESIZE_CORNER;
        expect(edgeForPoint(frame, 501, y)).toBe('e');
        expect(edgeForPoint(frame, 501, y + 1)).toBe('se');
    });

    it('reads only the outer ring, never the body', () => {
        const frame = rect(100, 100, 400, 300);
        // GTK's rounded-corner fallback would call a point inside the top-left corner NW.
        expect(edgeForPoint(frame, 105, 105)).toBeNull();
        expect(edgeForPoint(frame, 105, 300)).toBeNull();
        // Beyond the ring, and outside the grown box.
        expect(edgeForPoint(frame, 88, 50)).toBeNull();
        expect(edgeForPoint(frame, 87, 250)).toBeNull();
        expect(edgeForPoint(frame, 250, 37)).toBeNull();
        expect(edgeForPoint(frame, 512, 250)).toBeNull();
    });

    it('restricts directions when axes are vertically or horizontally maximized', () => {
        const frame = rect(100, 100, 400, 300);
        // Vertically maximized (e.g. left/right tiled window):
        // East edge allows 'e' even near corners, suppress vertical directions
        expect(edgeForPoint(frame, 505, 200, {maximizedVertically: true})).toBe('e');
        expect(edgeForPoint(frame, 505, 105, {maximizedVertically: true})).toBe('e');
        expect(edgeForPoint(frame, 505, 395, {maximizedVertically: true})).toBe('e');
        expect(edgeForPoint(frame, 95, 200, {maximizedVertically: true})).toBe('w');
        expect(edgeForPoint(frame, 95, 105, {maximizedVertically: true})).toBe('w');
        expect(edgeForPoint(frame, 95, 395, {maximizedVertically: true})).toBe('w');
        // North / South edges and out-of-bounds corners return null
        expect(edgeForPoint(frame, 300, 95, {maximizedVertically: true})).toBeNull();
        expect(edgeForPoint(frame, 300, 405, {maximizedVertically: true})).toBeNull();
        expect(edgeForPoint(frame, 505, 95, {maximizedVertically: true})).toBeNull();
        expect(edgeForPoint(frame, 505, 405, {maximizedVertically: true})).toBeNull();

        // Horizontally maximized (e.g. top/bottom tiled window):
        expect(edgeForPoint(frame, 300, 95, {maximizedHorizontally: true})).toBe('n');
        expect(edgeForPoint(frame, 105, 95, {maximizedHorizontally: true})).toBe('n');
        expect(edgeForPoint(frame, 495, 95, {maximizedHorizontally: true})).toBe('n');
        expect(edgeForPoint(frame, 300, 405, {maximizedHorizontally: true})).toBe('s');
        expect(edgeForPoint(frame, 105, 405, {maximizedHorizontally: true})).toBe('s');
        expect(edgeForPoint(frame, 495, 405, {maximizedHorizontally: true})).toBe('s');
        // East / West edges and out-of-bounds corners return null
        expect(edgeForPoint(frame, 95, 200, {maximizedHorizontally: true})).toBeNull();
        expect(edgeForPoint(frame, 505, 200, {maximizedHorizontally: true})).toBeNull();
        expect(edgeForPoint(frame, 95, 95, {maximizedHorizontally: true})).toBeNull();
        expect(edgeForPoint(frame, 505, 95, {maximizedHorizontally: true})).toBeNull();

        // Both maximized (fully maximized window):
        expect(edgeForPoint(frame, 505, 200, {maximizedHorizontally: true, maximizedVertically: true})).toBeNull();
        expect(edgeForPoint(frame, 300, 95, {maximizedHorizontally: true, maximizedVertically: true})).toBeNull();
    });

    it('restricts directions according to constrainedEdges on tiled windows', () => {
        const frame = rect(100, 100, 400, 300);

        // Left-tiled window: top, bottom, left are constrained touching work area boundary.
        // Only right edge is resizable ('e').
        const leftTiled = {top: true, bottom: true, left: true, right: false};
        expect(edgeForPoint(frame, 505, 200, {constrainedEdges: leftTiled})).toBe('e');
        expect(edgeForPoint(frame, 505, 105, {constrainedEdges: leftTiled})).toBe('e');
        expect(edgeForPoint(frame, 505, 395, {constrainedEdges: leftTiled})).toBe('e');
        // Out of vertical bounds returns null
        expect(edgeForPoint(frame, 505, 95, {constrainedEdges: leftTiled})).toBeNull();
        expect(edgeForPoint(frame, 505, 405, {constrainedEdges: leftTiled})).toBeNull();
        // Constrained edges return null
        expect(edgeForPoint(frame, 95, 200, {constrainedEdges: leftTiled})).toBeNull();
        expect(edgeForPoint(frame, 300, 95, {constrainedEdges: leftTiled})).toBeNull();
        expect(edgeForPoint(frame, 300, 405, {constrainedEdges: leftTiled})).toBeNull();

        // Right-tiled window: top, bottom, right are constrained.
        // Only left edge is resizable ('w').
        const rightTiled = {top: true, bottom: true, left: false, right: true};
        expect(edgeForPoint(frame, 95, 200, {constrainedEdges: rightTiled})).toBe('w');
        expect(edgeForPoint(frame, 95, 105, {constrainedEdges: rightTiled})).toBe('w');
        expect(edgeForPoint(frame, 95, 395, {constrainedEdges: rightTiled})).toBe('w');
        expect(edgeForPoint(frame, 505, 200, {constrainedEdges: rightTiled})).toBeNull();
        expect(edgeForPoint(frame, 300, 95, {constrainedEdges: rightTiled})).toBeNull();
        expect(edgeForPoint(frame, 300, 405, {constrainedEdges: rightTiled})).toBeNull();

        // Top-left quarter tiled: top and left are constrained.
        // East ('e'), South ('s'), and SE corner ('se') are resizable.
        const topLeftQuarter = {top: true, bottom: false, left: true, right: false};
        expect(edgeForPoint(frame, 95, 200, {constrainedEdges: topLeftQuarter})).toBeNull();
        expect(edgeForPoint(frame, 300, 95, {constrainedEdges: topLeftQuarter})).toBeNull();
        expect(edgeForPoint(frame, 505, 200, {constrainedEdges: topLeftQuarter})).toBe('e');
        expect(edgeForPoint(frame, 300, 405, {constrainedEdges: topLeftQuarter})).toBe('s');
        // SE corner allows diagonal resize
        expect(edgeForPoint(frame, 505, 405, {constrainedEdges: topLeftQuarter})).toBe('se');
        // Top-right area along east resolves to 'e' because top is constrained
        expect(edgeForPoint(frame, 505, 105, {constrainedEdges: topLeftQuarter})).toBe('e');
        // Bottom-left area along south resolves to 's' because left is constrained
        expect(edgeForPoint(frame, 105, 405, {constrainedEdges: topLeftQuarter})).toBe('s');
    });

    it('returns nothing for a degenerate or missing frame', () => {
        expect(edgeForPoint(rect(10, 10, 0, 100), 5, 10)).toBeNull();
        expect(edgeForPoint(rect(10, 10, 100, 0), 10, 5)).toBeNull();
        expect(edgeForPoint(null, 0, 0)).toBeNull();
        expect(edgeForPoint(rect(0, 0, 100, 100), Number.NaN, 0)).toBeNull();
        expect(edgeForPoint(rect(0, 0, 100, 100), 0, Number.POSITIVE_INFINITY)).toBeNull();
    });
});

describe('normalizeConstrainedEdges', () => {
    it('reads the maximize flags as the edges Mutter holds fixed', () => {
        expect(normalizeConstrainedEdges({maximizedVertically: true})).toEqual({
            top: true, right: false, bottom: true, left: false,
        });
        expect(normalizeConstrainedEdges({maximizedHorizontally: true})).toEqual({
            top: false, right: true, bottom: false, left: true,
        });
        // A maximized window reports both flags, and both flags are all four edges.
        expect(normalizeConstrainedEdges({maximizedHorizontally: true, maximizedVertically: true})).toEqual({
            top: true, right: true, bottom: true, left: true,
        });
    });

    it('defaults to no constrained edge', () => {
        expect(normalizeConstrainedEdges()).toEqual({top: false, right: false, bottom: false, left: false});
    });

    it('keeps edges the caller already knows and adds the flags to them', () => {
        expect(normalizeConstrainedEdges({
            constrainedEdges: {top: true, bottom: false, left: false, right: false},
            maximizedHorizontally: true,
        })).toEqual({top: true, right: true, bottom: false, left: true});
    });
});

describe('computeResizeBands', () => {
    it('lays the ring out as four side strips', () => {
        const bands = computeResizeBands({frame: rect(100, 50, 400, 300)});

        // The top and bottom take the full width, corners included; the left and right fill
        // the middle height. The direction is `edgeForPoint()`'s job, not the strip's.
        expect(bands.top).toEqual(rect(88, 38, 424, 12));
        expect(bands.bottom).toEqual(rect(88, 350, 424, 12));
        expect(bands.left).toEqual(rect(88, 50, 12, 300));
        expect(bands.right).toEqual(rect(500, 50, 12, 300));
    });

    it('keeps the four strips pairwise disjoint, so a point is delivered once', () => {
        for (const frame of [rect(10, 20, 61, 43), rect(100, 100, 10, 8), rect(0, 0, 24, 24)]) {
            const bands = computeResizeBands({frame});
            const rects = RESIZE_BAND_REGIONS.map(r => bands[r]).filter(Boolean);
            for (let i = 0; i < rects.length; i++) {
                for (let j = i + 1; j < rects.length; j++)
                    expect(overlapArea(rects[i], rects[j])).toBe(0);
            }
        }
    });

    it('tiles the 12px ring, edge to edge, and nothing beyond it', () => {
        for (const frame of [rect(10, 20, 61, 53), rect(100, 100, 10, 8), rect(0, 0, 24, 24)]) {
            const bands = computeResizeBands({frame});
            const rects = RESIZE_BAND_REGIONS.map(r => bands[r]);

            expect(rects.every(Boolean)).withContext(at(frame, frame.x, frame.y)).toBeTrue();
            const area = rects.reduce((sum, r) => sum + r.width * r.height, 0);
            expect(area).toBe(unionArea(frame));

            // Every sampled point of the expected union is in exactly one strip, and
            // nothing outside it is covered.
            for (let px = frame.x - RESIZE_CORNER; px < frame.x + frame.width + RESIZE_CORNER; px += 1) {
                for (let py = frame.y - RESIZE_CORNER; py < frame.y + frame.height + RESIZE_CORNER; py += 1) {
                    const hits = RESIZE_BAND_REGIONS.filter(r => bands[r] && contains(bands[r], px, py));
                    const expected = inExpectedUnion(frame, px, py) ? 1 : 0;
                    if (hits.length !== expected)
                        fail(`expected ${expected} region at ${at(frame, px, py)}, got ${hits.length}`);
                }
            }
        }
    });

    it('still tiles a window far smaller than two corner reaches', () => {
        const frame = rect(100, 100, 10, 8);
        const bands = computeResizeBands({frame});

        // The strips are pure geometry now, so nothing vanishes; each is 12px deep.
        expect(bands.top).toEqual(rect(88, 88, 34, 12));
        expect(bands.bottom).toEqual(rect(88, 108, 34, 12));
        expect(bands.left).toEqual(rect(88, 100, 12, 8));
        expect(bands.right).toEqual(rect(110, 100, 12, 8));
    });

    it('builds a band for a 24x24 window, the smallest the floor allows', () => {
        const frame = rect(0, 0, 24, 24);
        const bands = computeResizeBands({frame});

        expect(bands.top).toEqual(rect(-12, -12, 48, 12));
        expect(bands.bottom).toEqual(rect(-12, 24, 48, 12));
        expect(bands.left).toEqual(rect(-12, 0, 12, 24));
        expect(bands.right).toEqual(rect(24, 0, 12, 24));
    });

    it('drops every region that falls off the monitor', () => {
        const bounds = rect(0, 0, 1920, 1080);
        const bands = computeResizeBands({frame: rect(0, 0, 400, 300), bounds});

        // Left and top are off screen.
        expect(bands.top).toBeNull();
        expect(bands.left).toBeNull();
        // The on-screen strips survive whole.
        expect(bands.right).toEqual(rect(400, 0, 12, 300));
        expect(bands.bottom).toEqual(rect(0, 300, 412, 12));
    });

    it('clips a region to the monitor edge', () => {
        const bounds = rect(0, 0, 1920, 1080);
        const bands = computeResizeBands({frame: rect(6, 980, 200, 90), bounds});

        // Left and top hang 6px over the edge: clipped, not dropped.
        expect(bands.left).toEqual(rect(0, 980, 6, 90));
        expect(bands.top).toEqual(rect(0, 968, 218, 12));
        expect(bands.right).toEqual(rect(206, 980, 12, 90));
        // Bottom hangs 2px over the bottom edge.
        expect(bands.bottom).toEqual(rect(0, 1070, 218, 10));
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
        expect(whole.top.height).toBe(RESIZE_BAND);
        expect(whole.left.width).toBe(RESIZE_BAND);
    });

    it('refuses a scale that cannot place the regions', () => {
        for (const scale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
            expect(computeResizeBands({frame: rect(0, 0, 100, 100), scale})).toEqual(emptyBands());
    });

    it('suppresses strips along maximized axes', () => {
        const frame = rect(100, 50, 400, 300);

        const vertMax = computeResizeBands({frame, maximizedVertically: true});
        expect(vertMax.top).toBeNull();
        expect(vertMax.bottom).toBeNull();
        expect(vertMax.left).toEqual(rect(88, 50, 12, 300));
        expect(vertMax.right).toEqual(rect(500, 50, 12, 300));

        const horizMax = computeResizeBands({frame, maximizedHorizontally: true});
        expect(horizMax.left).toBeNull();
        expect(horizMax.right).toBeNull();
        expect(horizMax.top).toEqual(rect(88, 38, 424, 12));
        expect(horizMax.bottom).toEqual(rect(88, 350, 424, 12));

        const bothMax = computeResizeBands({
            frame,
            maximizedHorizontally: true,
            maximizedVertically: true,
        });
        expect(bothMax).toEqual(emptyBands());
    });

    it('suppresses strips along constrained edges (tiled windows)', () => {
        const frame = rect(100, 50, 400, 300);

        // Left-tiled window: top, bottom, left are constrained
        const leftTiled = computeResizeBands({
            frame,
            constrainedEdges: {top: true, bottom: true, left: true, right: false},
        });
        expect(leftTiled.top).toBeNull();
        expect(leftTiled.left).toBeNull();
        expect(leftTiled.bottom).toBeNull();
        expect(leftTiled.right).toEqual(rect(500, 50, 12, 300));

        // Right-tiled window: top, bottom, right are constrained
        const rightTiled = computeResizeBands({
            frame,
            constrainedEdges: {top: true, bottom: true, left: false, right: true},
        });
        expect(rightTiled.top).toBeNull();
        expect(rightTiled.right).toBeNull();
        expect(rightTiled.bottom).toBeNull();
        expect(rightTiled.left).toEqual(rect(88, 50, 12, 300));

        // Top-left quarter tiled window: top, left are constrained
        const quarterTiled = computeResizeBands({
            frame,
            constrainedEdges: {top: true, left: true, bottom: false, right: false},
        });
        expect(quarterTiled.top).toBeNull();
        expect(quarterTiled.left).toBeNull();
        expect(quarterTiled.right).toEqual(rect(500, 50, 12, 300));
        expect(quarterTiled.bottom).toEqual(rect(88, 350, 424, 12));
    });

    it('returns nothing for a degenerate or missing frame', () => {
        expect(computeResizeBands({frame: rect(10, 10, 0, 100)})).toEqual(emptyBands());
        expect(computeResizeBands({frame: rect(10, 10, 100, 0)})).toEqual(emptyBands());
        expect(computeResizeBands({frame: null})).toEqual(emptyBands());
        expect(computeResizeBands({})).toEqual(emptyBands());
        expect(computeResizeBands()).toEqual(emptyBands());
    });
});

describe('decideResizeBand', () => {
    // `plain` declares a shadow margin, the ground the band normally lives on; a bare
    // window with no ring is covered below, where the heuristic bands the desktop around it.
    const plain = {frameWidth: 800, frameHeight: 600, allowsResize: true,
        insets: {left: 25, right: 25, top: 25, bottom: 25}};
    const ring = (left, right, top, bottom) => ({...plain, insets: {left, right, top, bottom}});

    it('shows the band on a resizable window that reserves a ring', () => {
        expect(decideResizeBand(plain)).toBeTrue();
    });

    it('a rule can retract the band where the heuristic would draw it', () => {
        expect(decideResizeBand({...plain, reversed: true})).toBeFalse();
    });

    it('keeps the band inside the ring the window declared', () => {
        // The default still asks for a ring: a window that reserves nothing - an undecorated
        // toplevel, a video popup - gets none, and reversing the axis is what gives it the
        // desktop around the body instead. (The GTK4 reading is the other skip, below.)
        expect(decideResizeBand({...ring(0, 0, 0, 0)})).toBeFalse();
        expect(decideResizeBand({...plain})).toBeTrue();
        expect(decideResizeBand({...ring(0, 0, 0, 0), reversed: true})).toBeTrue();
    });

    it('reversing the axis bypasses the GTK4 reading but not physics', () => {
        expect(decideResizeBand({...ring(12, 12, 12, 12), hasGtk4Client: true, reversed: true})).toBeTrue();
        // Capability, never overridable.
        expect(decideResizeBand({...plain, reversed: true, allowsResize: false})).toBeFalse();
        expect(decideResizeBand({...plain, reversed: true, isMaximized: true})).toBeFalse();
        expect(decideResizeBand({...plain, reversed: true, hasSsd: true})).toBeFalse();
        expect(decideResizeBand({...plain, reversed: true, frameWidth: MIN_BAND_WINDOW - 1})).toBeFalse();
    });

    it('gives a bare window the band by rule, not by default', () => {
        // The WPS case: no declared ring, so the default leaves it alone; reversing the
        // resize axis is what gives it the desktop around the body.
        const actions = evaluateWindowActions({
            bufferWidth: 800, bufferHeight: 600, frameWidth: 800, frameHeight: 600,
            isX11: true, wmClass: 'wps',
        });
        expect(actions.drawClip).toBeTrue();
        expect(actions.drawResize).toBeFalse();
        expect(decideResizeBand({...plain, insets: {left: 0, right: 0, top: 0, bottom: 0}})).toBeFalse();
        expect(decideResizeBand({...plain, insets: {left: 0, right: 0, top: 0, bottom: 0}, reversed: true}))
            .toBeTrue();
    });

    it('skips a window that cannot be resized', () => {
        expect(decideResizeBand({...plain, allowsResize: false})).toBeFalse();
    });

    it('skips maximized and fullscreen windows, but keeps tiled and tile-matched windows', () => {
        expect(decideResizeBand({...plain, isMaximized: true})).toBeFalse();
        expect(decideResizeBand({...plain, isFullscreen: true})).toBeFalse();
        // The resize axis is independent of tiling now: a tile match only takes the shadow.
        const tiled = evaluateWindowActions({
            bufferWidth: 850, bufferHeight: 650, frameWidth: 800, frameHeight: 600,
            insets: {left: 25, right: 25, top: 25, bottom: 25},
            tiled: true, hasTileMatch: true, wmClass: 'tiled-app',
        });
        expect(tiled.drawShadow).toBeFalse();
        expect(tiled.drawResize).toBeTrue();
    });

    it('leaves a GTK4 client alone once its declared margins are native', () => {
        // GTK4 sizes the input region from RESIZE_HANDLE_SIZE whatever its shadow is, so
        // declared margins at least that wide mean its own handle is already native.
        expect(decideResizeBand({...ring(12, 12, 12, 12), hasGtk4Client: true})).toBeFalse();
        expect(decideResizeBand({...ring(25, 25, 25, 25), hasGtk4Client: true})).toBeFalse();
    });

    it('keeps the band when the margins cannot prove the client has a handle', () => {
        // GTK3 declares max(box-shadow, decoration margin) + border + padding while the grip it
        // offers is margin + border + padding alone (gtk-3-24 gtkwindow.c), so a theme's shadow
        // inflates the ring past the handle: the ring says nothing about the handle, and the band
        // is what brings a GTK3 window up to native width. The sizes here are ordinary margins.
        expect(decideResizeBand(ring(24, 24, 21, 27))).toBeTrue();
        expect(decideResizeBand(ring(25, 25, 25, 25))).toBeTrue();
        // The same ring a GTK4 client is skipped on, on a client that cannot prove it.
        expect(decideResizeBand(ring(12, 12, 12, 12))).toBeTrue();
    });

    it('skips an SSD window: Mutter drew the frame and runs the resize grab from it', () => {
        expect(decideResizeBand({...plain, hasSsd: true})).toBeFalse();
        // The flag alone is enough; a wide declared ring is not needed for the skip.
        expect(decideResizeBand({...ring(0, 0, 0, 0), hasSsd: true})).toBeFalse();
    });

    it('keeps the band while either axis is narrower than a native handle', () => {
        // One axis already native, the other a hair under: still awkward to grab.
        expect(decideResizeBand({...ring(12, 12, 11, 11), hasGtk4Client: true})).toBeTrue();
        expect(decideResizeBand({...ring(11, 11, 12, 12), hasGtk4Client: true})).toBeTrue();
    });

    it('reads the ring per side, not as the average of the two', () => {
        // TLBR 0,24,0,24 averages 12 on each axis but has no margin on the left or the
        // top, so it is not "12 on every side" and the band stays. An average would hide
        // the zero side and skip the band.
        expect(decideResizeBand(ring(0, 24, 0, 24))).toBeTrue();
        expect(decideResizeBand(ring(24, 0, 24, 0))).toBeTrue();
        // A zero on both sides of one axis, positive only on the other: the narrowest
        // per-axis margin is 0, so the ring is not a native-width handle on every side.
        expect(decideResizeBand(ring(0, 0, 24, 24))).toBeTrue();
        // The symmetric ring of the same total is a native handle on a GTK4 client, and skipped.
        expect(decideResizeBand({...ring(12, 12, 12, 12), hasGtk4Client: true})).toBeFalse();
    });

    it('a fixed-ratio popup keeps its own handle by rule, not by default', () => {
        // A video popup fills its own surface, and a compositor-driven resize cannot
        // track a client that keeps an aspect ratio (measured: the popup ignores
        // requested sizes). Where it reserves a ring the default bands it, so the
        // popup's kind reverses the resize axis instead.
        expect(decideResizeBand({...plain})).toBeTrue();
        expect(decideResizeBand({...plain, reversed: true})).toBeFalse();
        // A window that reserves nothing gets no band of ours by default either.
        expect(decideResizeBand({...ring(0, 0, 0, 0)})).toBeFalse();
        // A window that reserves a margin on one axis only still has that ring to fill.
        expect(decideResizeBand(ring(0, 0, 25, 25))).toBeTrue();
    });

    it('keeps the band on a window only as thin as the ring itself', () => {
        // The floor is the ring's sanity bound (`2 * RESIZE_BAND`), not a native boundary:
        // GTK's input region does not depend on the window size, so a 24px window has a
        // full native grab ring and ours now does too. The old floor of two corner reaches
        // (48px) is gone.
        expect(MIN_BAND_WINDOW).toBe(2 * RESIZE_BAND);
        expect(MIN_BAND_WINDOW).toBe(24);
        expect(decideResizeBand({...plain, frameWidth: MIN_BAND_WINDOW - 1})).toBeFalse();
        expect(decideResizeBand({...plain, frameHeight: MIN_BAND_WINDOW - 1})).toBeFalse();
        expect(decideResizeBand({...plain, frameWidth: MIN_BAND_WINDOW, frameHeight: MIN_BAND_WINDOW}))
            .toBeTrue();
        // The sizes that used to be refused now pass.
        expect(decideResizeBand({...plain, frameWidth: 40, frameHeight: 600})).toBeTrue();
        expect(decideResizeBand({...plain, frameWidth: 30, frameHeight: 30})).toBeTrue();
        expect(decideResizeBand({...plain, frameWidth: 25, frameHeight: 300})).toBeTrue();
    });

    it('does not build a band from a missing frame size', () => {
        expect(decideResizeBand({})).toBeFalse();
        expect(decideResizeBand()).toBeFalse();
    });

    it('a bare window gets no band by default; a reversed axis gives it one', () => {
        const base = {
            bufferWidth: 800, bufferHeight: 600, frameWidth: 800, frameHeight: 600,
            isX11: true, wmClass: 'wps',
        };
        const bare = evaluateWindowActions(base);
        expect([bare.drawShadow, bare.drawClip, bare.drawResize])
            .toEqual([false, true, false]);

        const key = buildRuleKey('wps', {clientType: 'x11'});
        const reversed = evaluateWindowActions({...base, rules: {[key]: 'resize'}});
        expect([reversed.drawShadow, reversed.drawClip, reversed.drawResize])
            .toEqual([false, true, true]);
        expect(reversed.reason).toBe('rule-applied(wps:resize)');
    });
});
