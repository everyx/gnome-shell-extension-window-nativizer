/**
 * Shadow baking: one baked buffer per style, sliced into 8 rects (see docs/architecture.md).
 * The pure geometry it bakes and slices lives in shadowGeometry.js.
 */

import Cogl from 'gi://Cogl';

import {DECLARATIONS, CODE} from './shadowShader.generated.js';
import {SHADOW_PAD, shadowGeometry} from './shadowGeometry.js';

const LAYER_COUNT = 3; // shader has 3 layers

const NO_SHADOW = Object.freeze({blur: 0, spread: 0, alpha: 0});

const CLEAR_COLOR_BUFFER = 1; // Cogl BUFFER_BIT_COLOR (GIR omits enum)

const opaqueWhite = () => new Cogl.Color({red: 255, green: 255, blue: 255, alpha: 255});

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
 * @param {object|null} [border]
 * @returns {string}
 */
/** The colour a style's layers are drawn in: the first one that names a colour, else black. */
export function styleColor(shadows) {
    return shadows.find(s => s.color)?.color ?? [0, 0, 0];
}

export function styleKey(radius, shadows) {
    // The colour is part of the key: the tiled ring is a layer like any other and its colour is the
    // one that changes with the theme, so without it a light and a dark bake would collide.
    const layers = shadows.map(s => `${s.blur},${s.spread},${s.alpha},${(s.color ?? [0, 0, 0]).join(',')}`);
    return `${radius}|${layers.join(';')}`;
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
    const color = styleColor(shadows);
    uniform(pipeline, 'uColor', 4, [color[0] / 255, color[1] / 255, color[2] / 255, 1]);
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
