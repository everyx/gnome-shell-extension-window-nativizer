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
import {shouldShowResizeBand, evaluateWindowActions} from '../src/lib/detector.js';

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
 * The band's expected union, stated independently of computeResizeBands: exactly the ring
 * the frame grows by RESIZE_BAND. The corners add nothing outward - GTK's input region stops
 * at RESIZE_HANDLE_SIZE, so the ring is as far as the band can reach - they only take over a
 * 24px length of each edge next to them.
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

        // Each corner is two regions, both 12px deep like the rest of the band: the edge
        // it reaches 24px along (36px wide - 12px of outward ring plus the 24px arm), and
        // the 24px it takes from the other edge.
        expect(bands.nw_n).toEqual(rect(88, 38, 36, 12));
        expect(bands.nw_w).toEqual(rect(88, 50, 12, 24));
        expect(bands.ne_n).toEqual(rect(476, 38, 36, 12));
        expect(bands.ne_e).toEqual(rect(500, 50, 12, 24));
        expect(bands.sw_s).toEqual(rect(88, 350, 36, 12));
        expect(bands.sw_w).toEqual(rect(88, 326, 12, 24));
        expect(bands.se_s).toEqual(rect(476, 350, 36, 12));
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

    it('tiles the 12px ring, edge to edge, and nothing beyond it', () => {
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

    it('gives the whole 24x12 strip hugging an edge next to the corner to the corner', () => {
        const frame = rect(100, 50, 400, 300);
        const bands = computeResizeBands({frame});

        // GTK reads a pointer in an edge's band within RESIZE_HANDLE_CORNER_SIZE (24) of the
        // frame corner as the corner (get_edge_for_coordinates), so the strip 24px long
        // along the edge and 12px deep - the band's full depth - belongs to the corner.
        // Previously the north edge claimed it, and the cursor flipped to N where GTK reads
        // NW; that is the regression this change fixes. Sample it densely: every point of
        // the 24x12 strip is the corner, and the edge only starts at its end.
        for (const [region, edge, x0, y0] of [
            ['nw_n', bands.n, frame.x, frame.y - RESIZE_BAND],
            ['ne_n', bands.n, frame.x + frame.width - RESIZE_CORNER, frame.y - RESIZE_BAND],
            ['sw_s', bands.s, frame.x, frame.y + frame.height],
            ['se_s', bands.s, frame.x + frame.width - RESIZE_CORNER, frame.y + frame.height],
        ]) {
            for (let dx = 0; dx < RESIZE_CORNER; dx++) {
                for (let dy = 0; dy < RESIZE_BAND; dy++) {
                    const px = x0 + dx;
                    const py = y0 + dy;
                    expect(contains(bands[region], px, py)).withContext(`${region} at ${at(frame, px, py)}`).toBeTrue();
                    expect(contains(edge, px, py)).withContext(`edge at ${at(frame, px, py)}`).toBeFalse();
                }
            }
        }
    });

    it('gives the column at right - 24 to the corner, the one column GTK reads as the edge', () => {
        const frame = rect(100, 50, 400, 300);
        const bands = computeResizeBands({frame});

        // GTK's get_edge_for_coordinates tests `x > right - 24` strictly, so the column at
        // exactly right - 24 is the north edge there. Our corner region starts at
        // `right - rx` inclusive, so we call it the corner. The two agree everywhere else;
        // this pins the one-column difference so it cannot drift silently, and records that
        // it is not worth a +1 offset for a single pixel (docs/decoration-model.md § The
        // resize band).
        const x = frame.x + frame.width - RESIZE_CORNER;
        expect(contains(bands.ne_n, x, frame.y - RESIZE_BAND)).toBeTrue();
        expect(contains(bands.n, x, frame.y - RESIZE_BAND)).toBeFalse();

        // Same column on the south edge, and the mirrored row on the right edge.
        const y = frame.y + frame.height - RESIZE_CORNER;
        expect(contains(bands.se_e, frame.x + frame.width, y)).toBeTrue();
        expect(contains(bands.e, frame.x + frame.width, y)).toBeFalse();
    });

    it('leaves the pixels more than 12px out from the frame to the desktop', () => {
        const frame = rect(100, 50, 400, 300);
        const bands = computeResizeBands({frame});

        // GTK builds its CSD input region as the border box grown by RESIZE_HANDLE_SIZE
        // (update_realized_window_properties) and lets clicks outside it go through, so no
        // region may reach further out than 12px - not even beside a corner, where
        // get_edge_for_coordinates would call the point a corner if the input region ever
        // delivered it. This is the invariant the 24px corner blocks broke.
        for (const [px, py] of [
            [frame.x - RESIZE_CORNER, frame.y - 5],
            [frame.x - 5, frame.y - RESIZE_CORNER],
            [frame.x - RESIZE_CORNER, frame.y - RESIZE_CORNER],
            [frame.x - RESIZE_CORNER + 1, frame.y - RESIZE_BAND - 1],
            [frame.x - RESIZE_BAND - 1, frame.y + frame.height / 2],
            [frame.x + frame.width + RESIZE_BAND, frame.y + 5],
            [frame.x + 5, frame.y + frame.height + RESIZE_CORNER],
            [frame.x + frame.width - 5, frame.y + frame.height + RESIZE_BAND + 1],
            [frame.x + frame.width + RESIZE_CORNER, frame.y + frame.height + RESIZE_CORNER],
        ]) {
            const hits = RESIZE_BAND_REGIONS.filter(r => bands[r] && contains(bands[r], px, py));
            expect(hits).withContext(at(frame, px, py)).toEqual([]);
        }
    });

    it('still tiles when the window is smaller than two corner reaches', () => {
        const frame = rect(100, 100, 10, 8);
        const bands = computeResizeBands({frame});
        const rects = RESIZE_BAND_REGIONS.map(r => bands[r]);

        // The edges vanish; the two corner reaches already meet at the midline.
        expect(bands.n).toBeNull();
        expect(bands.s).toBeNull();
        expect(bands.w).toBeNull();
        expect(bands.e).toBeNull();

        // Split at the midline, with neither side negative; the arms are 12px deep.
        expect(bands.nw_n).toEqual(rect(88, 88, 17, 12));
        expect(bands.ne_n).toEqual(rect(105, 88, 17, 12));
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
        expect(bands.se_s).toEqual(rect(376, 300, 36, 12));
        expect(bands.s).toEqual(rect(24, 300, 352, 12));
        expect(bands.sw_s).toEqual(rect(0, 300, 24, 12));
    });

    it('clips a region to the monitor edge', () => {
        const bounds = rect(0, 0, 1920, 1080);
        const bands = computeResizeBands({frame: rect(6, 980, 200, 90), bounds});

        // Left bands hang 6px over the edge: clipped, not dropped.
        expect(bands.w).toEqual(rect(0, 1004, 6, 42));
        expect(bands.nw_w).toEqual(rect(0, 980, 6, 24));
        expect(bands.nw_n).toEqual(rect(0, 968, 30, 12));
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
        expect(whole.nw_n.height).toBe(RESIZE_BAND);
        expect(whole.nw_n.width).toBe(RESIZE_CORNER + RESIZE_BAND);
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

    it('skips a window smaller than two corner reaches', () => {
        expect(MIN_BAND_WINDOW).toBe(2 * RESIZE_CORNER);
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
