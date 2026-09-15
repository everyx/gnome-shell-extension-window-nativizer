/**
 * Shadow baking: one baked buffer per style, sliced into 8 rects (see docs/architecture.md).
 */

import Cogl from 'gi://Cogl';

import {ADWAITA_STYLE} from '../lib/adwaitaStyle.generated.js';
import {DECLARATIONS, CODE} from './shadowShader.generated.js';

// px; derived by tools/gen-style.mjs from the farthest Gaussian reach over every shadow
// layer (blur 14: 3 sigma = 21, + spread 5) plus the Cogl offscreen offset below.
export const SHADOW_PAD = ADWAITA_STYLE.shadowPad;

const LAYER_COUNT = 3; // shader has 3 layers

// Cogl/Clutter `_clutter_actor_box_enlarge_for_effects` (clutter-actor-box.c; not vendored,
// source visible in the research/mutter clone): an offscreen is padded 2px top/left and 1px
// right/bottom, 3px total per axis. The bake buffer carries the 3px (`BAKE_EXTRA`), and the
// shader's window origin sits at the 2px offset (`BAKE_ORIGIN`, mirrors gen-shader.mjs FBO_OFFSET).
const BAKE_ORIGIN = 2;
const BAKE_EXTRA = 3;

const NO_SHADOW = Object.freeze({blur: 0, spread: 0, alpha: 0});

const CLEAR_COLOR_BUFFER = 1; // Cogl BUFFER_BIT_COLOR (GIR omits enum)

const opaqueWhite = () => new Cogl.Color({red: 255, green: 255, blue: 255, alpha: 255});

/**
 * Canonical square 2*(pad+radius) with middle 2*pad (settled strip).
 * @param {number} radius - Corner radius in px
 * @returns {{corner:number,window:number,buffer:number}} sizes in px
 */
export function shadowGeometry(radius) {
    const corner = SHADOW_PAD + radius;
    return {
        corner,
        window: 2 * corner,
        buffer: 2 * corner + 2 * SHADOW_PAD + BAKE_EXTRA,
    };
}

/**
 * 8 rects (4 corners 1:1, 4 edges stretched from 1px strip), no middle — hollow mask.
 * @param {{corner:number,window:number,buffer:number}} geometry
 * @param {number} width - Padded rect width in px
 * @param {number} height - Padded rect height in px
 * @returns {Array<{x1:number,y1:number,x2:number,y2:number,s1:number,t1:number,s2:number,t2:number}>}
 */
export function shadowSlices({corner, window, buffer}, width, height) {
    const c = Math.min(corner, width / 2, height / 2);
    const o = BAKE_ORIGIN;
    const near = o / buffer;
    const span = corner / buffer;
    const strip = 1 / buffer;
    const far = (buffer - corner - 1) / buffer;
    const edge = (o + SHADOW_PAD + window / 2) / buffer;
    const right = width - c;
    const bottom = height - c;

    return [
        {x1: 0, y1: 0, x2: c, y2: c, s1: near, t1: near, s2: near + span, t2: near + span},
        {x1: right, y1: 0, x2: width, y2: c, s1: far, t1: near, s2: far + span, t2: near + span},
        {x1: 0, y1: bottom, x2: c, y2: height, s1: near, t1: far, s2: near + span, t2: far + span},
        {x1: right, y1: bottom, x2: width, y2: height, s1: far, t1: far, s2: far + span, t2: far + span},
        {x1: c, y1: 0, x2: right, y2: c, s1: edge, t1: near, s2: edge + strip, t2: near + span},
        {x1: c, y1: bottom, x2: right, y2: height, s1: edge, t1: far, s2: edge + strip, t2: far + span},
        {x1: 0, y1: c, x2: c, y2: bottom, s1: near, t1: edge, s2: near + span, t2: edge + strip},
        {x1: right, y1: c, x2: width, y2: bottom, s1: far, t1: edge, s2: far + span, t2: edge + strip},
    ];
}

const pipelines = new Map(); // styleKey -> Cogl.Pipeline with baked texture
let destroyed = false; // sealed after destroy()

/**
 * Clears baked cache and seals it until reset().
 */
export function destroy() {
    destroyed = true;
    pipelines.clear();
}

export function reset() {
    destroyed = false;
}

/**
 * @param {number} radius
 * @param {Array<object>} shadows
 * @returns {string}
 */
export function styleKey(radius, shadows) {
    return `${radius}|${shadows.map(s => `${s.blur},${s.spread},${s.alpha}`).join(';')}`;
}

/**
 * @param {Cogl.Context} context - exists only inside paint
 * @param {number} radius
 * @param {Array<object>} shadows
 * @returns {Cogl.Pipeline|null}
 */
function shadowPipeline(context, radius, shadows) {
    if (destroyed)
        return null;

    const key = styleKey(radius, shadows);
    const cached = pipelines.get(key);
    if (cached)
        return cached;

    const pipeline = bake(context, radius, shadows);
    if (pipeline)
        pipelines.set(key, pipeline);
    return pipeline;
}

/**
 * Per-window pipeline sharing the baked texture (for cross-fade opacity).
 *
 * @param {Cogl.Context} context
 * @param {number} radius
 * @param {Array<object>} shadows
 * @returns {Cogl.Pipeline|null}
 */
export function shadowPipelineFor(context, radius, shadows) {
    const source = shadowPipeline(context, radius, shadows);
    if (!source)
        return null;

    const pipeline = Cogl.Pipeline.new(context);
    pipeline.set_layer_texture(0, source.get_layer_texture(0));
    return pipeline;
}

/**
 * @param {Cogl.Pipeline} pipeline
 * @param {number} opacity - 0..1
 */
export function setPipelineOpacity(pipeline, opacity) {
    const alpha = Math.round(Math.max(0, Math.min(1, opacity)) * 255);
    pipeline.set_color(new Cogl.Color({red: 255, green: 255, blue: 255, alpha}));
}

function bake(context, radius, shadows) {
    const {buffer, window} = shadowGeometry(radius);

    const texture = Cogl.Texture2D.new_with_size(context, buffer, buffer);
    const framebuffer = Cogl.Offscreen.new_with_texture(texture);
    if (!framebuffer.allocate()) {
        console.warn(`[window-nativizer] Could not allocate a ${buffer}x${buffer} shadow buffer`);
        return null;
    }

    const pipeline = Cogl.Pipeline.new(context);
    pipeline.set_color(opaqueWhite());
    pipeline.add_snippet(Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE));
    uniform(pipeline, 'uWinSize', 2, [window, window]);
    uniform(pipeline, 'uRadius', 1, [radius]);
    uniform(pipeline, 'uPad', 2, [SHADOW_PAD, SHADOW_PAD]);
    for (let i = 0; i < LAYER_COUNT; i++) {
        const layer = shadows[i] ?? NO_SHADOW;
        uniform(pipeline, `uShadow${i + 1}`, 4, [layer.blur, layer.spread, layer.alpha, 0]);
    }

    pipeline.set_layer_texture(0, Cogl.Texture2D.new_with_size(context, 1, 1));

    framebuffer.orthographic(0, 0, buffer, buffer, -1, 1);
    framebuffer.clear4f(CLEAR_COLOR_BUFFER, 0, 0, 0, 0);
    framebuffer.draw_textured_rectangle(pipeline, 0, 0, buffer, buffer, 0, 0, 1, 1);
    context.flush();

    const drawing = Cogl.Pipeline.new(context);
    drawing.set_color(opaqueWhite());
    drawing.set_layer_texture(0, texture);
    return drawing;
}

let setUniformFloat = null; // probed once: two GJS signatures for set_uniform_float

function uniform(pipeline, name, components, values) {
    const location = pipeline.get_uniform_location(name);
    if (!setUniformFloat) {
        try {
            pipeline.set_uniform_float(location, components, 1, values);
            setUniformFloat = (target, loc, n, v) => target.set_uniform_float(loc, n, 1, v);
        } catch {
            setUniformFloat = (target, loc, n, v) => target.set_uniform_float(loc, n, v);
        }
    }
    setUniformFloat(pipeline, location, components, values);
}
