/**
 * RoundedClipEffect: clips the window body to a rounded rect with optional 1px inner outline.
 * Dynamic geometry is computed live on each paint frame to prevent resize lag;
 * styling decisions (radius, insets, outline) are updated via setParams().
 */

import GObject from 'gi://GObject';
import Cogl from 'gi://Cogl';
import {ShaderEffect} from '../platform/shaderEffect.js';

import {ZERO_INSETS} from '../lib/frame.js';
import {clipFrameFor} from '../lib/snap.js';
import {clipGeometryChanges, clipParamChanges} from './clipParams.js';
import {findMetaWindow, getWindowSubpixelOffset} from '../platform/window.js';
import {EFFECT_PADDING_ORIGIN, EFFECT_PADDING_EXTRA} from '../lib/clutterEffectPadding.generated.js';

const DECLARATIONS = `
uniform vec2 uSize;       // Actor size in px
uniform vec4 uFrame;      // Body rect in actor coords: x, y, w, h (px)
uniform float uRadius;    // Corner radius in px
uniform vec4 uOutline;    // Inner outline r,g,b in [0,1], a in [0,1]; a=0 disables
uniform float uErase;       // 1 erases outer bounding rect and ring, 0 keeps ring
uniform float uClearStroke; // 1 pushes sampling coords inward to erase client CSD stroke, 0 samples 1:1
uniform float uScale;       // Physical device scale factor

// Clutter effect padding: 2px top-left offset, 3px total enlargement
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

    float effR = min(uRadius, min(frameHalf.x, frameHalf.y));
    float d = sdRoundedBox(fromCenter, frameHalf, effR);
    vec2 q = abs(fromCenter) - frameHalf + effR;
    bool isCorner = q.x > 0.0 && q.y > 0.0;

    // Push sampling coords inward along boundary normal to avoid fractional bilinear stroke bleed:
    vec2 sampleP = p;
    if (uClearStroke > 0.5) {
        float maxInset = max(0.0, min(frameHalf.x, frameHalf.y) - 0.5);
        float inset = min(1.0 + 0.5 / uScale, maxInset);
        vec2 v = max(q, 0.0);
        float vLen = length(v);
        if (vLen > 0.0001) {
            vec2 normal = (v / vLen) * sign(fromCenter);
            sampleP = p - normal * max(0.0, d + inset);
        }
    }
    cogl_color_out = cogl_color_in * texture2D(cogl_sampler0, sampleP / quadSize);

    vec2 beyond = step(vec2(0.0), abs(fromCenter) - frameHalf);
    float inSquare = 1.0 - max(beyond.x, beyond.y);

    if (uOutline.a > 0.0) {
        // Physical 1px outline centred half a physical pixel inside the body:
        float m = clamp((d + 0.5) * uScale + 1.0, 0.0, 1.0) * inSquare * uOutline.a * cogl_color_in.a;
        cogl_color_out.rgb = uOutline.rgb * m + cogl_color_out.rgb * (1.0 - m);
        cogl_color_out.a = m + cogl_color_out.a * (1.0 - m);
    }

    // Physical 1px anti-aliasing transition on corner arcs:
    float corner = 1.0 - clamp(d * uScale + 0.5, 0.0, 1.0);
    float keep = min(corner + 1.0 - inSquare, 1.0);
    float straight = mix(1.0, inSquare, uErase);
    float edgeFactor = isCorner ? mix(keep, corner, uErase) : straight;
    cogl_color_out *= edgeFactor;
`;

export const ROUNDED_CLIP_G_TYPE = 'WindowNativizerRoundedClipEffect';

export const RoundedClipEffect = GObject.registerClass({
    GTypeName: ROUNDED_CLIP_G_TYPE,
}, class RoundedClipEffect extends ShaderEffect {
    static getShaderSource() {
        return {
            hook: Cogl.SnippetHook.FRAGMENT,
            declarations: DECLARATIONS,
            code: CODE,
            replace: false,
        };
    }

    _init() {
        super._init();

        // Decisions only; geometry lives in vfunc_paint_target.
        this._insets = ZERO_INSETS;
        this._radius = undefined;
        this._outline = undefined;
        this._outlineVec = [0, 0, 0, 0];
        this._erase = undefined;
        this._clearStroke = undefined;

        // Cached geometry and reusable arrays to avoid per-frame allocations and
        // redundant GPU uniform uploads.
        this._paint = {
            scale: -1,
            width: 0,
            height: 0,
            frame: {x: -1, y: -1, width: -1, height: -1},
        };
        this._scale = 1.0;

        this._sizeVec = [0, 0];
        this._frameVec = [0, 0, 0, 0];
        this._scaleVec = [1.0];
        this._radiusVec = [0];
        this._eraseVec = [0];
        this._clearStrokeVec = [0];
    }

    /**
     * Store the decisions. Geometry is not here: it is read from the actor every paint.
     * @param {object} params
     * @param {import('../lib/frame.js').Insets} params.insets - Ring between actor and body
     * @param {number} params.radius - Corner radius in px
     * @param {{color:number[],alpha:number}|null} params.outline
     * @param {boolean} [params.erase=false]
     * @param {boolean} [params.clearStroke=false]
     * @param {number} [params.scale=1.0] - Monitor fractional/integer scale
     */
    setParams({insets, radius, outline, erase = false, clearStroke = false, scale = 1.0}) {
        const changes = clipParamChanges({
            insets: this._insets,
            radius: this._radius,
            outline: this._outlineVec,
            erase: this._erase,
            clearStroke: this._clearStroke,
            scale: this._scale,
        }, {insets, radius, outline, erase, clearStroke, scale});
        if (!changes.changed)
            return;

        this._insets = {left: insets.left, top: insets.top, right: insets.right, bottom: insets.bottom};
        this._radius = radius;
        this._outline = outline;
        this._erase = Boolean(erase);
        this._clearStroke = Boolean(clearStroke);
        if (changes.scale !== undefined)
            this._scale = changes.scale;

        if (changes.radius !== undefined) {
            this._radiusVec[0] = changes.radius;
            this.set_uniform_float('uRadius', 1, this._radiusVec);
        }

        if (changes.outline !== undefined) {
            this._outlineVec = changes.outline;
            this.set_uniform_float('uOutline', 4, this._outlineVec);
        }

        if (changes.erase !== undefined) {
            this._eraseVec[0] = changes.erase ? 1 : 0;
            this.set_uniform_float('uErase', 1, this._eraseVec);
        }

        if (changes.clearStroke !== undefined) {
            this._clearStrokeVec[0] = changes.clearStroke ? 1 : 0;
            this.set_uniform_float('uClearStroke', 1, this._clearStrokeVec);
        }

        // Insets changed: invalidate cached frame geometry so vfunc_paint_target
        // is forced to recalculate and re-upload uFrame on the next paint pass.
        if (changes.frame)
            this._paint.frame.width = -1;

        this.queue_repaint();
    }

    /**
     * Executes the offscreen clip shader using actor's live dimensions and snapped frame.
     * @param {object} node
     * @param {object} paintContext
     */
    vfunc_paint_target(node, paintContext) {
        const actor = this.get_actor();
        const width = actor?.width ?? 0;
        const height = actor?.height ?? 0;
        if (!(width > 0) || !(height > 0))
            return;

        const scale = this._scale ?? 1.0;
        // Mutter draws a Wayland surface at the integer physical grid, so the buffer the shader
        // samples is offset from the actor by the subpixel remainder. clipFrameFor folds that
        // same phase in - the one the shadow actor carries as a translation - so the clip's cut
        // and the shadow's cutout stay on one line. Snapping actor-local alone would cut the
        // hard straight edge up to half a physical pixel off that buffer, and the stage resampler
        // then renders the straddled output pixel at partial alpha - a transparent line along it.
        const frame = clipFrameFor({width, height}, this._insets, scale,
            getWindowSubpixelOffset(findMetaWindow(actor)));
        const changes = clipGeometryChanges(this._paint, {scale, width, height, frame});

        if (changes.scale !== undefined) {
            this._scaleVec[0] = changes.scale;
            this.set_uniform_float('uScale', 1, this._scaleVec);
            this._paint.scale = changes.scale;
        }

        if (changes.size !== undefined) {
            this._sizeVec[0] = changes.size[0];
            this._sizeVec[1] = changes.size[1];
            this.set_uniform_float('uSize', 2, this._sizeVec);
            this._paint.width = changes.size[0];
            this._paint.height = changes.size[1];
        }

        if (changes.frame !== undefined) {
            this._frameVec[0] = changes.frame[0];
            this._frameVec[1] = changes.frame[1];
            this._frameVec[2] = changes.frame[2];
            this._frameVec[3] = changes.frame[3];
            this.set_uniform_float('uFrame', 4, this._frameVec);
            this._paint.frame.x = changes.frame[0];
            this._paint.frame.y = changes.frame[1];
            this._paint.frame.width = changes.frame[2];
            this._paint.frame.height = changes.frame[3];
        }

        super.vfunc_paint_target(node, paintContext);
    }
});
