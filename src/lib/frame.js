/** Frame geometry: the actor is the client's buffer (body + reserved ring); the body sits in it. */

import {INTEGRAL_EPSILON} from '../platform/numeric.js';

export const ZERO_INSETS = Object.freeze({left: 0, top: 0, right: 0, bottom: 0});

export const FLAT_SAFE_INSET = Object.freeze({left: 1, top: 1, right: 1, bottom: 1});

/** Cover for a 1-logical-px client border: a fixed 1px cover misses it on a fractional monitor. */
export function flatSafeInsets(scale) {
    if (!(scale > 0) || !Number.isFinite(scale))
        return FLAT_SAFE_INSET;
    // Normalise before the integer test and the ceil: 1.0005 reads as integer yet would ceil to 2.
    const rounded = Math.round(scale);
    const fractional = Math.abs(scale - rounded) > INTEGRAL_EPSILON;
    const effective = fractional ? scale : rounded;
    const cover = (Math.ceil(effective) + (fractional ? 1 : 0)) / effective;
    return {left: cover, top: cover, right: cover, bottom: cover};
}


/** Body rect inside an actor of `size`; the live size is passed, so a resize shows no stale box. */
export function frameFromInsets(size, insets = ZERO_INSETS) {
    return {
        x: insets.left,
        y: insets.top,
        width: size.width - insets.left - insets.right,
        height: size.height - insets.top - insets.bottom,
    };
}

/** Per-side insets, buffer minus frame; null when the frame does not fit inside the buffer. */
export function insetsFromRects(buffer, frame) {
    if (!buffer || !frame || !(buffer.width > 0) || !(buffer.height > 0) ||
        !(frame.width > 0) || !(frame.height > 0))
        return null;

    const insets = {
        left: frame.x - buffer.x,
        top: frame.y - buffer.y,
        right: buffer.x + buffer.width - (frame.x + frame.width),
        bottom: buffer.y + buffer.height - (frame.y + frame.height),
    };
    if (insets.left < 0 || insets.top < 0 || insets.right < 0 || insets.bottom < 0)
        return null;

    return insets;
}
