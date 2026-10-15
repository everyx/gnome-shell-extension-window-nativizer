/**
 * Frame geometry: the body inside the actor that carries it. The actor is the client's
 * buffer — body plus the ring the client reserved for its own shadow — and both the clip
 * effect and the shadow actor place the body with `frameFromInsets`.
 */

/** No ring: the actor is the body. Used as the fallback when no margin was readable. */
export const ZERO_INSETS = Object.freeze({left: 0, top: 0, right: 0, bottom: 0});

/** Safe 1px inward inset margin for flat ringless windows to excise client rectangular borders. */
export const FLAT_SAFE_INSET = Object.freeze({left: 1, top: 1, right: 1, bottom: 1});

/**
 * The flat safe inset for a monitor scale: a 1-logical-px client border is `scale` device px
 * wide, so a fixed 1px cover cannot excise it on a fractional monitor by construction (1px
 * logical is 1.33 device px at 4/3). The cover is a whole device-pixel count, expressed back in
 * logical px: `ceil(scale)` for the border itself, plus one spare device px on fractional scales.
 *
 * The spare is measured, not guessed. The geometric cut was verified live to be exact on all
 * four sides at every scale (`uFrame` read back off the effect matches the snap math to float
 * precision), yet at 4/3 the bottom edge kept one full border row at every subpixel phase (seven
 * positions swept on both axes, identical to the pixel). The shortfall sits below the geometry -
 * in the paint mapping, which runs at `ceil(scale)` while the screen composites at `scale` - and
 * only exists there: integer scales paint 1:1 and cut exactly with no spare. The spare bounds that
 * drift (worst measured: ~1.3 device px on the bottom edge at 4/3) with room left over, and stays
 * off where there is nothing to bound. The price is deliberate over-cut, around one invisible
 * device px of clean edge content per side on fractional scales - nothing next to the
 * foreign-colour hairline, the phase-dependent crawling while dragging, and the untouched bottom
 * edge the fixed cover leaves behind (issue #129). Deriving the paint origin from the live box
 * at runtime would remove the need for the spare; until then the spare is what keeps the edge
 * exact. At integer scales this is exactly FLAT_SAFE_INSET.
 * @param {number} scale - Physical device scale
 * @returns {{left: number, top: number, right: number, bottom: number}}
 */
export function flatSafeInsets(scale) {
    if (!(scale > 0) || !Number.isFinite(scale))
        return FLAT_SAFE_INSET;
    // Same epsilon idiom as getWindowSubpixelOffset: a fractional part below it is integer.
    // Normalise first, so the integer test and the ceil below cannot disagree: a scale like
    // 1.0005 reads as integer yet ceils to 2, which used to yield a ~2px cover on the integer
    // branch. Real monitor scales arrive in clean steps, so this only fires on hypothetical
    // inputs - but the two lines disagreeing was a real inconsistency (PR #132 review).
    const rounded = Math.round(scale);
    const fractional = Math.abs(scale - rounded) > 0.001;
    const effective = fractional ? scale : rounded;
    const cover = (Math.ceil(effective) + (fractional ? 1 : 0)) / effective;
    return {left: cover, top: cover, right: cover, bottom: cover};
}

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
 * Computes per-side insets between buffer and frame rect (`buffer_rect - frame_rect`).
 * Returns null when the frame does not fit within the buffer.
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
