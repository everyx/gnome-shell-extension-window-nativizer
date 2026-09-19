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
 * The body to paint for an actor of `size`. Falls back to the whole actor when the ring
 * would leave no body - the insets are debounced, the actor is not, so the caller must keep
 * painting instead of skipping the frame (docs/decoration-model.md).
 * @param {{width: number, height: number}} size - Actor size, logical px
 * @param {Insets} [insets=ZERO_INSETS] - Ring the client declared, per side
 * @returns {{x: number, y: number, width: number, height: number}} Body in actor coords
 */
export function bodyFrame(size, insets = ZERO_INSETS) {
    const frame = frameFromInsets(size, insets);
    if (frame.width > 0 && frame.height > 0)
        return frame;
    return frameFromInsets(size, ZERO_INSETS);
}

/**
 * The per-side ring between a buffer and its frame rect (`buffer_rect - frame_rect`). An X11
 * SSD window reads as the frame's invisible border width (>= 0), not null: Mutter sets
 * `buffer_rect = frame->rect`, the frame grown by those borders (`window-x11.c`). Null when
 * the frame is not inside the buffer at all.
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

/**
 * Whether the client declared its own outer margin ring between buffer and frame.
 * SSD windows are drawn by the compositor frame, not the client, so hasSsd => false.
 * @param {object} [params={}]
 * @param {{x: number, y: number, width: number, height: number}|null} [params.buffer=null]
 * @param {{x: number, y: number, width: number, height: number}|null} [params.frame=null]
 * @param {boolean} [params.hasSsd=false]
 * @returns {boolean}
 */
export function hasDeclaredMarginRing({buffer = null, frame = null, hasSsd = false} = {}) {
    if (hasSsd)
        return false;
    const insets = insetsFromRects(buffer, frame);
    if (!insets)
        return false;
    return insets.left > 0 || insets.right > 0 || insets.top > 0 || insets.bottom > 0;
}

