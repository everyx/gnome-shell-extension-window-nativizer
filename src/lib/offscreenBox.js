/** From the FBO's own extent each paint: patched and unpatched mutter size the box differently. */

import {roundHalfAwayFromZero} from '../platform/numeric.js';

/** Upstream's rounding margin before the `ceilf` (0.75f). */
export const ENLARGE_ROUNDING_PAD = 0.75;

/** Upstream's total padding per axis (the `- 3`), split 2 near / 1 far on an integer box. */
export const ENLARGE_TOTAL_PAD = 3;

/** Trap: `CLUTTER_NEARBYINT` is half away from zero, not ties-to-even as its name suggests. */
function enlargeAxis(length) {
    const far = Math.ceil(length + ENLARGE_ROUNDING_PAD);
    const near = far - roundHalfAwayFromZero(length) - ENLARGE_TOTAL_PAD;
    return {near, far};
}

/** The scale is float32 upstream, so a double 376.000017 must land on 376 before rounding. */
function roundTo256ths(value) {
    return Math.round(value * 256) / 256;
}

/** A positive usable scale, or 1.0 for anything else: the box cannot divide by zero. */
function usableScale(scale) {
    return Number.isFinite(scale) && scale > 0 ? scale : 1.0;
}

/** One axis on the device grid: `end - start` is the axis's FBO extent. */
function scaledAxis(length, s) {
    const {near, far} = enlargeAxis(length);
    return {
        start: Math.floor(roundTo256ths(near * s)),
        end: Math.ceil(roundTo256ths(far * s)),
    };
}

/** `width`/`height` span `p / quadSize`; `offsetX`/`offsetY` are the shader's `uFboOffset`. */
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

/** Same derivation undivided, in device px: that is what a read FBO is compared against. */
export function offscreenDeviceExtent(size, scale = 1.0) {
    const s = usableScale(scale);
    const x = scaledAxis(Number.isFinite(size?.width) ? size.width : 0, s);
    const y = scaledAxis(Number.isFinite(size?.height) ? size.height : 0, s);
    return {width: x.end - x.start, height: y.end - y.start};
}

/** One px of slack: FBO edges carry subpixel phase, so an edge may move a pixel. */
export const OFFSCREEN_BOX_TOLERANCE = 1;

/** Each scale and its `ceil`: only the FBO's extent tells patched mutter from unpatched. */
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

function extentDistance(a, b) {
    return Math.max(Math.abs(a.width - b.width), Math.abs(a.height - b.height));
}

/** Nothing in tolerance means the candidates lag the engine, so the caller holds the derivation. */
export function resolveOffscreenScale(size, target, scale, candidates = null) {
    // Never `get_resource_scale()`: its `ceilf` makes 1.25 and 4/3 both 2, drawing the body at 62.5%.
    const declared = usableScale(scale);
    // An incomplete set still offers the declared scale, so the read can test that one.
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

/** The FBO's read wins, divided by the scale that produced it, not the clip's declared scale. */
export function offscreenExtent(derived, target, scale) {
    if (!Number.isFinite(target?.width) || !Number.isFinite(target?.height))
        return {width: derived.width, height: derived.height};
    const s = usableScale(scale);
    return {width: target.width / s, height: target.height / s};
}

/** The origin is compared too: a reallocated FBO can move it while the read extent stays put. */
export function offscreenUniformsStale(quad, offset, box) {
    return quad[0] !== box.extent.width || quad[1] !== box.extent.height ||
        offset[0] !== box.offsetX || offset[1] !== box.offsetY;
}

/** A read no candidate explains holds the derivation for the pass, so the body stays whole. */
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
    // Reuse the quad when the declared scale explains the FBO; a mismatch re-derives on the FBO's grid.
    const fboQuad = fboScale === s ? quad : offscreenQuad(size, fboScale);
    return {
        scale: fboScale,
        extent: offscreenExtent(quad, target, fboScale),
        offsetX: fboQuad.offsetX,
        offsetY: fboQuad.offsetY,
        predicted: {width: fboQuad.width * fboScale, height: fboQuad.height * fboScale},
    };
}
