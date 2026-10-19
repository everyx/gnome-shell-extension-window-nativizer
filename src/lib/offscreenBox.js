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
 * 2. `clutter_offscreen_effect_pre_paint` scales that box by the actor's resource scale and rounds
 *    each edge onto the device grid:
 *      box *= resource_scale;  x1 = (int) floorf (box.x1 + phase);  x2 = (int) ceilf (box.x2 + phase)
 *    The FBO is `x2 - x1` device pixels wide, and `x1 / resource_scale` is the origin the effect
 *    then blits from. This is the shape upstream MR !5179 gives the rule, and what the optional
 *    `mutter-everyx` package builds; the *unpatched* upstream caller of the same release scales
 *    the box by `ceilf (resource_scale)` and blits with `1 / ceilf (resource_scale)` instead, which
 *    makes the FBO up to `ceilf (resource_scale) / resource_scale` larger for the same actor.
 *
 * This extension targets the mutter a plain GNOME Shell ships, not a patched one: the checkout
 * under `research/mutter` (HEAD `8fe247a2`, 50.4) still carries the `ceilf (resource_scale)`
 * caller, and upstream !5179 is unmerged. `mutter-everyx` is an optional local optimization the
 * author maintains. Measured on `mutter-everyx` 51.1 for a 441x281 body at 4/3, `get_target_size()`
 * reports 593x379 device px - the real-scale rule, against the 888x568 the `ceil` rule would
 * allocate. The clip therefore has to hold under *both* rules, which is what
 * `resolveOffscreenScale` below picks between candidate scales for, from the FBO's own extent.
 *
 * The old constants this replaced baked in the `ceilf` caller: at 1.25x that is 2, so they only
 * described an integer scale. At 1.25x the real FBO is 556x356 device px for a 441x281 body, not
 * the 555x355 the constants implied, which made one shader unit 1.2522 device px instead of 1.25 -
 * the corner arc and the pixel-snapped straight edge then disagreed by up to half a physical pixel
 * at the tangent.
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

/** A positive usable scale, or 1.0 for anything else: the box cannot divide by zero. */
function usableScale(scale) {
    return Number.isFinite(scale) && scale > 0 ? scale : 1.0;
}

/**
 * One axis of the offscreen box at scale `s`: the enlarged edges floored and ceiled onto the device
 * grid, in device px relative to the actor origin. `end - start` is the axis's FBO extent.
 */
function scaledAxis(length, s) {
    const {near, far} = enlargeAxis(length);
    return {
        start: Math.floor(roundTo256ths(near * s)),
        end: Math.ceil(roundTo256ths(far * s)),
    };
}

/**
 * The offscreen box a shader effect on an actor of `size` gets at `scale`, as the clip needs it: the
 * FBO extent in logical px (`width`/`height`, the span `p / quadSize` normalizes over), and where
 * the actor origin sits inside it (`offsetX`/`offsetY`, the shader's `uFboOffset`).
 *
 * `width * scale` and `offsetX * scale` land on whole device pixels by construction.
 */
export function offscreenQuad(size, scale = 1.0) {
    const s = usableScale(scale);
    const x = scaledAxis(Number.isFinite(size?.width) ? size.width : 0, s);
    const y = scaledAxis(Number.isFinite(size?.height) ? size.height : 0, s);
    return {
        width: (x.end - x.start) / s,
        height: (y.end - y.start) / s,
        offsetX: -x.start / s,
        offsetY: -y.start / s,
    };
}

/**
 * The FBO device extent an engine allocating `size` at `scale` would hand the clip, un-divided: the
 * same derivation `offscreenQuad` makes, kept in device px because that is what a read FBO is
 * compared against.
 */
export function offscreenDeviceExtent(size, scale = 1.0) {
    const s = usableScale(scale);
    const x = scaledAxis(Number.isFinite(size?.width) ? size.width : 0, s);
    const y = scaledAxis(Number.isFinite(size?.height) ? size.height : 0, s);
    return {width: x.end - x.start, height: y.end - y.start};
}

/**
 * The scales an engine may have allocated a window's FBO at: every monitor scale its frame touches,
 * plus each one's `ceil`, ascending and deduplicated. The `ceil` variant is unpatched mutter's
 * `ceilf (resource_scale)`; the real-scale caller uses the scale itself. Only the FBO's extent
 * tells the two apart, so both are offered.
 */
export function offscreenScaleCandidates(scales) {
    if (!Array.isArray(scales))
        return null;
    const out = [];
    for (const scale of scales) {
        if (!Number.isFinite(scale) || !(scale > 0))
            continue;
        for (const value of [scale, Math.ceil(scale)]) {
            if (!out.some(seen => Math.abs(seen - value) < 1e-6))
                out.push(value);
        }
    }
    return out.length ? out.sort((a, b) => a - b) : null;
}

/** The largest edge disagreement between two device extents: the distance the veto is measured in. */
function extentDistance(a, b) {
    return Math.max(Math.abs(a.width - b.width), Math.abs(a.height - b.height));
}

/**
 * The scale the engine produced an FBO with: the candidate whose predicted device extent is closest
 * to the read one, else the declared scale. The veto is relative: predictions are hundreds of
 * device pixels apart, so only distinguishability matters. A read farther from the best than half
 * the two closest predictions' spacing names nothing.
 */
export function resolveOffscreenScale(size, target, scale, candidates = null) {
    // Never `actor.get_resource_scale()` here: it answers `ceilf (real_resource_scale)`, so 1.25
    // and 4/3 both return 2 - the one bit this selection has to keep - and dividing the quad by it
    // draws the body at 62.5%. Mutter keeps the real value private, with no GIR read.
    const declared = usableScale(scale);
    if (!Number.isFinite(target?.width) || !Number.isFinite(target?.height) ||
        !(target.width > 0) || !(target.height > 0) || !Array.isArray(candidates))
        return {scale: declared, resolved: false};

    let best = null;
    let bestPredicted = null;
    let bestOffset = Infinity;
    for (const candidate of candidates) {
        if (!Number.isFinite(candidate) || !(candidate > 0))
            continue;
        const predicted = offscreenDeviceExtent(size, candidate);
        const offset = extentDistance(predicted, target);
        if (offset < bestOffset) {
            best = candidate;
            bestPredicted = predicted;
            bestOffset = offset;
        }
    }
    if (best === null)
        return {scale: declared, resolved: false};

    let nearest = Infinity;
    for (const candidate of candidates) {
        if (!Number.isFinite(candidate) || !(candidate > 0) || Math.abs(candidate - best) < 1e-9)
            continue;
        nearest = Math.min(nearest,
            extentDistance(bestPredicted, offscreenDeviceExtent(size, candidate)));
    }
    if (bestOffset > nearest / 2)
        return {scale: declared, resolved: false};
    return Math.abs(best - declared) < 1e-9
        ? {scale: declared, resolved: false}
        : {scale: best, resolved: true};
}

/**
 * The extent the shader normalizes its texture coordinates over. The size Clutter reports for the
 * FBO wins whenever that read is available, since the coordinates span the FBO itself. `target` is
 * that read in device px, or null, divided by the scale that produced it - never by the clip's
 * declared scale, so a wrongly-scaled clip still spans it.
 */
export function offscreenExtent(derived, target, scale) {
    if (!Number.isFinite(target?.width) || !Number.isFinite(target?.height))
        return {width: derived.width, height: derived.height};
    const s = usableScale(scale);
    return {width: target.width / s, height: target.height / s};
}

/**
 * Whether a paint owes the shader new `uQuadSize` / `uFboOffset` values. `quad` and `offset` are the
 * vectors the effect last wrote; the box carries every number they are built from, the origin
 * included, because an FBO reallocated at another scale can move the origin while the read extent
 * stays put.
 */
export function offscreenUniformsStale(quad, offset, box) {
    return quad[0] !== box.extent.width || quad[1] !== box.extent.height ||
        offset[0] !== box.offsetX || offset[1] !== box.offsetY;
}

/**
 * One paint's offscreen box: the extent the shader's coordinates span, the actor origin inside it,
 * and the derived device extent the reconciliation compares against the FBO. Extent and origin are
 * one position and share the picked scale, and `candidates` is the reconcile pass's set, or null
 * when it is incomplete.
 */
export function offscreenPaintBox(size, scale, target, candidates = null) {
    const s = usableScale(scale);
    const quad = offscreenQuad(size, s);
    const fboScale = resolveOffscreenScale(size, target, s, candidates).scale;
    // Bit-identical reuse when the declared scale already explains the FBO, so the common path does
    // not grow a second derivation; a mismatch re-derives both spans on the FBO's own grid.
    const fboQuad = fboScale === s ? quad : offscreenQuad(size, fboScale);
    return {
        scale: fboScale,
        extent: offscreenExtent(quad, target, fboScale),
        offsetX: fboQuad.offsetX,
        offsetY: fboQuad.offsetY,
        predicted: {width: fboQuad.width * fboScale, height: fboQuad.height * fboScale},
    };
}
