/** Clips the body to a rounded rect with optional outline; geometry is read live each paint. */

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Cogl from 'gi://Cogl';
import {ShaderEffect} from '../platform/shaderEffect.js';

import {ZERO_INSETS} from '../lib/frame.js';
import {clipFrameForTarget, resolveClipPhase} from '../lib/clipTarget.js';
import {ZERO_PHASE} from '../lib/snap.js';
import {findMetaWindowCached, getWindowActor} from '../platform/window.js';
import {clipGeometryChanges, clipParamChanges, isPaintableFrame, resolveClipSize, resolvePaintBody} from './clipParams.js';
import {readActorSize, readWindowSize} from './bodyPlan.js';
import {clipParamsFrom} from './decorationPass.js';
import {PendingSource} from './pendingSource.js';
import {Diagnostic, offscreenBoxWarning} from '../lib/diagnosticInvariants.js';
import {journal} from '../platform/journal.js';
import {offscreenPaintBox, offscreenUniformsStale} from '../lib/offscreenBox.js';

const DECLARATIONS = `
uniform vec2 uQuadSize;   // Offscreen FBO extent in logical px: what cogl_tex_coord0_in spans
uniform vec2 uFboOffset;  // Actor origin inside that extent, in logical px
uniform vec4 uFrame;      // Body rect in actor coords: x, y, w, h (px)
uniform float uRadius;    // Corner radius in px
uniform vec4 uOutline;    // Inner outline r,g,b in [0,1], a in [0,1]; a=0 disables
uniform float uErase;       // 1 erases outer bounding rect and ring, 0 keeps ring
uniform float uClearStroke; // 1 pushes sampling coords inward to erase client CSD stroke, 0 samples 1:1
uniform float uScale;       // Screen px per shader unit, not FBO px
// The FBO's oversampling is averaged on the blit into the monitor-sized allocation, so the outline
// ring, the clear-stroke inset and the AA ramp convert with the monitor scale. The FBO's scale
// instead draws a 1px outline at 1/scale units: 0.5 logical px, 0.625 screen px, where unpatched
// mutter allocates ceilf (1.25) = 2.

float sdRoundedBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
`;

const CODE = `
    vec2 quadSize = uQuadSize;
    vec2 p = cogl_tex_coord0_in.xy * quadSize;

    vec2 frameCenter = uFrame.xy + uFrame.zw * 0.5 + uFboOffset;
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

    /** St is what the decoration resolved the target with, so the fallback needs no global. */
    _init(St = null, options = {}) {
        super._init();

        this._St = St;
        this._insets = ZERO_INSETS;
        // Suspended: the target had no paint-able body; a valid frame or a reconcile clears it.
        this._suspended = false;
        this._disable = null;
        // A Wayland surface container carries the phase in its transform; a fallback does not.
        this._phaseInTransform = true;
        this._radius = undefined;
        this._outline = undefined;
        this._outlineVec = [0, 0, 0, 0];
        this._erase = undefined;
        this._clearStroke = undefined;

        // Cached geometry and reusable arrays: no per-frame allocations, no redundant uploads.
        this._paint = {
            scale: -1,
            width: 0,
            height: 0,
            frame: {x: -1, y: -1, width: -1, height: -1},
        };
        this._scale = 1.0;
        // Scales the FBO may hold, `ceil` variants included; null when incomplete, paint predicts.
        this._scaleCandidates = null;
        // Last fallback phase folded into the frame: kept while the monitor scan fails, not zeroed.
        this._lastPhase = ZERO_PHASE;
        // Pass plan (reference sizes, no body); null until the first pass, then read live at paint.
        this._bodyPlan = null;

        // Two readings of one extent, one line per episode; rebuilt per episode, nothing to reset.
        this._boxDiagnostic = new Diagnostic(options.journal ?? journal, 1);

        this._quadVec = [0, 0];
        this._offsetVec = [0, 0];
        this._frameVec = [0, 0, 0, 0];
        this._scaleVec = [1.0];
        this._radiusVec = [0];
        this._eraseVec = [0];
        this._clearStrokeVec = [0];
    }

    /** Stores the styling decisions only; geometry is re-read from the actor on every paint. */
    setParams({insets, radius, outline, erase = false, clearStroke = false, scale = 1.0, scaleCandidates = null}) {
        const changes = clipParamChanges({
            insets: this._insets,
            radius: this._radius,
            outline: this._outlineVec,
            erase: this._erase,
            clearStroke: this._clearStroke,
            scale: this._scale,
            candidates: this._scaleCandidates,
        }, {insets, radius, outline, erase, clearStroke, scale, candidates: scaleCandidates});
        if (!changes.changed)
            return;

        this._insets = {left: insets.left, top: insets.top, right: insets.right, bottom: insets.bottom};
        this._radius = radius;
        this._outline = outline;
        this._erase = Boolean(erase);
        this._clearStroke = Boolean(clearStroke);
        if (changes.scale !== undefined)
            this._scale = changes.scale;
        if (changes.candidates !== undefined)
            this._scaleCandidates = changes.candidates;

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

        // Insets moved the body: the -1 width sentinel forces the next paint to re-derive uFrame.
        if (changes.frame)
            this._paint.frame.width = -1;

        this.queue_repaint();
    }

    /** Sets the phase strategy; a flip invalidates the cached frame so the next paint redoes it. */
    setPhaseInTransform(phaseInTransform) {
        const next = Boolean(phaseInTransform);
        if (this._phaseInTransform === next)
            return;
        this._phaseInTransform = next;
        this._paint.frame.width = -1;
        this.queue_repaint();
    }

    /** Hands the paint the reference sizes it settles against; the shadow gets the same plan. */
    setBodyPlan(plan) {
        const next = plan ?? null;
        const previous = this._bodyPlan;
        if (previous === next)
            return;
        this._bodyPlan = next;
        // Only a paint nothing else queued could miss the moved edge; the repaint is not redundant.
        this.queue_repaint();
    }

    /** What this effect knows about itself, for the debug reply; the decoration composes it. */
    get diagnosticsView() {
        return {
            phaseInTransform: this._phaseInTransform,
            // A copy: the frame is a live uniform array, and no reader may steer the next paint.
            frame: [...this._frameVec],
            scale: this._scale,
            suspended: this._suspended,
        };
    }

    /** One handoff per decoration pass, in the effect's own order: params then plan, never half. */
    applyPass(pass) {
        this.setParams(clipParamsFrom(pass));
        this.setBodyPlan(pass.bodyPlan);
    }

    vfunc_paint_target(node, paintContext) {
        const actor = this.get_actor();
        const targetSize = {width: actor?.width ?? 0, height: actor?.height ?? 0};
        // Read live at paint: a container can read 0 while its child still paints, so fall back.
        const win = findMetaWindowCached(actor);
        const windowActorSize = readActorSize(getWindowActor(win));
        const size = isPaintableFrame(targetSize)
            ? targetSize
            : resolveClipSize(targetSize, windowActorSize);
        if (!size) {
            this._suspend();
            return;
        }
        this.resume();

        const scale = this._scale ?? 1.0;
        // Phase comes from the resolved target: in-transform on Wayland, into geometry otherwise.
        const phaseWin = this._phaseInTransform ? null : win;
        // Unreadable fallback phase: keep the last good one, as the shadow does, so cuts agree.
        const resolvedPhase = resolveClipPhase({phaseInTransform: this._phaseInTransform}, phaseWin, this._St);
        if (resolvedPhase)
            this._lastPhase = resolvedPhase;
        // Body settles live each paint from the plan, so the cut tracks the actor between passes.
        const bodySize = resolvePaintBody(targetSize, windowActorSize, readWindowSize(win),
            this._bodyPlan).body ?? size;
        const frame = clipFrameForTarget(bodySize, this._insets, scale,
            {phaseInTransform: this._phaseInTransform}, phaseWin, this._lastPhase, this._St);
        // Backstop: a body still degenerate after all that suspends rather than erasing the window.
        if (!isPaintableFrame(frame)) {
            this._suspend();
            return;
        }
        const changes = clipGeometryChanges(this._paint, {scale, width: size.width, height: size.height, frame});

        if (changes.scale !== undefined) {
            this._scaleVec[0] = changes.scale;
            this.set_uniform_float('uScale', 1, this._scaleVec);
            this._paint.scale = changes.scale;
        }

        // Never cached: it makes one unit one logical pixel; a stale box drew the arc off edge.
        const target = this._readTargetSize();
        // Extent is what Clutter allocated (it beats the derivation); the origin is derived on it.
        const box = offscreenPaintBox(size, scale, target, this._scaleCandidates);

        this._checkOffscreenBox(box.predicted, target);
        const extent = box.extent;
        // Compare the last written pair, not the actor size: a reallocated FBO moves the origin.
        if (changes.size !== undefined || changes.scale !== undefined ||
            offscreenUniformsStale(this._quadVec, this._offsetVec, box)) {
            this._quadVec[0] = extent.width;
            this._quadVec[1] = extent.height;
            this.set_uniform_float('uQuadSize', 2, this._quadVec);
            this._offsetVec[0] = box.offsetX;
            this._offsetVec[1] = box.offsetY;
            this.set_uniform_float('uFboOffset', 2, this._offsetVec);
        }

        if (changes.size !== undefined) {
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

    /** The FBO extent Clutter allocated, or null when unreadable; `get_target_size` needs paint. */
    _readTargetSize() {
        const read = this.get_target_size?.();
        if (!read?.[0])
            return null;
        const width = read[1];
        const height = read[2];
        if (!(width > 0) || !(height > 0))
            return null;
        return {width, height};
    }

    _checkOffscreenBox(derived, target) {
        this._boxDiagnostic.check(offscreenBoxWarning(derived, target));
    }

    /** Clears a suspend the reconcile overrode; a still-degenerate target suspends again later. */
    resume() {
        this._disable?.cancel();
        this._suspended = false;
    }

    /** Disables the effect so the actor paints directly, not via an offscreen target drawing 0. */
    _suspend() {
        // Only the transition schedules a disable: a degenerate target must not queue per paint.
        if (this._suspended)
            return;
        this._suspended = true;
        // Disabling during the actor's own paint trips a Clutter check, so it lands on an idle.
        this._disable ??= new PendingSource(
            callback => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, callback),
            id => GLib.Source.remove(id));
        this._disable.queue(() => {
            // A valid frame may have landed since this idle queued: disable only while suspended.
            if (this._suspended)
                this.set_enabled(false);
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Drops a queued disable; teardown calls this so the idle cannot reach a destroyed effect. */
    cancelPendingDisable() {
        this._disable?.cancel();
    }
});
