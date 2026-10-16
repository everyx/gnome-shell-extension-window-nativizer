/**
 * Frame geometry: the body inside the actor that carries it. The actor is the client's
 * buffer - body plus the ring the client reserved for its own shadow - and both the clip
 * effect and the shadow actor place the body with `frameFromInsets`.
 */

export const ZERO_INSETS = Object.freeze({left: 0, top: 0, right: 0, bottom: 0});

export const FLAT_SAFE_INSET = Object.freeze({left: 1, top: 1, right: 1, bottom: 1});

/**
 * The flat safe inset for a monitor scale: a 1-logical-px client border is `scale` device px wide,
 * so a fixed 1px cover cannot excise it on a fractional monitor. The cover is `ceil(scale)` device
 * px for the border, plus one spare device px on fractional scales; at integer scales it is exactly
 * `FLAT_SAFE_INSET`.
 * @param scale - Physical device scale
 */
export function flatSafeInsets(scale) {
    if (!(scale > 0) || !Number.isFinite(scale))
        return FLAT_SAFE_INSET;
    // Normalise before the integer test and the ceil, so the two cannot disagree: a scale like 1.0005
    // reads as integer yet ceils to 2, which once yielded a ~2px cover on the integer branch. Real
    // scales arrive in clean steps, so this only fires on hypothetical inputs.
    const rounded = Math.round(scale);
    const fractional = Math.abs(scale - rounded) > 0.001;
    const effective = fractional ? scale : rounded;
    const cover = (Math.ceil(effective) + (fractional ? 1 : 0)) / effective;
    return {left: cover, top: cover, right: cover, bottom: cover};
}


/**
 * The body rect inside an actor of `size`, inset on each side. Called every frame from the
 * actor's live size, so a resize never shows geometry the actor has already left.
 * @param size - Actor size, logical px
 * @param [insets=ZERO_INSETS] - Ring the client declared, per side
 * @returns Body in actor coords
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
 * Computes per-side insets between buffer and frame rect (`buffer_rect - frame_rect`).
 * Returns null when the frame does not fit within the buffer.
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
