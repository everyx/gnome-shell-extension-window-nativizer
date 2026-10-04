/**
 * Shadow geometry unit tests: slice ordering under degenerate window sizes (jasmine-gjs).
 * Run: pnpm test
 */

import {shadowGeometry, shadowSlices, SHADOW_PAD} from '../src/effects/shadowGeometry.js';

describe('shadowGeometry', () => {
    it('sizes the bake buffer from pad, radius and the Cogl offscreen padding', () => {
        const {corner, window, buffer} = shadowGeometry(12);
        expect(corner).toBe(2 * SHADOW_PAD + 12);
        expect(window).toBe(2 * (SHADOW_PAD + 12));
        expect(buffer).toBeGreaterThan(window);
    });

    it('guarantees seamless texture coordinate continuity at slice junctions', () => {
        const geometry = shadowGeometry(15);
        const slices = shadowSlices(geometry, 800, 600);
        // At the junction between corner and edge slices, texture coordinates meet at
        // the settled midpoint (edge), guaranteeing C0 continuity across quads
        expect(slices[0].s2).toBeCloseTo(slices[4].s1, 6);
        expect(slices[1].s1).toBeCloseTo(slices[4].s1, 6);
        expect(slices[2].s2).toBeCloseTo(slices[5].s1, 6);
        expect(slices[3].s1).toBeCloseTo(slices[5].s1, 6);

        expect(slices[0].t2).toBeCloseTo(slices[6].t1, 6);
        expect(slices[2].t1).toBeCloseTo(slices[6].t1, 6);
        expect(slices[1].t2).toBeCloseTo(slices[7].t1, 6);
        expect(slices[3].t1).toBeCloseTo(slices[7].t1, 6);
    });
});

describe('shadowSlices', () => {
    const expectOrdered = boxes => {
        expect(boxes.length).toBe(8);
        for (const b of boxes) {
            expect(b.x1).toBeLessThanOrEqual(b.x2);
            expect(b.y1).toBeLessThanOrEqual(b.y2);
            expect(b.s1).toBeLessThanOrEqual(b.s2);
            expect(b.t1).toBeLessThanOrEqual(b.t2);
        }
    };

    it('keeps every slice ordered for degenerate and negative cast sizes', () => {
        for (const [w, h] of [[0, 0], [1, 1], [0, 50], [50, 0], [3, 2], [-5, -5], [4, -1]])
            expectOrdered(shadowSlices(shadowGeometry(12), w, h));
    });

    it('clamps the corner to half the smaller side so corners never cross', () => {
        const boxes = shadowSlices(shadowGeometry(100), 10, 4);
        // corner = min(pad+100, 10/2, 4/2) = 2
        expect(boxes[0].x2).toBe(2);
        expect(boxes[0].y2).toBe(2);
        // each corner meets its two edge strips with no gap and no overlap
        expect(boxes[0].x2).toBe(boxes[4].x1); // top-left corner -> top edge strip
        expect(boxes[0].y2).toBe(boxes[6].y1); // top-left corner -> left edge strip
        expect(boxes[1].x1).toBe(boxes[4].x2); // top edge strip -> top-right corner
        expect(boxes[2].y1).toBe(boxes[6].y2); // left edge strip -> bottom-left corner
    });

    it('places the four corners at their baked positions for a full-size window', () => {
        const {corner} = shadowGeometry(12);
        const boxes = shadowSlices(shadowGeometry(12), 400, 300);
        expect(boxes[0].x2).toBe(corner);
        expect(boxes[1].x1).toBe(400 - corner);
        expect(boxes[2].y1).toBe(300 - corner);
    });
});
