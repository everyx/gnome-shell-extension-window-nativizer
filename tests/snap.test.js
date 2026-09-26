/**
 * Tests for GTK4 grid snapping utilities (snap.js).
 */

import {
    SNAP_EPSILON,
    SnapDirection,
    SnapRule,
    snapDirection,
    snapCoordToGrid,
    snapRuleGetDirection,
    snapRectToGrid,
    snapSliceBoxes,
    snapSliceBoxesInto,
    getPhysicalMonitorScale,
} from '../src/lib/snap.js';

describe('snapDirection', () => {
    it('defines GTK standard SNAP_EPSILON', () => {
        expect(SNAP_EPSILON).toBe(0.001);
    });

    it('handles SNAP_EPSILON near integer boundaries for FLOOR', () => {
        // value just slightly below integer should still floor to that integer if within epsilon
        expect(snapDirection(4.9999, SnapDirection.FLOOR)).toBe(5);
        expect(snapDirection(5.0001, SnapDirection.FLOOR)).toBe(5);
        expect(snapDirection(4.8, SnapDirection.FLOOR)).toBe(4);
    });

    it('handles SNAP_EPSILON near integer boundaries for CEIL', () => {
        // value just slightly above integer should ceil to that integer if within epsilon
        expect(snapDirection(5.0001, SnapDirection.CEIL)).toBe(5);
        expect(snapDirection(4.9999, SnapDirection.CEIL)).toBe(5);
        expect(snapDirection(5.2, SnapDirection.CEIL)).toBe(6);
    });

    it('handles ROUND properly', () => {
        expect(snapDirection(5.4, SnapDirection.ROUND)).toBe(5);
        expect(snapDirection(5.6, SnapDirection.ROUND)).toBe(6);
        expect(snapDirection(5.0, SnapDirection.ROUND)).toBe(5);
    });

    it('returns original value for NONE', () => {
        expect(snapDirection(5.4321, SnapDirection.NONE)).toBe(5.4321);
    });
});

describe('snapRuleGetDirection', () => {
    it('decodes GTK GSK_RECT_SNAP_GROW correctly', () => {
        expect(snapRuleGetDirection(SnapRule.GROW, 0)).toBe(SnapDirection.FLOOR); // TOP
        expect(snapRuleGetDirection(SnapRule.GROW, 1)).toBe(SnapDirection.CEIL);  // RIGHT
        expect(snapRuleGetDirection(SnapRule.GROW, 2)).toBe(SnapDirection.CEIL);  // BOTTOM
        expect(snapRuleGetDirection(SnapRule.GROW, 3)).toBe(SnapDirection.FLOOR); // LEFT
    });

    it('decodes GTK GSK_RECT_SNAP_SHRINK correctly', () => {
        expect(snapRuleGetDirection(SnapRule.SHRINK, 0)).toBe(SnapDirection.CEIL);  // TOP
        expect(snapRuleGetDirection(SnapRule.SHRINK, 1)).toBe(SnapDirection.FLOOR); // RIGHT
        expect(snapRuleGetDirection(SnapRule.SHRINK, 2)).toBe(SnapDirection.FLOOR); // BOTTOM
        expect(snapRuleGetDirection(SnapRule.SHRINK, 3)).toBe(SnapDirection.CEIL);  // LEFT
    });

    it('decodes GTK GSK_RECT_SNAP_ROUND correctly', () => {
        for (let side = 0; side < 4; side++)
            expect(snapRuleGetDirection(SnapRule.ROUND, side)).toBe(SnapDirection.ROUND);
    });
});

describe('snapCoordToGrid', () => {
    it('returns exact values when already aligned at 1.0x', () => {
        expect(snapCoordToGrid(100, 1.0, SnapDirection.ROUND)).toBe(100);
        expect(snapCoordToGrid(250, 1.0, SnapDirection.FLOOR)).toBe(250);
    });

    it('snaps fractional coordinates to physical grid at 1.25x (grid step = 0.8)', () => {
        // At scale 1.25, physical pixel step in logical units is 1 / 1.25 = 0.8.
        // 10.3 * 1.25 = 12.875 -> round is 13 -> 13 / 1.25 = 10.4.
        expect(snapCoordToGrid(10.3, 1.25, SnapDirection.ROUND)).toBe(10.4);
    });

    it('snaps fractional coordinates to physical grid at 1.5x (grid step = 2/3)', () => {
        // At scale 1.5, 10.0 * 1.5 = 15 -> 10.0
        // 10.2 * 1.5 = 15.3 -> round is 15 -> 15 / 1.5 = 10.0
        expect(snapCoordToGrid(10.2, 1.5, SnapDirection.ROUND)).toBe(10.0);
        // 10.5 * 1.5 = 15.75 -> round is 16 -> 16 / 1.5 = 10.666666...
        expect(snapCoordToGrid(10.5, 1.5, SnapDirection.ROUND)).toBeCloseTo(10.6667, 3);
    });

    it('bypasses snapping when scale <= 0 or direction is NONE', () => {
        expect(snapCoordToGrid(10.33, 0, SnapDirection.ROUND)).toBe(10.33);
        expect(snapCoordToGrid(10.33, -1, SnapDirection.ROUND)).toBe(10.33);
        expect(snapCoordToGrid(10.33, 1.25, SnapDirection.NONE)).toBe(10.33);
    });
});

describe('snapRectToGrid', () => {
    it('preserves integer rects at 1.0x scale', () => {
        const rect = {x: 10, y: 20, width: 300, height: 200};
        const snapped = snapRectToGrid(rect, 1.0, SnapRule.ROUND);
        expect(snapped).toEqual(rect);
    });

    it('aligns fractional rects to grid at fractional scale', () => {
        const rect = {x: 10.1, y: 20.3, width: 300.5, height: 199.7};
        const snapped = snapRectToGrid(rect, 1.25, SnapRule.ROUND);

        // x: 10.1 * 1.25 = 12.625 -> round 13 -> 10.4
        expect(snapped.x).toBe(10.4);
        // y: 20.3 * 1.25 = 25.375 -> round 25 -> 20.0
        expect(snapped.y).toBe(20.0);

        // Right edge: (10.1 + 300.5) = 310.6 * 1.25 = 388.25 -> round 388 -> 310.4
        // width = 310.4 - 10.4 = 300.0
        expect(snapped.width).toBeCloseTo(300.0, 4);

        // Bottom edge: (20.3 + 199.7) = 220.0 * 1.25 = 275 -> 220.0
        // height = 220.0 - 20.0 = 200.0
        expect(snapped.height).toBeCloseTo(200.0, 4);
    });
});

describe('snapSliceBoxes', () => {
    it('produces 8 contiguous boxes with zero seams on integer scale', () => {
        const cast = {x: 10, y: 20, width: 500, height: 300};
        const boxes = snapSliceBoxes(cast, 45, 1.0);

        expect(boxes.length).toBe(8);

        // Top edge: corner-TL (0) right matches edge-top (4) left
        expect(boxes[0].x + boxes[0].width).toBe(boxes[4].x);
        // Top edge: edge-top (4) right matches corner-TR (1) left
        expect(boxes[4].x + boxes[4].width).toBe(boxes[1].x);

        // Bottom edge: corner-BL (2) right matches edge-bottom (5) left
        expect(boxes[2].x + boxes[2].width).toBe(boxes[5].x);
        // Bottom edge: edge-bottom (5) right matches corner-BR (3) left
        expect(boxes[5].x + boxes[5].width).toBe(boxes[3].x);

        // Left edge: corner-TL (0) bottom matches edge-left (6) top
        expect(boxes[0].y + boxes[0].height).toBe(boxes[6].y);
        // Left edge: edge-left (6) bottom matches corner-BL (2) top
        expect(boxes[6].y + boxes[6].height).toBe(boxes[2].y);

        // Right edge: corner-TR (1) bottom matches edge-right (7) top
        expect(boxes[1].y + boxes[1].height).toBe(boxes[7].y);
        // Right edge: edge-right (7) bottom matches corner-BR (3) top
        expect(boxes[7].y + boxes[7].height).toBe(boxes[3].y);
    });

    it('guarantees seamless alignment on fractional scale (1.25x / 1.5x)', () => {
        for (const scale of [1.25, 1.3333, 1.5, 1.75, 2.0]) {
            const cast = {x: 12.3, y: 18.7, width: 456.7, height: 289.4};
            const boxes = snapSliceBoxes(cast, 45, scale);

            // Zero seam tolerance (exact IEEE-754 equality on shared cutline)
            expect(boxes[0].x + boxes[0].width).toBe(boxes[4].x);
            expect(boxes[4].x + boxes[4].width).toBe(boxes[1].x);

            expect(boxes[2].x + boxes[2].width).toBe(boxes[5].x);
            expect(boxes[5].x + boxes[5].width).toBe(boxes[3].x);

            expect(boxes[0].y + boxes[0].height).toBe(boxes[6].y);
            expect(boxes[6].y + boxes[6].height).toBe(boxes[2].y);

            expect(boxes[1].y + boxes[1].height).toBe(boxes[7].y);
            expect(boxes[7].y + boxes[7].height).toBe(boxes[3].y);
        }
    });

    it('mutates boxes in place with zero allocation via snapSliceBoxesInto', () => {
        const existingBoxes = Array.from({length: 8}, () => ({
            x: -1, y: -1, width: -1, height: -1,
            set_origin(x, y) { this.x = x; this.y = y; },
            set_size(w, h) { this.width = w; this.height = h; },
        }));

        const cast = {x: 10, y: 20, width: 400, height: 300};
        const returned = snapSliceBoxesInto(existingBoxes, cast, 30, 1.25);

        expect(returned).toBe(existingBoxes);
        expect(existingBoxes[0].x).toBe(10.4);
        expect(existingBoxes[0].y).toBe(20.0);
        expect(existingBoxes[0].width).toBeCloseTo(29.6, 4);
    });

    it('safely clamps degenerate or negative window sizes without coordinate inversion', () => {
        const boxes = snapSliceBoxes({x: 10, y: 10, width: -50, height: 0}, 45, 1.0);
        for (const box of boxes) {
            expect(box.width).toBe(0);
            expect(box.height).toBe(0);
        }
    });
});

describe('scale edge cases and robustness', () => {
    it('handles non-numeric, zero, and infinite scales safely', () => {
        for (const badScale of [0, -1, -2.5, NaN, undefined, null, Infinity, -Infinity]) {
            expect(snapCoordToGrid(15.75, badScale)).toBe(15.75);

            const rect = {x: 10.5, y: 20.5, width: 100.5, height: 80.5};
            expect(snapRectToGrid(rect, badScale)).toEqual(rect);
        }
    });
});

describe('getPhysicalMonitorScale', () => {
    it('reads monitor scale from global.display when available', () => {
        const fakeMetaWindow = {
            get_monitor: () => 1,
        };
        const fakeActor = {
            meta_window: fakeMetaWindow,
            get_resource_scale: () => 2.0, // Ceil'd integer
        };

        const hadGlobal = 'global' in globalThis;
        const oldGlobal = globalThis.global;
        try {
            globalThis.global = {
                display: {
                    get_monitor_scale: (mon) => (mon === 1 ? 1.25 : 1.0),
                },
            };

            // Must return true fractional monitor scale (1.25), not ceil'd resource scale (2.0)
            expect(getPhysicalMonitorScale(fakeActor)).toBe(1.25);
        } finally {
            if (hadGlobal)
                globalThis.global = oldGlobal;
            else
                delete globalThis.global;
        }
    });

    it('falls back to resource_scale when display query is unavailable', () => {
        const fakeActor = {
            get_resource_scale: () => 1.5,
        };
        const hadGlobal = 'global' in globalThis;
        const oldGlobal = globalThis.global;
        try {
            delete globalThis.global;
            expect(getPhysicalMonitorScale(fakeActor)).toBe(1.5);
            expect(getPhysicalMonitorScale(null, 1.0)).toBe(1.0);
        } finally {
            if (hadGlobal)
                globalThis.global = oldGlobal;
        }
    });
});
