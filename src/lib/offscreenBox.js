// The offscreen box Clutter gives a ClutterOffscreenEffect, in the units its clip shader uses:
// one shader unit is one logical pixel. The FBO is not the actor's box, so the box is derived
// per paint from the FBO's own extent.

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
 * How far a scale's predicted device extent and the FBO Clutter allocated may differ. The derivation
 * is phase-free while the FBO's edges carry the source framebuffer's subpixel phase: one edge may
 * move one device pixel without the scale being wrong. Past that, no candidate explains the read.
 */
export const OFFSCREEN_BOX_TOLERANCE = 1;

/**
 * The scales an engine may have allocated a window's FBO at: every monitor scale the actor's box
 * touches, plus each one's `ceil`, ascending and deduplicated. The `ceil` variant is unpatched
 * mutter's `ceilf (resource_scale)`; the real-scale caller uses the scale itself. Only the FBO's
 * extent tells the two apart, so both are offered.
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

/** The largest edge disagreement between two device extents. */
function extentDistance(a, b) {
    return Math.max(Math.abs(a.width - b.width), Math.abs(a.height - b.height));
}

/**
 * The scale the engine produced an FBO with, and whether any candidate explains the read: a
 * candidate explains it when its predicted device extent lands within one device pixel, the subpixel
 * phase. Nothing within that budget means the candidate set has not caught up with the engine, and
 * the caller holds the derivation instead of dividing by the wrong scale.
 */
export function resolveOffscreenScale(size, target, scale, candidates = null) {
    // Never `actor.get_resource_scale()` here: it answers `ceilf (real_resource_scale)`, so 1.25
    // and 4/3 both return 2 - the one bit this selection has to keep - and dividing the quad by it
    // draws the body at 62.5%. Mutter keeps the real value private, with no GIR read.
    const declared = usableScale(scale);
    // An incomplete set still offers the declared scale: the read alone can then say whether the
    // derivation spans it, which is all the caller's fallback needs.
    const offers = Array.isArray(candidates) && candidates.length ? candidates : [declared];
    if (!Number.isFinite(target?.width) || !Number.isFinite(target?.height) ||
        !(target.width > 0) || !(target.height > 0))
        return {scale: declared, explained: true};

    let best = null;
    let bestOffset = Infinity;
    for (const candidate of offers) {
        if (!Number.isFinite(candidate) || !(candidate > 0))
            continue;
        const offset = extentDistance(offscreenDeviceExtent(size, candidate), target);
        if (offset < bestOffset) {
            best = candidate;
            bestOffset = offset;
        }
    }
    if (best === null || bestOffset > OFFSCREEN_BOX_TOLERANCE)
        return {scale: declared, explained: false};
    return {scale: best, explained: true};
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
 * and the derived device extent the reconciliation compares against the FBO. Extent and origin
 * share the picked scale; `candidates` is the reconcile pass's set, or null when incomplete.
 *
 * A read no candidate explains holds the derivation for the pass, so the body stays whole.
 */
export function offscreenPaintBox(size, scale, target, candidates = null) {
    const s = usableScale(scale);
    const quad = offscreenQuad(size, s);
    const pick = resolveOffscreenScale(size, target, s, candidates);
    if (!pick.explained) {
        return {
            scale: s,
            extent: {width: quad.width, height: quad.height},
            offsetX: quad.offsetX,
            offsetY: quad.offsetY,
            predicted: offscreenDeviceExtent(size, s),
        };
    }
    const fboScale = pick.scale;
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
