/**
 * The offscreen box Clutter gives a ClutterOffscreenEffect, expressed in the units the clip
 * shader's `p` spans, so that one shader unit is exactly one logical pixel.
 *
 * A shader effect's texture coordinates span the whole offscreen FBO, not the actor, so the
 * clip cannot derive `quadSize` from the actor size: it has to know how many logical pixels the
 * FBO covers and where the actor's origin sits inside it. Both come from one box, which Mutter
 * builds in two steps.
 *
 * 1. `_clutter_actor_box_enlarge_for_effects` (clutter/clutter/clutter-actor-box.c, vendored at
 *    vendor/mutter/COMMIT) enlarges the paint box:
 *      x2 = ceilf (x2 + 0.75f);  x1 = x2 - CLUTTER_NEARBYINT (x2 - x1) - 3
 *    The 3px total per axis and the 0.75px rounding margin are its literals; the 2px top/left
 *    origin is not one - it is what the rule yields on an integer-aligned box, and it moves by a
 *    whole logical pixel when the box is fractional.
 * 2. `clutter_offscreen_effect_pre_paint` (clutter/clutter/clutter-offscreen-effect.c, mutter
 *    51.1 plus upstream MR !5179, which is the patchset this extension targets - see README)
 *    scales that box by the *real* resource scale and rounds each edge onto the device grid:
 *      box *= resource_scale;  x1 = (int) floorf (box.x1 + phase);  x2 = (int) ceilf (box.x2 + phase)
 *    The FBO is `x2 - x1` device pixels wide, and `x1 / resource_scale` is the origin the effect
 *    then blits from.
 *
 * The old constants this replaced baked in the pre-!5179 caller, which scaled the box by
 * `ceilf (resource_scale)`: at 1.25x that is 2, so they only described an integer scale. At 1.25x
 * the real FBO is 556x356 device px for a 441x281 body, not the 555x355 the constants implied,
 * which made one shader unit 1.2522 device px instead of 1.25 - the corner arc and the
 * pixel-snapped straight edge then disagreed by up to half a physical pixel at the tangent.
 *
 * The phase is not zero in practice: at 4/3 the FBO came out one device pixel larger than a
 * phase-free derivation, because the source framebuffer carries a subpixel phase. The extent is
 * therefore read from the engine (`get_target_size()`) and reconciled every frame, with a one
 * device pixel tolerance; the origin stays derived, since `fbo_offset_x` is not readable.
 */

import {roundHalfAwayFromZero} from '../platform/numeric.js';

/** Upstream's rounding margin before the `ceilf` (0.75f). */
export const ENLARGE_ROUNDING_PAD = 0.75;

/** Upstream's total padding per axis (the `- 3`), split 2 near / 1 far on an integer box. */
export const ENLARGE_TOTAL_PAD = 3;

/**
 * `_clutter_actor_box_enlarge_for_effects` on the axis of an actor-local box `[0, length]`.
 * Returns the enlarged near and far edges, in logical px, still relative to the actor origin.
 * `CLUTTER_NEARBYINT` is `(int) (x + 0.5f)` for x >= 0 - half away from zero, not the ties-to-even
 * `nearbyint()` its name suggests - and `roundHalfAwayFromZero` carries that rule for every sign.
 */
function enlargeAxis(length) {
    const far = Math.ceil(length + ENLARGE_ROUNDING_PAD);
    const near = far - roundHalfAwayFromZero(length) - ENLARGE_TOTAL_PAD;
    return {near, far};
}

/**
 * C's `clutter_round_to_256ths`, applied to the scaled edges before they are rounded onto the
 * device grid. The monitor scale is a float32: `282 * 1.333333373` is 376.000017 in double
 * precision and exactly 376 in the float32 the compositor multiplies in. Without this, a 441x281
 * body at 4/3 asked for a 285.0-unit quad and cut the bottom edge a device pixel short.
 */
function roundTo256ths(value) {
    return Math.round(value * 256) / 256;
}

/**
 * The offscreen box a shader effect on an actor of `size` gets at `scale`, as the clip needs it: the
 * FBO extent in logical px (`width`/`height`, the span `p / quadSize` normalizes over), and where
 * the actor origin sits inside it (`offsetX`/`offsetY`, the shader's `uFboOffset`).
 *
 * `width * scale` and `offsetX * scale` land on whole device pixels by construction.
 */
export function offscreenQuad(size, scale = 1.0) {
    const s = Number.isFinite(scale) && scale > 0 ? scale : 1.0;
    const width = Number.isFinite(size?.width) ? size.width : 0;
    const height = Number.isFinite(size?.height) ? size.height : 0;
    const x = enlargeAxis(width);
    const y = enlargeAxis(height);
    const originX = Math.floor(roundTo256ths(x.near * s));
    const originY = Math.floor(roundTo256ths(y.near * s));
    const endX = Math.ceil(roundTo256ths(x.far * s));
    const endY = Math.ceil(roundTo256ths(y.far * s));
    return {
        width: (endX - originX) / s,
        height: (endY - originY) / s,
        offsetX: -originX / s,
        offsetY: -originY / s,
    };
}

/**
 * The extent the shader normalizes its texture coordinates over. The size Clutter reports for the
 * FBO it allocated wins whenever that read is available: the coordinates span the FBO itself, so
 * its own extent is the ground truth and the derived box only predicts it. `target` is the read in
 * device px, or null; the result is in logical px.
 */
export function offscreenExtent(derived, target, scale) {
    const s = Number.isFinite(scale) && scale > 0 ? scale : 1.0;
    if (!Number.isFinite(target?.width) || !Number.isFinite(target?.height))
        return {width: derived.width, height: derived.height};
    return {width: target.width / s, height: target.height / s};
}
