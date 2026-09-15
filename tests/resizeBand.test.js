/**
 * resize band geometry, direction and eligibility unit tests (jasmine-gjs).
 * Run: pnpm test
 */

import {
    computeResizeBands,
    edgeForPoint,
    MIN_BAND_WINDOW,
    RESIZE_BAND,
    RESIZE_BAND_REGIONS,
    RESIZE_CORNER,
} from '../src/lib/resizeBand.js';
import {shouldShowResizeBand, evaluateWindowActions} from '../src/lib/detector.js';

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

    it('returns nothing for a degenerate or missing frame', () => {
        expect(edgeForPoint(rect(10, 10, 0, 100), 5, 10)).toBeNull();
        expect(edgeForPoint(rect(10, 10, 100, 0), 10, 5)).toBeNull();
        expect(edgeForPoint(null, 0, 0)).toBeNull();
        expect(edgeForPoint(rect(0, 0, 100, 100), Number.NaN, 0)).toBeNull();
        expect(edgeForPoint(rect(0, 0, 100, 100), 0, Number.POSITIVE_INFINITY)).toBeNull();
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
    const ring = (left, right, top, bottom) => ({...plain, insets: {left, right, top, bottom}});

    it('shows the band on a plain resizable window', () => {
        expect(shouldShowResizeBand(plain)).toBeTrue();
    });

    it('builds nothing when the setting is off', () => {
        expect(shouldShowResizeBand({...plain, resizeBand: false})).toBeFalse();
    });

    it('drops the band when we draw nothing on the window', () => {
        // The band follows the decoration: a `none` rule (or a structurally ineligible
        // window) means the window keeps every click it had.
        expect(shouldShowResizeBand({...plain, decorated: false})).toBeFalse();
    });

    it('keeps the band on a bare X11 window, whose clip the detector still draws', () => {
        // The WeChat/CEF case: no declared ring, so the shadow stays Mutter's, but the
        // corners are ours (drawClip true) and the band must stay with them.
        const actions = evaluateWindowActions({
            bufferWidth: 800, bufferHeight: 600, frameWidth: 800, frameHeight: 600,
            isX11: true, wmClass: 'wechat',
        });
        expect(actions.drawClip).toBeTrue();
        expect(shouldShowResizeBand({
            ...plain,
            insets: {left: 0, right: 0, top: 0, bottom: 0},
            decorated: actions.drawShadow || actions.drawClip,
        })).toBeTrue();
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

    it('skips an SSD window: Mutter drew the frame and runs the resize grab from it', () => {
        expect(shouldShowResizeBand({...plain, hasSsd: true})).toBeFalse();
        // The flag alone is enough; a wide declared ring is not needed for the skip.
        expect(shouldShowResizeBand({...ring(0, 0, 0, 0), hasSsd: true})).toBeFalse();
    });

    it('skips a window whose declared margin is already a native-width handle', () => {
        // 12px on every side is GTK4's RESIZE_HANDLE_SIZE floor.
        expect(shouldShowResizeBand(ring(12, 12, 12, 12))).toBeFalse();
        expect(shouldShowResizeBand(ring(25, 25, 25, 25))).toBeFalse();
    });

    it('keeps the band while either axis is narrower than a native handle', () => {
        // One axis already native, the other a hair under: still awkward to grab.
        expect(shouldShowResizeBand(ring(12, 12, 11, 11))).toBeTrue();
        expect(shouldShowResizeBand(ring(11, 11, 12, 12))).toBeTrue();
    });

    it('reads the ring per side, not as the average of the two', () => {
        // TLBR 0,24,0,24 averages 12 on each axis but has no margin on the left or the
        // top, so it is not "12 on every side" and the band stays. An average would hide
        // the zero side and skip the band.
        expect(shouldShowResizeBand(ring(0, 24, 0, 24))).toBeTrue();
        expect(shouldShowResizeBand(ring(24, 0, 24, 0))).toBeTrue();
        // A zero on both sides of one axis, positive only on the other: the narrowest
        // per-axis margin is 0, so the ring is not a native-width handle on every side.
        expect(shouldShowResizeBand(ring(0, 0, 24, 24))).toBeTrue();
        // The symmetric ring of the same total is a native handle and is skipped.
        expect(shouldShowResizeBand(ring(12, 12, 12, 12))).toBeFalse();
    });

    it('does not read a margin when the window has no ring at all', () => {
        expect(shouldShowResizeBand(ring(0, 0, 0, 0))).toBeTrue();
        expect(shouldShowResizeBand({...plain, bufferWidth: 800, bufferHeight: 600})).toBeTrue();
    });

    it('keeps the band on a window only as thin as the ring itself', () => {
        // The floor is the ring's sanity bound (`2 * RESIZE_BAND`), not a native boundary:
        // GTK's input region does not depend on the window size, so a 24px window has a
        // full native grab ring and ours now does too. The old floor of two corner reaches
        // (48px) is gone.
        expect(MIN_BAND_WINDOW).toBe(2 * RESIZE_BAND);
        expect(MIN_BAND_WINDOW).toBe(24);
        expect(shouldShowResizeBand({...plain, frameWidth: MIN_BAND_WINDOW - 1})).toBeFalse();
        expect(shouldShowResizeBand({...plain, frameHeight: MIN_BAND_WINDOW - 1})).toBeFalse();
        expect(shouldShowResizeBand({...plain, frameWidth: MIN_BAND_WINDOW, frameHeight: MIN_BAND_WINDOW}))
            .toBeTrue();
        // The sizes that used to be refused now pass.
        expect(shouldShowResizeBand({...plain, frameWidth: 40, frameHeight: 600})).toBeTrue();
        expect(shouldShowResizeBand({...plain, frameWidth: 30, frameHeight: 30})).toBeTrue();
        expect(shouldShowResizeBand({...plain, frameWidth: 25, frameHeight: 300})).toBeTrue();
    });

    it('does not build a band from a missing frame size', () => {
        expect(shouldShowResizeBand({resizeBand: true})).toBeFalse();
        expect(shouldShowResizeBand()).toBeFalse();
    });
});
