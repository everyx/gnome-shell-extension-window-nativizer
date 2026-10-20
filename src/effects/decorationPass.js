/**
 * One decoration pass, as the two cuts read it: the style it resolved, the ring the clip is worn
 * with, the plan its paints settle against, and the resolved clip target.
 *
 * The decoration builds one per pass and hands it to both effects. What each effect does with it -
 * which setters it needs, in the order its own invariants require, and what a pass that draws nothing
 * means for its own parameters - stays behind that seam.
 */

import {ZERO_INSETS} from '../lib/frame.js';

/**
 * @param style - The resolved style. Required: a pass exists because one was resolved
 * @param scale - The scale this pass lays out at, 1.0 when the read failed
 * @param readableScale - The exact scale, or null while none was read; the clip cannot take the 1.0
 * @returns The pass value both effects are handed
 */
export function decorationPass({
    style, ring = null, drawClip = false, scale = 1.0, readableScale = null,
    scaleCandidates = null, bodyPlan = null, clipTarget = null, phaseInTransform = false,
    inOverview = false,
}) {
    return {
        style, ring, drawClip, scale, readableScale,
        scaleCandidates, bodyPlan, clipTarget, phaseInTransform, inOverview,
    };
}

/**
 * The clip effect's parameters for a pass: the ring it cuts inside, the corner it draws, and the
 * meanings it gives that ring. A pass that draws nothing still states radius 0 and no outline, so a
 * pass after it is never read through the previous one's corner.
 */
export function clipParamsFrom(pass) {
    return {
        insets: pass.ring?.insets ?? ZERO_INSETS,
        radius: pass.drawClip ? pass.style.radius : 0,
        outline: pass.drawClip && !pass.inOverview ? pass.style.outline : null,
        erase: Boolean(pass.ring?.erase),
        clearStroke: !pass.inOverview && Boolean(pass.ring?.clear),
        scale: pass.readableScale,
        scaleCandidates: pass.scaleCandidates,
    };
}

/**
 * The style the shadow is worn with. Its radius follows the corner the clip actually draws: a pass
 * that clips nothing shows a square window, so its shadow is the square one.
 */
export function shadowStyleFrom(pass) {
    return {...pass.style, radius: pass.drawClip ? pass.style.radius : 0};
}
