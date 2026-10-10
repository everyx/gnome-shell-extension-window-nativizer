/**
 * RoundedClipEffect: clips the window body to a rounded rect with optional 1px inner outline.
 * Dynamic geometry is computed live on each paint frame to prevent resize lag;
 * styling decisions (radius, insets, outline) are updated via setParams().
 */

import GObject from 'gi://GObject';
import Cogl from 'gi://Cogl';
import {ShaderEffect} from '../platform/shaderEffect.js';

import {ZERO_INSETS} from '../lib/frame.js';
import {snapActorBodyFrame} from '../lib/snap.js';
import {EFFECT_PADDING_ORIGIN, EFFECT_PADDING_EXTRA} from '../lib/clutterEffectPadding.generated.js';
import {getWindowSubpixelOffset} from '../platform/window.js';

const DECLARATIONS = `
uniform vec2 uSize;       // Actor size in px
uniform vec4 uFrame;      // Body rect in actor coords: x, y, w, h (px)
uniform float uRadius;    // Corner radius in px
uniform vec4 uOutline;    // Inner outline r,g,b in [0,1], a in [0,1]; a=0 disables
uniform float uClearRing;   // 1 erases outer bounding rect and ring, 0 keeps ring
uniform float uClearStroke; // 1 pushes sampling coords inward to erase client CSD stroke, 0 samples 1:1
uniform float uOverview;    // 1 restores smooth AA across all edges during overview mode, 0 keeps sharp desktop edges
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

    // Physical 1px anti-aliasing transition on corner arcs (or entire perimeter during overview):
    float corner = 1.0 - clamp(d * uScale + 0.5, 0.0, 1.0);
    float keep = min(corner + 1.0 - inSquare, 1.0);
    float straight = mix(1.0, inSquare, uClearRing);
    float edgeFactor = isCorner || uOverview > 0.5 ? mix(keep, corner, uClearRing) : straight;
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
        this._clearRing = undefined;
        this._clearStroke = undefined;

        // Cached geometry and reusable arrays to avoid per-frame allocations and
        // redundant GPU uniform uploads.
        this._lastWidth = 0;
        this._lastHeight = 0;
        this._lastFrameX = -1;
        this._lastFrameY = -1;
        this._lastFrameW = -1;
        this._lastFrameH = -1;
        this._lastScale = -1;
        this._lastOverviewMode = null;
        this._scale = 1.0;

        this._sizeVec = [0, 0];
        this._frameVec = [0, 0, 0, 0];
        this._scaleVec = [1.0];
        this._radiusVec = [0];
        this._clearRingVec = [0];
        this._clearStrokeVec = [0];
        this._overviewVec = [0];

        this._overviewMode = false;
    }

    /**
     * Store the decisions. Geometry is not here: it is read from the actor every paint.
     * @param {object} params
     * @param {import('../lib/frame.js').Insets} params.insets - Ring between actor and body
     * @param {number} params.radius - Corner radius in px
     * @param {{color:number[],alpha:number}|null} params.outline
     * @param {boolean} [params.clearRing=false]
     * @param {boolean} [params.clearStroke=false]
     * @param {number} [params.scale=1.0] - Monitor fractional/integer scale
     */
    setParams({insets, radius, outline, clearRing = false, clearStroke = false, scale = 1.0}) {
        const scaleChanged = typeof scale === 'number' && scale > 0 && Number.isFinite(scale) && this._scale !== scale;
        if (scaleChanged)
            this._scale = scale;

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
        const nextClearRing = Boolean(clearRing);
        const nextClearStroke = Boolean(clearStroke);
        if (last.left === insets.left && last.top === insets.top &&
            last.right === insets.right && last.bottom === insets.bottom &&
            this._radius === radius && !outlineChanged &&
            this._clearRing === nextClearRing &&
            this._clearStroke === nextClearStroke &&
            !scaleChanged)
            return;

        const insetsChanged = last.left !== insets.left || last.top !== insets.top ||
            last.right !== insets.right || last.bottom !== insets.bottom;
        const radiusChanged = this._radius !== radius;
        const clearRingChanged = this._clearRing !== nextClearRing;
        const clearStrokeChanged = this._clearStroke !== nextClearStroke;

        this._insets = {left: insets.left, top: insets.top, right: insets.right, bottom: insets.bottom};
        this._radius = radius;
        this._outline = outline;
        this._clearRing = nextClearRing;
        this._clearStroke = nextClearStroke;

        if (radiusChanged) {
            this._radiusVec[0] = radius;
            this.set_uniform_float('uRadius', 1, this._radiusVec);
        }

        if (outlineChanged) {
            this._outlineVec = nextOutlineVec;
            this.set_uniform_float('uOutline', 4, this._outlineVec);
        }

        if (clearRingChanged) {
            this._clearRingVec[0] = nextClearRing ? 1 : 0;
            this.set_uniform_float('uClearRing', 1, this._clearRingVec);
        }

        if (clearStrokeChanged) {
            this._clearStrokeVec[0] = nextClearStroke ? 1 : 0;
            this.set_uniform_float('uClearStroke', 1, this._clearStrokeVec);
        }

        // Insets changed: invalidate cached frame geometry so vfunc_paint_target
        // is forced to recalculate and re-upload uFrame on the next paint pass.
        if (insetsChanged)
            this._lastFrameW = -1;

        this.queue_repaint();
    }

    /**
     * Toggles hardware-filtered mipmapping for downscaled overview thumbnails.
     * @param {boolean} inOverview
     */
    setOverviewMode(inOverview) {
        const next = Boolean(inOverview);
        if (this._overviewMode === next)
            return;
        this._overviewMode = next;
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
        const frame = snapActorBodyFrame({width, height}, this._insets, scale);
        const offset = this._overviewMode
            ? {x: 0, y: 0}
            : getWindowSubpixelOffset(actor?.meta_window, actor);
        frame.x += offset.x;
        frame.y += offset.y;

        if (this._lastOverviewMode !== this._overviewMode) {
            this._overviewVec[0] = this._overviewMode ? 1 : 0;
            this.set_uniform_float('uOverview', 1, this._overviewVec);
            this._lastOverviewMode = this._overviewMode;
        }

        if (this._lastScale !== scale) {
            this._scaleVec[0] = scale;
            this.set_uniform_float('uScale', 1, this._scaleVec);
            this._lastScale = scale;
        }

        if (this._lastWidth !== width || this._lastHeight !== height) {
            this._sizeVec[0] = width;
            this._sizeVec[1] = height;
            this.set_uniform_float('uSize', 2, this._sizeVec);
            this._lastWidth = width;
            this._lastHeight = height;
        }

        if (this._lastFrameX !== frame.x || this._lastFrameY !== frame.y ||
            this._lastFrameW !== frame.width || this._lastFrameH !== frame.height) {
            this._frameVec[0] = frame.x;
            this._frameVec[1] = frame.y;
            this._frameVec[2] = frame.width;
            this._frameVec[3] = frame.height;
            this.set_uniform_float('uFrame', 4, this._frameVec);
            this._lastFrameX = frame.x;
            this._lastFrameY = frame.y;
            this._lastFrameW = frame.width;
            this._lastFrameH = frame.height;
        }

        if (this._overviewMode) {
            const pipeline = this.get_pipeline();
            if (pipeline?.set_layer_filters) {
                // Override layer 0 filters to maintain hardware mipmapping during overview mode.
                pipeline.set_layer_filters(
                    0,
                    Cogl.PipelineFilter.LINEAR_MIPMAP_LINEAR,
                    Cogl.PipelineFilter.LINEAR
                );
            }
        }

        super.vfunc_paint_target(node, paintContext);
    }
});
