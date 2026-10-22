import {
    insetsEqual,
    insetsMoved,
    rectContains,
    rectEquals,
    rectanglesOverlap,
    sameSize,
} from '../src/platform/rect.js';

const rect = (x, y, width, height) => ({x, y, width, height});

describe('rectEquals', () => {
    it('compares all four fields', () => {
        const base = rect(10, 20, 100, 50);
        expect(rectEquals(base, rect(10, 20, 100, 50))).toBeTrue();
        // One field at a time, so a comparison that forgot a field names itself here.
        expect(rectEquals(base, rect(11, 20, 100, 50))).toBeFalse();
        expect(rectEquals(base, rect(10, 21, 100, 50))).toBeFalse();
        expect(rectEquals(base, rect(10, 20, 101, 50))).toBeFalse();
        expect(rectEquals(base, rect(10, 20, 100, 51))).toBeFalse();
    });

    it('answers false when either side is unreadable, so !rectEquals reads as "it moved"', () => {
        // The settle compares the previous pass's buffer against this one's. A pass that could not
        // read a buffer is not "the same buffer", and callers rely on that to skip the hold.
        expect(rectEquals(null, rect(0, 0, 1, 1))).toBeFalse();
        expect(rectEquals(rect(0, 0, 1, 1), null)).toBeFalse();
        expect(rectEquals(null, null)).toBeFalse();
        expect(rectEquals(undefined, undefined)).toBeFalse();
    });
});

describe('sameSize', () => {
    it('ignores the origin', () => {
        expect(sameSize(rect(0, 0, 100, 50), rect(900, 900, 100, 50))).toBeTrue();
        expect(sameSize(rect(0, 0, 100, 50), rect(0, 0, 100, 51))).toBeFalse();
        expect(sameSize(rect(0, 0, 100, 50), rect(0, 0, 101, 50))).toBeFalse();
    });

    it('answers false when either side is unreadable', () => {
        expect(sameSize(null, rect(0, 0, 1, 1))).toBeFalse();
        expect(sameSize(null, null)).toBeFalse();
    });
});

describe('rectContains', () => {
    it('is inclusive on every edge', () => {
        const outer = rect(0, 0, 100, 100);
        expect(rectContains(outer, rect(0, 0, 100, 100))).toBeTrue();
        expect(rectContains(outer, rect(10, 10, 80, 80))).toBeTrue();
        // Flush against one edge, which a strict comparison would call outside.
        expect(rectContains(outer, rect(0, 10, 100, 80))).toBeTrue();
        expect(rectContains(outer, rect(10, 0, 80, 100))).toBeTrue();
    });

    it('rejects a side that leaves the outer box', () => {
        const outer = rect(0, 0, 100, 100);
        expect(rectContains(outer, rect(-1, 0, 100, 100))).toBeFalse();
        expect(rectContains(outer, rect(0, 0, 101, 100))).toBeFalse();
        expect(rectContains(outer, rect(0, 0, 100, 101))).toBeFalse();
        expect(rectContains(outer, rect(0, 1, 100, 100))).toBeFalse();
    });

    it('answers false when either side is unreadable', () => {
        expect(rectContains(null, rect(0, 0, 1, 1))).toBeFalse();
        expect(rectContains(rect(0, 0, 1, 1), null)).toBeFalse();
    });
});

describe('rectanglesOverlap', () => {
    it('needs positive area, so touching edges do not count', () => {
        expect(rectanglesOverlap(rect(0, 0, 10, 10), rect(5, 5, 10, 10))).toBeTrue();
        // `mtk_rectangle_intersect` answers false for a shared edge; a strict > is what keeps the
        // two-monitor scan from claiming a monitor the window only touches.
        expect(rectanglesOverlap(rect(0, 0, 10, 10), rect(10, 0, 10, 10))).toBeFalse();
        expect(rectanglesOverlap(rect(0, 0, 10, 10), rect(0, 10, 10, 10))).toBeFalse();
        expect(rectanglesOverlap(rect(0, 0, 10, 10), rect(20, 20, 10, 10))).toBeFalse();
    });

    it('is symmetric', () => {
        const a = rect(0, 0, 10, 10);
        const b = rect(5, 5, 10, 10);
        expect(rectanglesOverlap(a, b)).toBe(rectanglesOverlap(b, a));
    });

    it('answers false when either side is unreadable', () => {
        expect(rectanglesOverlap(null, rect(0, 0, 10, 10))).toBeFalse();
        expect(rectanglesOverlap(rect(0, 0, 10, 10), null)).toBeFalse();
    });
});

describe('insetsEqual', () => {
    const insets = (left, top, right, bottom) => ({left, top, right, bottom});

    it('compares all four sides, unlike the tolerance-based insetsMoved', () => {
        const base = insets(8, 8, 8, 8);
        expect(insetsEqual(base, insets(8, 8, 8, 8))).toBeTrue();
        // A sub-pixel difference is a difference here: this answers "same", not "settled".
        expect(insetsEqual(base, insets(8.5, 8, 8, 8))).toBeFalse();
        expect(insetsEqual(base, insets(8, 9, 8, 8))).toBeFalse();
        expect(insetsEqual(base, insets(8, 8, 9, 8))).toBeFalse();
        expect(insetsEqual(base, insets(8, 8, 8, 9))).toBeFalse();
    });

    it('reads a missing side as 0', () => {
        expect(insetsEqual({left: 4}, {left: 4})).toBeTrue();
        expect(insetsEqual({left: 4}, insets(4, 0, 0, 0))).toBeTrue();
        expect(insetsEqual({}, insets(0, 0, 0, 0))).toBeTrue();
        expect(insetsEqual({left: 4}, {left: 5})).toBeFalse();
    });

    it('answers false when either side is unreadable, leaving "both absent" to the caller', () => {
        // The one caller is a change cache, where absent on both reads as unchanged; that is its
        // statement to make, so it does it explicitly rather than bending this predicate.
        expect(insetsEqual(null, insets(0, 0, 0, 0))).toBeFalse();
        expect(insetsEqual(insets(0, 0, 0, 0), null)).toBeFalse();
        expect(insetsEqual(null, null)).toBeFalse();
    });
});

describe('insetsMoved', () => {
    const insets = (left, top, right, bottom) => ({left, top, right, bottom});

    it('treats exactly the tolerance as a move, which is the boundary the hold uses', () => {
        const base = insets(8, 8, 8, 8);
        expect(insetsMoved(base, insets(9, 8, 8, 8))).toBeTrue();
        expect(insetsMoved(base, insets(8.5, 8, 8, 8))).toBeFalse();
        expect(insetsMoved(base, insets(7, 8, 8, 8))).toBeTrue();
        expect(insetsMoved(base, insets(8, 8, 8, 8.9))).toBeFalse();
        expect(insetsMoved(base, insets(8, 8, 8, 9))).toBeTrue();
    });

    it('checks every side', () => {
        const base = insets(8, 8, 8, 8);
        expect(insetsMoved(base, insets(8, 9, 8, 8))).toBeTrue();
        expect(insetsMoved(base, insets(8, 8, 9, 8))).toBeTrue();
    });

    it('reads a missing side as 0 rather than NaN', () => {
        // const allowed = undefined - 0 would be NaN, and NaN >= 1 is false, so a side that went
        // missing would read as "not moved" - the opposite of what the hold needs to know.
        expect(insetsMoved({left: 5}, {left: 0})).toBeTrue();
        expect(insetsMoved({left: 0}, {left: 0})).toBeFalse();
        expect(insetsMoved({}, {})).toBeFalse();
    });

    it('answers false when either side is unreadable, so the hold keeps nothing', () => {
        expect(insetsMoved(null, insets(8, 8, 8, 8))).toBeFalse();
        expect(insetsMoved(insets(8, 8, 8, 8), null)).toBeFalse();
        expect(insetsMoved(null, null)).toBeFalse();
    });
});
