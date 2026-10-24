/** One baked buffer per style, shared by every window wearing it; geometry: shadowGeometry.js. */

import Cogl from 'gi://Cogl';

import {CODE, DECLARATIONS, SHADOW_LAYER_COUNT, SHADOW_UNIFORMS} from './shadowShader.generated.js';
import {SHADOW_PAD, shadowGeometry} from './shadowGeometry.js';
import {Diagnostic, shadowBakeFailureWarning} from '../lib/diagnosticInvariants.js';
import {journal} from '../platform/journal.js';

const NO_SHADOW = Object.freeze({blur: 0, spread: 0, alpha: 0});

const CLEAR_COLOR_BUFFER = 1; // Cogl BUFFER_BIT_COLOR (GIR omits enum)

const OPAQUE_WHITE = new Cogl.Color({red: 255, green: 255, blue: 255, alpha: 255});

const pipelines = new Map(); // styleKey -> Cogl.Pipeline with baked texture
let destroyed = false; // sealed after destroy()
// One line per episode, re-armed by a good bake; session-level because the cache is shared.
const bakeDiagnostic = new Diagnostic(journal, 1);

export function destroy() {
    destroyed = true;
    pipelines.clear();
}

export function reset() {
    destroyed = false;
    bakeDiagnostic.reset();
}

/** The colour a style's layers are drawn in: the first that names one, else black. */
function styleColor(shadows) {
    return shadows.find(s => s.color)?.color ?? [0, 0, 0];
}

export function styleKey(radius, shadows) {
    // Include color in key to prevent collision between light and dark theme bakes.
    const layers = shadows.map(s => `${s.blur},${s.spread},${s.alpha},${(s.color ?? [0, 0, 0]).join(',')}`);
    return `${radius}|${layers.join(';')}`;
}

/** @param context - a Cogl context, and it exists only inside paint. */
function shadowPipeline(context, radius, shadows) {
    if (destroyed)
        return null;

    const key = styleKey(radius, shadows);
    const cached = pipelines.get(key);
    if (cached)
        return cached;

    // No gate: a failed bake is retried by the next paint, which is what Clutter's own
    // ClutterOffscreenEffect does when its framebuffer cannot be allocated. A shortage clears on
    // its own, and the diagnostic - one line per episode - is what keeps the retry quiet.
    const pipeline = bake(context, radius, shadows);
    if (pipeline)
        pipelines.set(key, pipeline);
    return pipeline;
}

/** Per-window pipeline over the shared baked texture, so each cross-fades its own opacity. */
export function shadowPipelineFor(context, radius, shadows) {
    const source = shadowPipeline(context, radius, shadows);
    if (!source)
        return null;

    const pipeline = Cogl.Pipeline.new(context);
    pipeline.set_layer_texture(0, source.get_layer_texture(0));
    return pipeline;
}

export function setPipelineOpacity(pipeline, opacity) {
    const alpha = Math.round(Math.max(0, Math.min(1, opacity)) * 255);
    pipeline.set_color(new Cogl.Color({red: 255, green: 255, blue: 255, alpha}));
}

/** Names and arities come from the shader: a key it does not declare uploads undefined, not -1. */
function upload(pipeline, key, values) {
    const {name, components} = SHADOW_UNIFORMS[key];
    uniform(pipeline, name, components, values);
}

function bake(context, radius, shadows) {
    const {buffer, window} = shadowGeometry(radius);

    const texture = Cogl.Texture2D.new_with_size(context, buffer, buffer);
    const framebuffer = Cogl.Offscreen.new_with_texture(texture);
    // `cogl_framebuffer_allocate` takes a GError, so GJS raises on failure instead of returning
    // false; the throw has to be caught here or it escapes the actor's paint.
    try {
        framebuffer.allocate();
    } catch {
        // No pass-apart settle here: an allocation either succeeds or not, so one failure speaks.
        bakeDiagnostic.check(shadowBakeFailureWarning(buffer));
        return null;
    }
    bakeDiagnostic.check(null);

    const pipeline = Cogl.Pipeline.new(context);
    pipeline.set_color(OPAQUE_WHITE);
    pipeline.add_snippet(Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE));
    upload(pipeline, 'winSize', [window, window]);
    upload(pipeline, 'radius', [radius]);
    upload(pipeline, 'pad', [SHADOW_PAD, SHADOW_PAD]);
    const color = styleColor(shadows);
    upload(pipeline, 'color', [color[0] / 255, color[1] / 255, color[2] / 255, 1]);
    for (let i = 0; i < SHADOW_LAYER_COUNT; i++) {
        const layer = shadows[i] ?? NO_SHADOW;
        upload(pipeline, `shadow${i + 1}`, [layer.blur, layer.spread, layer.alpha, 0]);
    }

    pipeline.set_layer_texture(0, Cogl.Texture2D.new_with_size(context, 1, 1));

    framebuffer.orthographic(0, 0, buffer, buffer, -1, 1);
    framebuffer.clear4f(CLEAR_COLOR_BUFFER, 0, 0, 0, 0);
    framebuffer.draw_textured_rectangle(pipeline, 0, 0, buffer, buffer, 0, 0, 1, 1);
    context.flush();

    const drawing = Cogl.Pipeline.new(context);
    drawing.set_color(OPAQUE_WHITE);
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
