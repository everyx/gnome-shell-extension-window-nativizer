/** GTK 4.24 GskRectSnap: FLOOR/CEIL equal upstream; ROUND deviates (origin-odd epsilon). */

import {frameFromInsets, ZERO_INSETS} from './frame.js';
import {snapDirection, SnapDirection} from '../platform/numeric.js';

export {SNAP_EPSILON, SnapDirection} from '../platform/numeric.js';

/** GTK's GSK_RECT_SNAP_* macros: four 8-bit directions, left/bottom/right/top low to high. */
export const SnapRule = Object.freeze({
    GROW: 0x01020201,   // top: FLOOR, right: CEIL, bottom: CEIL, left: FLOOR
    ROUND: 0x03030303,  // top: ROUND, right: ROUND, bottom: ROUND, left: ROUND
});

/** Matches gsk_rect_snap_to_grid's scalar projection; the ROUND edge carries our deviation. */
export function snapCoordToGrid(value, scale, direction = SnapDirection.ROUND) {
    if (!(scale > 0) || !Number.isFinite(scale))
        return value;
    return snapDirection(value * scale, direction) / scale;
}

/** Matches gsk_rect_snap_get_direction: side 0 is TOP, then RIGHT, BOTTOM, LEFT. */
function snapRuleGetDirection(rule, side) {
    return (rule >> (8 * side)) & 0xFF;
}

export function snapRectToGrid(rect, scale, rule = SnapRule.ROUND) {
    if (!(scale > 0) || !Number.isFinite(scale))
        return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};

    const topDir = snapRuleGetDirection(rule, 0);
    const rightDir = snapRuleGetDirection(rule, 1);
    const bottomDir = snapRuleGetDirection(rule, 2);
    const leftDir = snapRuleGetDirection(rule, 3);

    const left = snapCoordToGrid(rect.x, scale, leftDir);
    const top = snapCoordToGrid(rect.y, scale, topDir);
    const right = snapCoordToGrid(rect.x + rect.width, scale, rightDir);
    const bottom = snapCoordToGrid(rect.y + rect.height, scale, bottomDir);

    return {
        x: left,
        y: top,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
    };
}

/** Snaps each outer inset margin separately, so the body frame cannot drift by a fraction. */
export function snapActorBodyFrame(bufferSize, insets, scale) {
    if (!(scale > 0) || !Number.isFinite(scale)) {
        const size = {
            width: bufferSize?.width ?? 0,
            height: bufferSize?.height ?? 0,
        };
        const frame = frameFromInsets(size, insets ?? ZERO_INSETS);
        if (frame.width > 0 && frame.height > 0)
            return frame;
        return {x: 0, y: 0, width: Math.max(0, size.width), height: Math.max(0, size.height)};
    }

    const leftMargin = insets?.left ?? 0;
    const topMargin = insets?.top ?? 0;
    const rightMargin = insets?.right ?? 0;
    const bottomMargin = insets?.bottom ?? 0;

    const physW = Math.round(bufferSize.width * scale);
    const physH = Math.round(bufferSize.height * scale);

    const mLeft = Math.round(leftMargin * scale);
    const mTop = Math.round(topMargin * scale);
    const mRight = Math.round(rightMargin * scale);
    const mBottom = Math.round(bottomMargin * scale);

    const left = mLeft / scale;
    const top = mTop / scale;
    const right = Math.max(mLeft, physW - mRight) / scale;
    const bottom = Math.max(mTop, physH - mBottom) / scale;

    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);

    if (width > 0 && height > 0)
        return {x: left, y: top, width, height};

    return {
        x: 0,
        y: 0,
        width: Math.max(0, bufferSize?.width ?? 0),
        height: Math.max(0, bufferSize?.height ?? 0),
    };
}

export const ZERO_PHASE = Object.freeze({x: 0, y: 0});

/** The cut and the shadow's cutout are one edge, so the buffer phase is a required input here. */
export function clipFrameFor(actorSize, insets, scale, phase) {
    const frame = snapActorBodyFrame(actorSize, insets, scale);
    return {
        x: frame.x + phase.x,
        y: frame.y + phase.y,
        width: frame.width,
        height: frame.height,
    };
}


/** Prefers box.init(); a box with neither API is left untouched, so pass a real actor box. */
export function setActorBox(box, x1, y1, x2, y2) {
    if (typeof box.init === 'function') {
        box.init(x1, y1, x2, y2);
        return;
    }
    box.set_origin?.(x1, y1);
    box.set_size?.(Math.max(0, x2 - x1), Math.max(0, y2 - y1));
}

/** Writes x0..x3 then y0..y3; the clamp stops an edge inverting on casts under 2 corners. */
function writeSnappedSliceCoords(out, cast, corner, scale) {
    const width = Math.max(0, cast.width);
    const height = Math.max(0, cast.height);
    const cornerPx = Math.max(0, Math.min(corner, width / 2, height / 2));

    const x0 = snapCoordToGrid(cast.x, scale, SnapDirection.ROUND);
    const x3 = snapCoordToGrid(cast.x + width, scale, SnapDirection.ROUND);
    const x1 = x0 + cornerPx;
    const x2 = x3 - cornerPx;

    const y0 = snapCoordToGrid(cast.y, scale, SnapDirection.ROUND);
    const y3 = snapCoordToGrid(cast.y + height, scale, SnapDirection.ROUND);
    const y1 = y0 + cornerPx;
    const y2 = y3 - cornerPx;

    out[0] = x0;
    out[1] = Math.max(out[0], x1);
    out[2] = Math.max(out[1], x2);
    out[3] = Math.max(out[2], x3);

    out[4] = y0;
    out[5] = Math.max(out[4], y1);
    out[6] = Math.max(out[5], y2);
    out[7] = Math.max(out[6], y3);
}

/** The same slices as plain rects, so the arithmetic can be read as data. */
export function snapSliceRects(cast, corner, scale) {
    const s = [0, 0, 0, 0, 0, 0, 0, 0];
    writeSnappedSliceCoords(s, cast, corner, scale);

    return [
        {x1: s[0], y1: s[4], x2: s[1], y2: s[5]},
        {x1: s[2], y1: s[4], x2: s[3], y2: s[5]},
        {x1: s[0], y1: s[6], x2: s[1], y2: s[7]},
        {x1: s[2], y1: s[6], x2: s[3], y2: s[7]},
        {x1: s[1], y1: s[4], x2: s[2], y2: s[5]},
        {x1: s[1], y1: s[6], x2: s[2], y2: s[7]},
        {x1: s[0], y1: s[5], x2: s[1], y2: s[6]},
        {x1: s[2], y1: s[5], x2: s[3], y2: s[6]},
    ];
}

const SLICE_COORDS = [0, 0, 0, 0, 0, 0, 0, 0];

/** Mutates 8 caller boxes in place, reusing SLICE_COORDS: TL, TR, BL, BR, then the four edges. */
export function snapSliceBoxesInto(boxes, cast, corner, scale) {
    writeSnappedSliceCoords(SLICE_COORDS, cast, corner, scale);
    const s = SLICE_COORDS;

    // box.init() avoids float ULP seams at slice joins: (float)a + (float)(b - a) != (float)b.
    setActorBox(boxes[0], s[0], s[4], s[1], s[5]);
    setActorBox(boxes[1], s[2], s[4], s[3], s[5]);
    setActorBox(boxes[2], s[0], s[6], s[1], s[7]);
    setActorBox(boxes[3], s[2], s[6], s[3], s[7]);
    setActorBox(boxes[4], s[1], s[4], s[2], s[5]);
    setActorBox(boxes[5], s[1], s[6], s[2], s[7]);
    setActorBox(boxes[6], s[0], s[5], s[1], s[6]);
    setActorBox(boxes[7], s[2], s[5], s[3], s[6]);

    return boxes;
}
