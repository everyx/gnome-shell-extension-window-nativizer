// One decoration pass as both cuts read it: resolved style, worn ring, settle plan, clip target.

import {ZERO_INSETS} from '../lib/frame.js';

/** readableScale stays null while no scale was read: the clip cannot be handed the 1.0 default. */
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

/** A draw-nothing pass still states radius 0 and no outline, so no pass inherits a stale corner. */
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

/** The shadow radius follows the corner the clip draws: a pass clipping nothing shows it square. */
export function shadowStyleFrom(pass) {
    return {...pass.style, radius: pass.drawClip ? pass.style.radius : 0};
}
