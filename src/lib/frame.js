/**
 * Frame geometry: the body inside the actor that carries it. The actor is the client's
 * buffer — body plus the ring the client reserved for its own shadow — so both the clip
 * effect and the shadow actor place their geometry with this. Pure: docs/architecture.md.
 */

/** No ring: the actor is the body. Used as the fallback when no margin was readable. */
export const ZERO_INSETS = Object.freeze({left: 0, top: 0, right: 0, bottom: 0});

/** @typedef {{left: number, top: number, right: number, bottom: number}} Insets */

/**
 * The body rect inside an actor of `size`, inset on each side. Called every frame from the
 * actor's live size, so a resize never shows geometry the actor has already left.
 * @param {{width: number, height: number}} size - Actor size, logical px
 * @param {Insets} [insets=ZERO_INSETS] - Ring the client declared, per side
 * @returns {{x: number, y: number, width: number, height: number}} Body in actor coords
 */
export function frameFromInsets(size, insets = ZERO_INSETS) {
    return {
        x: insets.left,
        y: insets.top,
        width: size.width - insets.left - insets.right,
        height: size.height - insets.top - insets.bottom,
    };
}

/**
 * The per-side ring between a buffer and its frame rect, read the one way the rest of the
 * code reads a margin (`buffer_rect - frame_rect`). Null when the frame is not inside the
 * buffer: a framed X11 window reports the two in different coordinate frames, and Mutter
 * carries a shadow padding its actor on some paths.
 * @param {{x: number, y: number, width: number, height: number}} buffer
 * @param {{x: number, y: number, width: number, height: number}} frame
 * @returns {Insets|null}
 */
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
