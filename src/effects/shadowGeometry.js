/**
 * Pure shadow geometry: the baked square and how it slices across a window.
 *
 * Kept free of GI imports so the degenerate-size rules stay unit-testable; the Cogl
 * bake lives in shadowTexture.js.
 */

import {ADWAITA_STYLE} from '../lib/adwaitaStyle.generated.js';
import {EFFECT_PADDING_ORIGIN, EFFECT_PADDING_EXTRA} from '../lib/clutterEffectPadding.generated.js';
import {bodyFrame} from '../lib/frame.js';

// px; derived by tools/gen-style.mjs from the farthest Gaussian reach over every shadow
// layer (blur 14: 3 sigma = 21, + spread 5) plus the Cogl offscreen offset below.
export const SHADOW_PAD = ADWAITA_STYLE.shadowPad;

// Cogl/Clutter `_clutter_actor_box_enlarge_for_effects` (vendor/mutter/clutter-actor-box.c,
// parsed by tools/gen-clutter.mjs): an offscreen is padded 2px top/left and 1px right/bottom,
// 3px total per axis. The bake buffer carries the 3px (`BAKE_EXTRA`), and the shader's window
// origin sits at the 2px offset (`BAKE_ORIGIN`), both from the single generated source.
const BAKE_ORIGIN = EFFECT_PADDING_ORIGIN;
const BAKE_EXTRA = EFFECT_PADDING_EXTRA;

/**
 * Canonical square 2*(pad+radius) with middle 2*pad (settled strip).
 * Corner slice spans 2*pad+radius so the cutline sits at the settled profile (C0 continuity).
 * @param {number} radius - Corner radius in px
 * @returns {{corner:number,window:number,buffer:number}} sizes in px
 */
export function shadowGeometry(radius) {
    const corner = 2 * SHADOW_PAD + radius;
    const window = 2 * (SHADOW_PAD + radius);
    return {
        corner,
        window,
        buffer: 2 * corner + BAKE_EXTRA,
    };
}

/**
 * The rect the eight slices are laid out over. The shadow actor is bound to the window actor
 * `2*SHADOW_PAD` larger, so the buffer under its live size is that size less the pad; the body is
 * the frame inside the buffer - the same `bodyFrame` the clip reads - and the cast is that body
 * grown back by the pad. One rect, so the hollow middle the slices leave is the frame the clip
 * draws: a declared ring of any width moves the shadow with the body, never off it.
 *
 * @param {{width: number, height: number}} actorSize - Shadow actor's live size in px
 * @param {import('../lib/frame.js').Insets} [insets] - Ring the client declared, per side
 * @returns {{x:number,y:number,width:number,height:number}} Cast rect in actor coords
 */
export function shadowCastRect(actorSize, insets) {
    const body = bodyFrame({
        width: actorSize.width - SHADOW_PAD * 2,
        height: actorSize.height - SHADOW_PAD * 2,
    }, insets);
    return {
        x: body.x,
        y: body.y,
        width: body.width + SHADOW_PAD * 2,
        height: body.height + SHADOW_PAD * 2,
    };
}

/**
 * 8 rects (4 corners 1:1, 4 edges stretched from 1px strip), no middle — hollow mask.
 *
 * Sizes are clamped to the non-negative axis: a window mid-resize can pass a degenerate
 * or transiently negative cast, and unclamped corner math would then emit slices whose
 * x1 > x2 (inverted texture coordinates) instead of an empty one.
 *
 * @param {{corner:number,window:number,buffer:number}} geometry
 * @param {number} width - Padded rect width in px
 * @param {number} height - Padded rect height in px
 * @returns {Array<{x1:number,y1:number,x2:number,y2:number,s1:number,t1:number,s2:number,t2:number}>}
 */
export function shadowSlices({corner, window, buffer}, width, height) {
    const safeW = Math.max(0, width);
    const safeH = Math.max(0, height);
    const c = Math.max(0, Math.min(corner, safeW / 2, safeH / 2));
    const o = BAKE_ORIGIN;
    const near = o / buffer;
    const span = corner / buffer;
    const strip = 1 / buffer;
    const far = (buffer - corner - 1) / buffer;
    const edge = (o + SHADOW_PAD + window / 2) / buffer;
    const right = Math.max(c, safeW - c);
    const bottom = Math.max(c, safeH - c);

    return [
        {x1: 0, y1: 0, x2: c, y2: c, s1: near, t1: near, s2: near + span, t2: near + span},
        {x1: right, y1: 0, x2: safeW, y2: c, s1: far, t1: near, s2: far + span, t2: near + span},
        {x1: 0, y1: bottom, x2: c, y2: safeH, s1: near, t1: far, s2: near + span, t2: far + span},
        {x1: right, y1: bottom, x2: safeW, y2: safeH, s1: far, t1: far, s2: far + span, t2: far + span},
        {x1: c, y1: 0, x2: right, y2: c, s1: edge, t1: near, s2: edge + strip, t2: near + span},
        {x1: c, y1: bottom, x2: right, y2: safeH, s1: edge, t1: far, s2: edge + strip, t2: far + span},
        {x1: 0, y1: c, x2: c, y2: bottom, s1: near, t1: edge, s2: near + span, t2: edge + strip},
        {x1: right, y1: c, x2: safeW, y2: bottom, s1: far, t1: edge, s2: far + span, t2: edge + strip},
    ];
}
