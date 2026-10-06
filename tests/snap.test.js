/**
 * Tests for GTK4 grid snapping utilities (snap.js).
 */

import {
    SnapDirection,
    SnapRule,
    snapCoordToGrid,
    snapRectToGrid,
    snapSliceBoxesInto,
} from '../src/lib/snap.js';
import {
    findMetaWindow,
    getPhysicalMonitorScale,
    resolveMonitorBounds,
} from '../src/lib/window.js';

function createMockBox() {
    return {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        init(x1, y1, x2, y2) {
            this.x = x1;
            this.y = y1;
            this.x1 = x1;
            this.y1 = y1;
            this.x2 = x2;
            this.y2 = y2;
            this.width = Math.max(0, x2 - x1);
            this.height = Math.max(0, y2 - y1);
        },
        set_origin(x, y) {
            this.x = x;
            this.y = y;
        },
        set_size(w, h) {
            this.width = w;
            this.height = h;
        },
    };
}

function snapSliceBoxes(cast, corner, scale) {
    const boxes = Array.from({length: 8}, createMockBox);
    return snapSliceBoxesInto(boxes, cast, corner, scale);
}

describe('snapCoordToGrid direction modes', () => {
    it('handles SNAP_EPSILON near integer boundaries for FLOOR', () => {
        // value just slightly below integer should still floor to that integer if within epsilon
        expect(snapCoordToGrid(4.9999, 1.0, SnapDirection.FLOOR)).toBe(5);
        expect(snapCoordToGrid(5.0001, 1.0, SnapDirection.FLOOR)).toBe(5);
        expect(snapCoordToGrid(4.8, 1.0, SnapDirection.FLOOR)).toBe(4);
    });

    it('handles SNAP_EPSILON near integer boundaries for CEIL', () => {
        // value just slightly above integer should ceil to that integer if within epsilon
        expect(snapCoordToGrid(5.0001, 1.0, SnapDirection.CEIL)).toBe(5);
        expect(snapCoordToGrid(4.9999, 1.0, SnapDirection.CEIL)).toBe(5);
        expect(snapCoordToGrid(5.2, 1.0, SnapDirection.CEIL)).toBe(6);
    });

    it('handles ROUND properly with symmetric rounding matching C99 roundf', () => {
        expect(snapCoordToGrid(5.4, 1.0, SnapDirection.ROUND)).toBe(5);
        expect(snapCoordToGrid(5.6, 1.0, SnapDirection.ROUND)).toBe(6);
        expect(snapCoordToGrid(5.0, 1.0, SnapDirection.ROUND)).toBe(5);
        // Half boundaries round strictly away from zero matching C99 roundf
        expect(snapCoordToGrid(1.5, 1.0, SnapDirection.ROUND)).toBe(2);
        expect(snapCoordToGrid(-1.5, 1.0, SnapDirection.ROUND)).toBe(-2);
        expect(snapCoordToGrid(1.501, 1.0, SnapDirection.ROUND)).toBe(2);
        expect(snapCoordToGrid(-1.501, 1.0, SnapDirection.ROUND)).toBe(-2);
        expect(snapCoordToGrid(1.4, 1.0, SnapDirection.ROUND)).toBe(1);
        expect(snapCoordToGrid(-1.4, 1.0, SnapDirection.ROUND)).toBe(-1);
    });
});

describe('SnapRule', () => {
    it('grows outward: floors top/left, ceils bottom/right', () => {
        const rect = {x: 10.4, y: 20.4, width: 100.2, height: 100.2};
        const snapped = snapRectToGrid(rect, 1.0, SnapRule.GROW);
        expect(snapped.x).toBe(10);
        expect(snapped.y).toBe(20);
        expect(snapped.width).toBe(101);
        expect(snapped.height).toBe(101);
    });

    it('rounds edges symmetrically to nearest grid line', () => {
        const rect = {x: 10.4, y: 20.6, width: 100.2, height: 100.2};
        const snapped = snapRectToGrid(rect, 1.0, SnapRule.ROUND);
        expect(snapped.x).toBe(10);
        expect(snapped.y).toBe(21);
        // x2 = 10.4 + 100.2 = 110.6 -> 111. width = 111 - 10 = 101
        expect(snapped.width).toBe(101);
        // y2 = 20.6 + 100.2 = 120.8 -> 121. height = 121 - 21 = 100
        expect(snapped.height).toBe(100);
    });

    it('locks phase with shadow slice boxes under fractional scale (4/3)', () => {
        const scale = 4.0 / 3.0;
        const rect = {x: 26.0, y: 23.0, width: 501.0, height: 400.0};
        const snapped = snapRectToGrid(rect, scale, SnapRule.ROUND);

        // SnapCoordToGrid(26.0, 4/3, ROUND) = round(34.6667) / (4/3) = 35 / (4/3) = 26.25
        expect(snapped.x).toBeCloseTo(26.25, 4);
        expect(snapped.x * scale).toBe(35);

        // Verify shadow box left edge precisely matches snapped.x
        const boxes = snapSliceBoxes(rect, 32, scale);
        // Left edge slice is boxes[6]
        expect(boxes[6].x).toBeCloseTo(snapped.x, 4);
        expect(boxes[6].x1).toBeCloseTo(snapped.x, 4);
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

    it('bypasses snapping when scale <= 0', () => {
        expect(snapCoordToGrid(10.33, 0, SnapDirection.ROUND)).toBe(10.33);
        expect(snapCoordToGrid(10.33, -1, SnapDirection.ROUND)).toBe(10.33);
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

    it('guarantees seamless alignment on fractional and high-DPI scales (1.25x - 3.0x)', () => {
        for (const scale of [1.25, 1.3333, 1.5, 1.75, 2.0, 2.25, 2.5, 3.0]) {
            const cast = {x: 12.3, y: 18.7, width: 456.7, height: 289.4};
            const boxes = snapSliceBoxes(cast, 45, scale);

            // Zero seam tolerance: exact cutline equality
            expect(boxes[0].x2).toBe(boxes[4].x1);
            expect(boxes[4].x2).toBe(boxes[1].x1);

            expect(boxes[2].x2).toBe(boxes[5].x1);
            expect(boxes[5].x2).toBe(boxes[3].x1);

            expect(boxes[0].y2).toBe(boxes[6].y1);
            expect(boxes[6].y2).toBe(boxes[2].y1);

            expect(boxes[1].y2).toBe(boxes[7].y1);
            expect(boxes[7].y2).toBe(boxes[3].y1);

            // Double arithmetic consistency (within IEEE-754 epsilon)
            expect(boxes[0].x + boxes[0].width).toBeCloseTo(boxes[4].x, 10);
            expect(boxes[4].x + boxes[4].width).toBeCloseTo(boxes[1].x, 10);

            expect(boxes[2].x + boxes[2].width).toBeCloseTo(boxes[5].x, 10);
            expect(boxes[5].x + boxes[5].width).toBeCloseTo(boxes[3].x, 10);

            expect(boxes[0].y + boxes[0].height).toBeCloseTo(boxes[6].y, 10);
            expect(boxes[6].y + boxes[6].height).toBeCloseTo(boxes[2].y, 10);

            expect(boxes[1].y + boxes[1].height).toBeCloseTo(boxes[7].y, 10);
            expect(boxes[7].y + boxes[7].height).toBeCloseTo(boxes[3].y, 10);
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

    it('prefers box.init when available to eliminate 32-bit float rounding seams', () => {
        const initCalls = [];
        const existingBoxes = Array.from({length: 8}, () => ({
            init(x1, y1, x2, y2) {
                initCalls.push({x1, y1, x2, y2});
            },
        }));

        const cast = {x: 10, y: 20, width: 400, height: 300};
        snapSliceBoxesInto(existingBoxes, cast, 30, 1.25);

        expect(initCalls.length).toBe(8);
        // Corner-TL right edge matches Top-Edge left edge exactly
        expect(initCalls[0].x2).toBe(initCalls[4].x1);
        // Top-Edge right edge matches Corner-TR left edge exactly
        expect(initCalls[4].x2).toBe(initCalls[1].x1);
    });

    it('safely clamps degenerate or negative window sizes without coordinate inversion', () => {
        const boxes = snapSliceBoxes({x: 10, y: 10, width: -50, height: 0}, 45, 1.0);
        for (const box of boxes) {
            expect(box.width).toBe(0);
            expect(box.height).toBe(0);
        }
    });

    it('enforces monotonic ordering preventing coordinate inversion on floating-point non-associativity', () => {
        // cast where IEEE-754 non-associativity at 1.75x would cause (cast.x + c) to round to 1774
        // and (cast.x + width - c) to round to 1773, causing a 1-pixel coordinate inversion without sx2 = Math.max(sx1, x2)
        const cast = {x: 1000.333, y: 0, width: 26.19, height: 100};
        const boxes = snapSliceBoxes(cast, 25, 1.75);

        // Top edge and bottom edge slice widths must be clamped to 0, never negative
        expect(boxes[4].width).toBe(0);
        expect(boxes[5].width).toBe(0);

        // Slices must maintain monotonic non-decreasing order: x1 <= x2
        expect(boxes[0].x2).toBe(boxes[1].x1);
        expect(boxes[2].x2).toBe(boxes[3].x1);
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

    it('falls back to fallback scale when display query is unavailable', () => {
        const fakeActor = {
            get_parent: () => null,
        };
        const hadGlobal = 'global' in globalThis;
        const oldGlobal = globalThis.global;
        try {
            delete globalThis.global;
            expect(getPhysicalMonitorScale(fakeActor, 1.25)).toBe(1.25);
            expect(getPhysicalMonitorScale(null, 1.0)).toBe(1.0);
        } finally {
            if (hadGlobal)
                globalThis.global = oldGlobal;
        }
    });

    it('resolves monitor scale by climbing parent hierarchy from child surface actor', () => {
        const fakeMetaWindow = {
            get_monitor: () => 2,
        };
        const windowActor = {
            meta_window: fakeMetaWindow,
            get_parent: () => null,
        };
        const surfaceContainer = {
            get_parent: () => windowActor,
        };
        const surfaceActor = {
            get_parent: () => surfaceContainer,
        };

        const hadGlobal = 'global' in globalThis;
        const oldGlobal = globalThis.global;
        try {
            globalThis.global = {
                display: {
                    get_monitor_scale: (mon) => (mon === 2 ? 1.5 : 1.0),
                },
            };

            // Climbing from surfaceActor should find windowActor and return true fractional scale (1.5)
            expect(getPhysicalMonitorScale(surfaceActor)).toBe(1.5);
        } finally {
            if (hadGlobal)
                globalThis.global = oldGlobal;
            else
                delete globalThis.global;
        }
    });

    it('safely handles deallocated window or invalid monitor errors without throwing', () => {
        const throwingWindow = {
            get_monitor: () => {
                throw new Error('Object MetaWindow has been already deallocated');
            },
        };
        const actorWithFreedWin = {
            meta_window: throwingWindow,
        };

        expect(getPhysicalMonitorScale(actorWithFreedWin, 1.0)).toBe(1.0);

        // Display scale throwing error on stale monitor
        const hadGlobal = 'global' in globalThis;
        const oldGlobal = globalThis.global;
        try {
            globalThis.global = {
                display: {
                    get_monitor_scale: () => {
                        throw new Error('Invalid monitor index');
                    },
                },
            };
            const validWinActor = {
                meta_window: {get_monitor: () => 5},
            };
            expect(getPhysicalMonitorScale(validWinActor, 1.0)).toBe(1.0);
        } finally {
            if (hadGlobal)
                globalThis.global = oldGlobal;
            else
                delete globalThis.global;
        }
    });

    it('defends against out-of-bounds monitor index on display topology change', () => {
        let called = false;
        const fakeActor = {
            meta_window: {get_monitor: () => 2}, // Stale monitor index 2
        };
        const hadGlobal = 'global' in globalThis;
        const oldGlobal = globalThis.global;
        try {
            globalThis.global = {
                display: {
                    get_n_monitors: () => 2, // Only monitors 0 and 1 are valid
                    get_monitor_scale: () => {
                        called = true;
                        return 2.0;
                    },
                },
            };
            // Should not call get_monitor_scale with out-of-bounds index 2
            expect(getPhysicalMonitorScale(fakeActor, 1.0)).toBe(1.0);
            expect(called).toBe(false);
        } finally {
            if (hadGlobal)
                globalThis.global = oldGlobal;
            else
                delete globalThis.global;
        }
    });
});

describe('findMetaWindow', () => {
    it('returns window directly when get_monitor and get_frame_rect exist', () => {
        const win = {get_monitor: () => 0, get_frame_rect: () => ({})};
        expect(findMetaWindow(win)).toBe(win);
    });

    it('ignores intermediate actors even if they have get_monitor and get_frame_rect', () => {
        const realWin = {id: 'real-window'};
        const fakeIntermediateActor = {
            get_monitor: () => 999,
            get_frame_rect: () => ({}),
            get_parent: () => ({get_meta_window: () => realWin}),
        };
        expect(findMetaWindow(fakeIntermediateActor)).toBe(realWin);
    });

    it('retrieves meta_window from actor property or get_meta_window method', () => {
        const win = {id: 'win1'};
        expect(findMetaWindow({meta_window: win})).toBe(win);
        expect(findMetaWindow({metaWindow: win})).toBe(win);
        expect(findMetaWindow({get_meta_window: () => win})).toBe(win);
        expect(findMetaWindow({_windowActor: {get_meta_window: () => win}})).toBe(win);
    });

    it('climbs parent chain to find MetaWindowActor', () => {
        const win = {id: 'win-ancestor'};
        const root = {get_meta_window: () => win, get_parent: () => null};
        const child1 = {get_parent: () => root};
        const child2 = {get_parent: () => child1};
        const child3 = {get_parent: () => child2};

        expect(findMetaWindow(child3)).toBe(win);
    });

    it('handles thrown deallocation errors gracefully without crashing', () => {
        const deallocatedChild = {
            get_parent: () => {
                throw new Error('Object ClutterActor has been already deallocated');
            },
        };
        expect(findMetaWindow(deallocatedChild)).toBeNull();
    });

    it('returns null when parent chain terminates without window or exceeds maxDepth', () => {
        const orphan = {get_parent: () => null};
        expect(findMetaWindow(orphan)).toBeNull();
        expect(findMetaWindow(null)).toBeNull();

        // Chain longer than maxDepth
        let node = {meta_window: {id: 'deep'}};
        for (let i = 0; i < 10; i++)
            node = {get_parent: () => node};
        expect(findMetaWindow(node, 5)).toBeNull();
    });
});

describe('resolveMonitorBounds', () => {
    it('returns the rect for an in-range monitor', () => {
        const rect = {x: 0, y: 0, width: 1920, height: 1080};
        const display = {
            get_n_monitors: () => 2,
            get_monitor_geometry: mon => (mon === 1 ? rect : null),
        };
        expect(resolveMonitorBounds(display, {get_monitor: () => 1})).toBe(rect);
    });

    it('returns null for a stale index after a monitor is unplugged', () => {
        // The window still reports monitor 1, but the display now has only one monitor;
        // the geometry macro must never be reached or Mutter logs a CRITICAL.
        const display = {
            get_n_monitors: () => 1,
            get_monitor_geometry: () => {
                throw new Error('mutter-CRITICAL: get_monitor_geometry with out-of-range monitor');
            },
        };
        expect(resolveMonitorBounds(display, {get_monitor: () => 1})).toBeNull();
    });

    it('returns null when the window has no monitor or the display lacks the query', () => {
        const display = {get_n_monitors: () => 1, get_monitor_geometry: () => ({})};
        expect(resolveMonitorBounds(display, {})).toBeNull();
        expect(resolveMonitorBounds(null, {get_monitor: () => 0})).toBeNull();
    });
});
