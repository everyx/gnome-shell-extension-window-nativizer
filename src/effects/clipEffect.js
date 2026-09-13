/**
 * Rounded corner clipping effect: attached to the window actor, clips the window
 * BODY to a rounded rectangle and adds an inner highlight outline.
 *
 * The body is not the whole actor. A client-side decorated window reserves a ring
 * of margin around it for its own shadow (buffer_rect - frame_rect), and that ring
 * has to survive untouched. The clip is therefore the frame rectangle *inside* the
 * actor, and only the four corner regions within its square bounds: everything
 * beyond those bounds stays exactly as the client painted it.
 *
 * Shader: signed distance to the body's rounded rectangle
 *   frameCenter/frameHalf come from uFrame, p is the position in the redirected texture
 *   d = sdRoundedBox(p - frameCenter, frameHalf, uRadius)
 *   inside the body d < 0, in a corner to remove d > 0, boundary d = 0
 *   inSquare = 1 while the point stays inside the body's square bounds, which is
 *   what keeps the client's shadow ring out of the cut
 * Rounded clipping: cogl_color_out *= 1.0 - clamp(d + 0.5, 0.0, 1.0) * inSquare
 * Inner highlight outline (libadwaita 1px window outline):
 *   Snugs along inside the body boundary by 1px (d in [-1.0, 0.0])
 *   clamp(1.0 + d, 0.0, 1.0) strictly evaluates to 0 when d <= -1.0
 *   uOutline.rgb normalized to [0.0, 1.0]
 */

import GObject from 'gi://GObject';
import Cogl from 'gi://Cogl';
import Shell from 'gi://Shell';

const DECLARATIONS = `
uniform vec2 uSize;      // Actor size (width, height)
uniform vec4 uFrame;     // Window body inside the actor: x, y, width, height
uniform float uRadius;   // Corner radius
uniform vec4 uOutline;   // Inner highlight (r, g, b, alpha), disabled when alpha=0, rgb in [0.0, 1.0]

// ClutterOffscreenEffect (_clutter_actor_box_enlarge_for_effects)
// Pad 2px top-left to avoid jitter, 3px overall enlargement
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

    // 1 while the point is inside the body's square bounds, 0 out in the margin
    // ring the client filled with its own shadow.
    vec2 beyond = step(vec2(0.0), abs(fromCenter) - frameHalf);
    float inSquare = 1.0 - max(beyond.x, beyond.y);

    // Inner highlight: 1px band inside body edge (d in [-1.0, 0.0]), tracks corner curvature and fades with window
    if (uOutline.a > 0.0) {
        float m = clamp(1.0 + d, 0.0, 1.0) * inSquare * uOutline.a * cogl_color_in.a;
        cogl_color_out.rgb = uOutline.rgb * m + cogl_color_out.rgb * (1.0 - m);
        cogl_color_out.a = m + cogl_color_out.a * (1.0 - m);
    }

    // Rounded clipping (1px anti-aliasing): removes the body's corner regions and
    // leaves the margin ring alone.
    cogl_color_out *= 1.0 - clamp(d + 0.5, 0.0, 1.0) * inSquare;
`;

/** Registered type name, the stable identity of one of our effects. */
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

        // -1 rather than 0: no real window reaches it, so the first call always uploads.
        this._last = {
            width: -1, height: -1, frameX: -1, frameY: -1,
            frameWidth: -1, frameHeight: -1, radius: -1, outline: undefined,
        };
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT,
            DECLARATIONS, CODE, false);
    }

    /**
     * Update clipping parameters (actor size, the window body inside it, radius and
     * outline; the outline is disabled by null).
     *
     * Uploading a uniform is not free: it dirties Cogl's pipeline state, and the
     * repaint schedules a compositor frame. A reconciliation runs on every window
     * event, so most calls carry the parameters already in the pipeline.
     *
     * @param {object} params
     * @param {number} params.width - Actor width
     * @param {number} params.height - Actor height
     * @param {{x: number, y: number, width: number, height: number}} params.frame - Body, in actor coordinates
     * @param {number} params.radius - Corner radius
     * @param {object|null} params.outline - `{color: number[], alpha: number}`, or null
     */
    setParams({width, height, frame, radius, outline}) {
        const last = this._last;
        if (last.width === width && last.height === height &&
            last.frameX === frame.x && last.frameY === frame.y &&
            last.frameWidth === frame.width && last.frameHeight === frame.height &&
            last.radius === radius && last.outline === outline)
            return;

        Object.assign(last, {
            width, height, radius, outline,
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
        this.queue_repaint();
    }
});
