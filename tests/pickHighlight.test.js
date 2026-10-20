/**
 * The picker's highlight geometry: the border's outset box, its concentric corner, and the radius the
 * highlighted window is expected to show (jasmine-gjs).
 * Run: pnpm test
 */

import {ADWAITA_STYLE} from '../src/lib/adwaitaStyle.generated.js';
import {
    HIGHLIGHT_BORDER_WIDTH,
    expectedWindowRadius,
    highlightBoundingBox,
    highlightOuterRadius,
} from '../src/lib/pickHighlight.js';

describe('the picker highlight', () => {
    describe('expectedWindowRadius', () => {
        it('returns 0 for fullscreen, maximized, or tiled windows', () => {
            expect(expectedWindowRadius({isFullscreen: true, isActivelyClipped: true})).toBe(0);
            expect(expectedWindowRadius({isMaximized: true, isActivelyClipped: true})).toBe(0);
            expect(expectedWindowRadius({isTiled: true, isActivelyClipped: true})).toBe(0);
            expect(expectedWindowRadius({isFullscreen: true, hasNativeLikeCorners: true})).toBe(0);
            expect(expectedWindowRadius({isMaximized: true, hasNativeLikeCorners: true})).toBe(0);
            expect(expectedWindowRadius({isTiled: true, hasNativeLikeCorners: true})).toBe(0);
        });

        it('returns baseRadius when the window is actively clipped by the extension', () => {
            expect(expectedWindowRadius({isActivelyClipped: true})).toBe(ADWAITA_STYLE.window.radius);
            expect(expectedWindowRadius({isActivelyClipped: true, hasSsd: true})).toBe(ADWAITA_STYLE.window.radius);
            expect(expectedWindowRadius({isActivelyClipped: true, baseRadius: 12})).toBe(12);
        });

        it('returns baseRadius for native-like applications without SSD', () => {
            expect(expectedWindowRadius({hasNativeLikeCorners: true, hasSsd: false})).toBe(ADWAITA_STYLE.window.radius);
            expect(expectedWindowRadius({hasNativeLikeCorners: true, hasSsd: false, baseRadius: 16})).toBe(16);
        });

        it('returns 0 for native-like applications with SSD (server-side frame takes precedence unless clipped)', () => {
            expect(expectedWindowRadius({hasNativeLikeCorners: true, hasSsd: true, isActivelyClipped: false})).toBe(0);
        });

        it('returns 0 for unclipped windows without native-like corners (e.g. plain XWayland, Qt, SSD)', () => {
            expect(expectedWindowRadius({})).toBe(0);
            expect(expectedWindowRadius({hasSsd: true})).toBe(0);
            expect(expectedWindowRadius({hasNativeLikeCorners: false})).toBe(0);
        });
    });

    describe('highlightBoundingBox', () => {
        it('returns zero box for null or undefined frame', () => {
            expect(highlightBoundingBox(null)).toEqual({x: 0, y: 0, width: 0, height: 0});
            expect(highlightBoundingBox(undefined)).toEqual({x: 0, y: 0, width: 0, height: 0});
        });

        it('outsets the bounding box by the specified border width', () => {
            const frame = {x: 100, y: 100, width: 600, height: 400};
            expect(highlightBoundingBox(frame)).toEqual({
                x: 100 - HIGHLIGHT_BORDER_WIDTH,
                y: 100 - HIGHLIGHT_BORDER_WIDTH,
                width: 600 + HIGHLIGHT_BORDER_WIDTH * 2,
                height: 400 + HIGHLIGHT_BORDER_WIDTH * 2,
            });
            const explicit = HIGHLIGHT_BORDER_WIDTH + 1;
            expect(highlightBoundingBox(frame, explicit)).toEqual({
                x: 100 - explicit,
                y: 100 - explicit,
                width: 600 + explicit * 2,
                height: 400 + explicit * 2,
            });
        });

        it('supports custom border widths', () => {
            const frame = {x: 50, y: 80, width: 200, height: 150};
            expect(highlightBoundingBox(frame, 6)).toEqual({
                x: 44,
                y: 74,
                width: 212,
                height: 162,
            });
        });
    });

    describe('highlightOuterRadius', () => {
        it('returns 0 when inner radius is 0 (sharp 90 degree square corners)', () => {
            expect(highlightOuterRadius(0)).toBe(0);
            expect(highlightOuterRadius(0, 3)).toBe(0);
            expect(highlightOuterRadius(0, 6)).toBe(0);
        });

        it('calculates concentric outer radius (innerRadius + borderWidth) for rounded windows', () => {
            expect(highlightOuterRadius(15)).toBe(15 + HIGHLIGHT_BORDER_WIDTH);
            expect(highlightOuterRadius(15, 3)).toBe(18);
            expect(highlightOuterRadius(16, 3)).toBe(19);
            expect(highlightOuterRadius(12, 3)).toBe(15);
            expect(highlightOuterRadius(15, 6)).toBe(21);
        });
    });
});
