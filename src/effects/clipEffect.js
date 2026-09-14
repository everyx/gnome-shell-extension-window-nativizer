/**
 * RoundedClipEffect: clips the window body to a rounded rect with optional 1px inner outline.
 * See docs/architecture.md (Rounded clip) for body vs actor, SDF and clearRing.
 */

import GObject from 'gi://GObject';
import Cogl from 'gi://Cogl';
import Shell from 'gi://Shell';

const DECLARATIONS = `
uniform vec2 uSize;       // Actor size in px
uniform vec4 uFrame;      // Body rect in actor coords: x, y, w, h (px)
uniform float uRadius;    // Corner radius in px
uniform vec4 uOutline;    // Inner outline r,g,b in [0,1], a in [0,1]; a=0 disables
uniform float uClearRing; // 1 erases client shadow ring, 0 keeps it

// _clutter_actor_box_enlarge_for_effects pads 2px top-left, 3px total
const vec2 FBO_OFFSET = vec2(2.0, 2.0);
const vec2 FBO_EXTRA  = vec2(3.0, 3.0);

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

        // Sentinel -1: no window reaches it, first setParams always uploads.
        this._last = {
            width: -1, height: -1, frameX: -1, frameY: -1,
            frameWidth: -1, frameHeight: -1, radius: -1, outline: undefined,
            clearRing: undefined,
        };
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT,
            DECLARATIONS, CODE, false);
    }

    /**
     * @param {object} params
     * @param {number} params.width - Actor width in px
     * @param {number} params.height - Actor height in px
     * @param {{x:number,y:number,width:number,height:number}} params.frame - Body rect in actor coords
     * @param {number} params.radius - Corner radius in px
     * @param {{color:number[],alpha:number}|null} params.outline
     * @param {boolean} [params.clearRing=false]
     */
    setParams({width, height, frame, radius, outline, clearRing = false}) {
        const last = this._last;
        if (last.width === width && last.height === height &&
            last.frameX === frame.x && last.frameY === frame.y &&
            last.frameWidth === frame.width && last.frameHeight === frame.height &&
            last.radius === radius && last.outline === outline &&
            last.clearRing === clearRing)
            return;

        Object.assign(last, {
            width, height, radius, outline, clearRing,
            frameX: frame.x, frameY: frame.y,
            frameWidth: frame.width, frameHeight: frame.height,
        });

        this.set_uniform_float(this._uSize, 2, [width, height]);
        this.set_uniform_float(this._uFrame, 4, [frame.x, frame.y, frame.width, frame.height]);
        this.set_uniform_float(this._uRadius, 1, [radius]);
        const u = outline
            ? [
                outline.color[0] > 1 ? outline.color[0] / 255 : outline.color[0],
                outline.color[1] > 1 ? outline.color[1] / 255 : outline.color[1],
                outline.color[2] > 1 ? outline.color[2] / 255 : outline.color[2],
                outline.alpha,
            ]
            : [0, 0, 0, 0];
        this.set_uniform_float(this._uOutline, 4, u);
        this.set_uniform_float(this._uClearRing, 1, [clearRing ? 1 : 0]);
        this.queue_repaint();
    }
});
