/**
 * RoundedClipEffect: clips the window body to a rounded rect with optional 1px inner outline.
 * See docs/architecture.md (Rounded clip) for body vs actor, SDF and clearRing.
 *
 * Geometry is computed in `vfunc_paint_target`, from the actor's live size plus the insets
 * stored here. The body rect used to be snapshotted by the manager's 50ms reconcile, which
 * is why a resize showed square corners for every frame between two reconciles; the actor
 * size cannot lag the actor, so the clip cannot either. `setParams` now carries only the
 * decisions (insets, radius, outline, clearRing), and those may stay debounced.
 */

import GObject from 'gi://GObject';
import Cogl from 'gi://Cogl';
import Shell from 'gi://Shell';

import {bodyFrame, ZERO_INSETS} from '../lib/frame.js';
import {EFFECT_PADDING_ORIGIN, EFFECT_PADDING_EXTRA} from '../lib/clutterEffectPadding.generated.js';

const DECLARATIONS = `
uniform vec2 uSize;       // Actor size in px
uniform vec4 uFrame;      // Body rect in actor coords: x, y, w, h (px)
uniform float uRadius;    // Corner radius in px
uniform vec4 uOutline;    // Inner outline r,g,b in [0,1], a in [0,1]; a=0 disables
uniform float uClearRing; // 1 erases client shadow ring, 0 keeps it

// _clutter_actor_box_enlarge_for_effects (tools/gen-clutter.mjs) pads 2px top-left, 3px total
const vec2 FBO_OFFSET = vec2(${EFFECT_PADDING_ORIGIN.toFixed(1)}, ${EFFECT_PADDING_ORIGIN.toFixed(1)});
const vec2 FBO_EXTRA  = vec2(${EFFECT_PADDING_EXTRA.toFixed(1)}, ${EFFECT_PADDING_EXTRA.toFixed(1)});

float sdRoundedBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
`;

const CODE = `
    vec2 quadSize = uSize + FBO_EXTRA;
    vec2 p = cogl_tex_coord0_in.xy * quadSize;

    vec2 frameCenter = uFrame.xy + uFrame.zw * 0.5 + FBO_OFFSET;
    vec2 frameHalf = uFrame.zw * 0.5;
    vec2 fromCenter = p - frameCenter;
    float d = sdRoundedBox(fromCenter, frameHalf, uRadius);

    vec2 beyond = step(vec2(0.0), abs(fromCenter) - frameHalf);
    float inSquare = 1.0 - max(beyond.x, beyond.y);

    if (uOutline.a > 0.0) {
        // 1.5, not 1.0: the ring's centre is half a pixel inside the body, so the
        // innermost pixel's centre (d = -0.5) has to be fully covered. libadwaita's
        // 7% ring measures that at offset 0 (decoration-alignment.md).
        float m = clamp(1.5 + d, 0.0, 1.0) * inSquare * uOutline.a * cogl_color_in.a;
        cogl_color_out.rgb = uOutline.rgb * m + cogl_color_out.rgb * (1.0 - m);
        cogl_color_out.a = m + cogl_color_out.a * (1.0 - m);
    }

    float corner = 1.0 - clamp(d + 0.5, 0.0, 1.0);
    float keep = min(corner + 1.0 - inSquare, 1.0);
    cogl_color_out *= mix(keep, corner * inSquare, uClearRing);
`;

export const ROUNDED_CLIP_G_TYPE = 'WindowNativizerRoundedClipEffect';

export const RoundedClipEffect = GObject.registerClass({
    GTypeName: ROUNDED_CLIP_G_TYPE,
}, class RoundedClipEffect extends Shell.GLSLEffect {
    _init() {
        super._init();
        this._uSize = this.get_uniform_location('uSize');
        this._uFrame = this.get_uniform_location('uFrame');
        this._uRadius = this.get_uniform_location('uRadius');
        this._uOutline = this.get_uniform_location('uOutline');
        this._uClearRing = this.get_uniform_location('uClearRing');

        // Decisions only; geometry lives in vfunc_paint_target.
        this._insets = ZERO_INSETS;
        this._radius = undefined;
        this._outline = undefined;
        this._outlineVec = [0, 0, 0, 0];
        this._clearRing = undefined;

        // Cached geometry and reusable arrays to avoid per-frame allocations and
        // redundant GPU uniform uploads.
        this._lastWidth = 0;
        this._lastHeight = 0;
        this._lastFrameX = -1;
        this._lastFrameY = -1;
        this._lastFrameW = -1;
        this._lastFrameH = -1;

        this._sizeVec = [0, 0];
        this._frameVec = [0, 0, 0, 0];
        this._radiusVec = [0];
        this._clearRingVec = [0];
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT,
            DECLARATIONS, CODE, false);
    }

    /**
     * Store the decisions. Geometry is not here: it is read from the actor every paint.
     * @param {object} params
     * @param {import('../lib/frame.js').Insets} params.insets - Ring between actor and body
     * @param {number} params.radius - Corner radius in px
     * @param {{color:number[],alpha:number}|null} params.outline
     * @param {boolean} [params.clearRing=false]
     */
    setParams({insets, radius, outline, clearRing = false}) {
        const nextOutlineVec = outline
            ? [
                outline.color[0] > 1 ? outline.color[0] / 255 : outline.color[0],
                outline.color[1] > 1 ? outline.color[1] / 255 : outline.color[1],
                outline.color[2] > 1 ? outline.color[2] / 255 : outline.color[2],
                outline.alpha,
            ]
            : [0, 0, 0, 0];
        const outlineChanged = !this._outlineVec ||
            this._outlineVec[0] !== nextOutlineVec[0] ||
            this._outlineVec[1] !== nextOutlineVec[1] ||
            this._outlineVec[2] !== nextOutlineVec[2] ||
            this._outlineVec[3] !== nextOutlineVec[3];

        const last = this._insets;
        if (last.left === insets.left && last.top === insets.top &&
            last.right === insets.right && last.bottom === insets.bottom &&
            this._radius === radius && !outlineChanged &&
            this._clearRing === clearRing)
            return;

        const insetsChanged = last.left !== insets.left || last.top !== insets.top ||
            last.right !== insets.right || last.bottom !== insets.bottom;
        const radiusChanged = this._radius !== radius;
        const clearRingChanged = this._clearRing !== clearRing;

        this._insets = {left: insets.left, top: insets.top, right: insets.right, bottom: insets.bottom};
        this._radius = radius;
        this._outline = outline;
        this._clearRing = clearRing;

        if (radiusChanged) {
            this._radiusVec[0] = radius;
            this.set_uniform_float(this._uRadius, 1, this._radiusVec);
        }

        if (outlineChanged) {
            this._outlineVec = nextOutlineVec;
            this.set_uniform_float(this._uOutline, 4, this._outlineVec);
        }

        if (clearRingChanged) {
            this._clearRingVec[0] = clearRing ? 1 : 0;
            this.set_uniform_float(this._uClearRing, 1, this._clearRingVec);
        }

        // Insets changed: invalidate cached frame geometry so vfunc_paint_target
        // is forced to recalculate and re-upload uFrame on the next paint pass.
        if (insetsChanged)
            this._lastFrameW = -1;

        this.queue_repaint();
    }

    /**
     * Runs after Clutter has sized the offscreen for this frame, so the actor's size is
     * the one being painted. Coming back here also means no `queue_repaint`: this is the
     * paint, not a decision that invalidates it.
     * @param {object} node
     * @param {object} paintContext
     */
    vfunc_paint_target(node, paintContext) {
        const actor = this.get_actor();
        const width = actor?.width ?? 0;
        const height = actor?.height ?? 0;
        // Only a degenerate actor (nothing to show) skips the pass. The shadow is derived
        // from the same actor and is degenerate with it, so there is no visible "shadow but
        // no clip" frame: the body this would have left square has no area either.
        if (!(width > 0) || !(height > 0))
            return;

        // The ring can outrun the actor for the frame a resize passes through (insets are
        // debounced, the actor is not). `bodyFrame` then returns the whole actor, so the pass
        // still runs: a body with no area is not the same as a frame with nothing to draw.
        const frame = bodyFrame({width, height}, this._insets);

        if (this._lastWidth !== width || this._lastHeight !== height) {
            this._sizeVec[0] = width;
            this._sizeVec[1] = height;
            this.set_uniform_float(this._uSize, 2, this._sizeVec);
            this._lastWidth = width;
            this._lastHeight = height;
        }

        if (this._lastFrameX !== frame.x || this._lastFrameY !== frame.y ||
            this._lastFrameW !== frame.width || this._lastFrameH !== frame.height) {
            this._frameVec[0] = frame.x;
            this._frameVec[1] = frame.y;
            this._frameVec[2] = frame.width;
            this._frameVec[3] = frame.height;
            this.set_uniform_float(this._uFrame, 4, this._frameVec);
            this._lastFrameX = frame.x;
            this._lastFrameY = frame.y;
            this._lastFrameW = frame.width;
            this._lastFrameH = frame.height;
        }

        super.vfunc_paint_target(node, paintContext);
    }
});
