/**
 * RoundedClipEffect: clips the window body to a rounded rect with optional 1px inner outline.
 * Dynamic geometry is computed live on each paint frame to prevent resize lag;
 * styling decisions (radius, insets, outline) are updated via setParams().
 */

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Cogl from 'gi://Cogl';
import {ShaderEffect} from '../platform/shaderEffect.js';

import {ZERO_INSETS} from '../lib/frame.js';
import {clipFrameForTarget, resolveClipPhase} from '../lib/clipTarget.js';
import {ZERO_PHASE} from '../lib/snap.js';
import {findMetaWindowCached, getWindowActor, getWindowBufferRect, getWindowFrameRect} from '../platform/window.js';
import {clipGeometryChanges, clipParamChanges, isPaintableFrame, resolveClipSize, resolvePaintBody} from './clipParams.js';
import {evaluateInvariant, freshInvariantState, offscreenBoxWarning} from '../lib/diagnosticInvariants.js';
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

/**
 * A live actor's extent, or null when the actor is gone or its read throws. The window actor is an
 * actor we do not own, so a torn-down read is "unknown" and the settle falls back rather than
 * aborting the paint.
 */
function readActorExtent(actor) {
    if (!actor)
        return null;
    try {
        return {width: actor.width, height: actor.height};
    } catch {
        return null;
    }
}

/**
 * The window's own size, read live at paint: its frame rect, else its buffer rect. This is the
 * read that separates a resize from a body that moved on its own, so it is taken on the frame
 * clock; only its previous value lives in the pass plan.
 */
function readWindowSize(win) {
    const frame = getWindowFrameRect(win);
    if (isPaintableFrame(frame))
        return {width: frame.width, height: frame.height};
    const buffer = getWindowBufferRect(win);
    if (isPaintableFrame(buffer))
        return {width: buffer.width, height: buffer.height};
    return null;
}

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

    /**
     * @param [St] - The St namespace the decoration resolved the clip target with,
     *        handed to the fallback phase read so it identifies the surface container by the
     *        clip's own rule rather than a global
     */
    _init(St = null) {
        super._init();

        this._St = St;
        // Decisions only; geometry lives in vfunc_paint_target.
        this._insets = ZERO_INSETS;
        // True while the clip has suspended itself because its target has no paint-able body. The
        // next reconcile re-enables the effect (WindowDecoration.setOverviewMode); a valid frame
        // clears this again.
        this._suspended = false;
        // The target's phase strategy: the Wayland surface container carries the phase in its
        // own transform (the default), every fallback target does not. setPhaseInTransform()
        // flips it for the fallback; see resolveClipTarget in lib/clipTarget.js.
        this._phaseInTransform = true;
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
        // The reconcile pass's candidate scales for this window's FBO, with their `ceil` variants,
        // or null when that set is incomplete. Paint only predicts and compares with it.
        this._scaleCandidates = null;
        // The last phase a fallback pass folded into the frame. While the monitor scan cannot
        // complete, the clip keeps this rather than jumping to zero; the shadow keeps the same
        // phase as its translation, so the two cuts stay on one line. ZERO_PHASE is only the
        // start - there is no earlier correct display to preserve on the first paint.
        this._lastPhase = ZERO_PHASE;
        // The pass plan the next paint settles from: the reference points the hold compares against
        // and the window's own size as of the previous pass. It carries no resolved body; the paint
        // reads the live actors and evaluates the settle on the frame clock. Null until the first pass.
        this._bodyPlan = null;

        // The offscreen-box reconciliation latch: the derived box and the FBO Clutter allocated are
        // two readings of one extent, and a part between them speaks once per episode.
        this._boxLatch = freshInvariantState();

        this._quadVec = [0, 0];
        this._offsetVec = [0, 0];
        this._frameVec = [0, 0, 0, 0];
        this._scaleVec = [1.0];
        this._radiusVec = [0];
        this._eraseVec = [0];
        this._clearStrokeVec = [0];
    }

    /**
     * Store the decisions. Geometry is not here: it is read from the actor every paint.
     * @param params.insets - Ring between actor and body
     * @param params.radius - Corner radius in px
     * @param [params.scale=1.0] - Monitor fractional/integer scale
     * @param [params.scaleCandidates=null] - Scales the FBO may have been allocated at,
     *        computed once per reconcile pass; null abstains
     */
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

        // Insets changed: invalidate cached frame geometry so vfunc_paint_target
        // is forced to recalculate and re-upload uFrame on the next paint pass.
        if (changes.frame)
            this._paint.frame.width = -1;

        this.queue_repaint();
    }

    /**
     * Selects the phase strategy for the resolved clip target. Invalidates the cached frame when
     * it flips, so the next paint recomputes uFrame from the new phase.
     * @param phaseInTransform - True when the target's own transform carries the phase
     */
    setPhaseInTransform(phaseInTransform) {
        const next = Boolean(phaseInTransform);
        if (this._phaseInTransform === next)
            return;
        this._phaseInTransform = next;
        this._paint.frame.width = -1;
        this.queue_repaint();
    }

    /**
     * Sets the pass plan the next paint settles its body from. WindowDecoration decides no body: it
     * hands the reference points the hold compares against, and the paint reads the actors and the
     * window's own size live so the frame tracks what the compositor draws. The shadow gets the same
     * plan, so both cuts derive one body.
     */
    setBodyPlan(plan) {
        const next = plan ?? null;
        const previous = this._bodyPlan;
        if (previous === next)
            return;
        this._bodyPlan = next;
        // The next paint recomputes the frame from the live reads and clipGeometryChanges sees the
        // moved edge; only a paint that nothing else queued could miss it.
        this.queue_repaint();
    }

    /**
     * Executes the offscreen clip shader using actor's live dimensions and snapped frame.
     */
    vfunc_paint_target(node, paintContext) {
        const actor = this.get_actor();
        const targetSize = {width: actor?.width ?? 0, height: actor?.height ?? 0};
        // Both body reads are taken live at paint. The window actor is the authority for whether the
        // window has a body: a surface container's allocation can read 0 while its child still
        // paints, so a non-positive target read falls back to the window actor rather than
        // suspending. The pair also feeds the settle below.
        const win = findMetaWindowCached(actor);
        const windowActorSize = readActorExtent(getWindowActor(win));
        const size = isPaintableFrame(targetSize)
            ? targetSize
            : resolveClipSize(targetSize, windowActorSize);
        if (!size) {
            this._suspend();
            return;
        }
        this._suspended = false;

        const scale = this._scale ?? 1.0;
        // The phase comes from the resolved target. A Wayland surface container carries it in its own
        // transform, so the phase stays out of the FBO's box rounding. On the fallback it lives in a
        // child transform, so the clip folds the window's subpixel offset into its geometry, matching
        // the shadow's translation. Both derive from `clipFrameFor`.
        const phaseWin = this._phaseInTransform ? null : win;
        // An unknown fallback phase (unreadable monitor geometry) keeps the last good frame; the
        // shadow takes the same last good phase, so the two cuts keep agreeing.
        const resolvedPhase = resolveClipPhase({phaseInTransform: this._phaseInTransform}, phaseWin, this._St);
        if (resolvedPhase)
            this._lastPhase = resolvedPhase;
        // The frame edge is the body this paint settles from the live reads and the pass plan. A
        // null plan (before the first pass) uses the live size, a no-op in health. This is the frame
        // clock: between the manager's debounced passes the cut follows the actor the compositor
        // is drawing now.
        const bodySize = resolvePaintBody(targetSize, windowActorSize, readWindowSize(win),
            this._bodyPlan).body ?? size;
        const frame = clipFrameForTarget(bodySize, this._insets, scale,
            {phaseInTransform: this._phaseInTransform}, phaseWin, this._lastPhase, this._St);
        // Backstop: if the derived body is not paint-able even for a positive actor (a future
        // geometry change, not today's fallback-to-whole-actor), suspend rather than erase.
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

        // Derived from the actor size at the live scale, so it moves with either, and never
        // cached: it is what makes one shader unit one logical pixel, and a stale box is what
        // drew the corner arc off the snapped edge.
        const target = this._readTargetSize();
        // The extent and the origin are one position inside the FBO and share its scale: the extent
        // is the size Clutter allocated (it wins over the derivation), the origin is derived on
        // that grid. The scale is the candidate the reconcile pass's read picked, since unpatched
        // mutter allocates by `ceilf (resource_scale)`.
        const box = offscreenPaintBox(size, scale, target, this._scaleCandidates);

        this._checkOffscreenBox(box.predicted, target);
        const extent = box.extent;
        // The last written pair, not the actor size alone: an FBO reallocated at another scale
        // moves the origin while the read extent stays put, and only the pair sees that.
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

    /**
     * The size of the offscreen FBO Clutter allocated, in device px, or null when the read is
     * unavailable or not positive. `get_target_size` is defined for `ClutterOffscreenEffect`
     * implementations inside `paint_target`, which is where the clip asks it; `Shell.GLSLEffect`
     * is one of those on GNOME 50.
     */
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

    /**
     * One paint's offscreen-box reconciliation: the derived box and the FBO Clutter allocated are
     * two readings of one extent, and the predicate allows the one device pixel a subpixel phase
     * may move an edge. One violation speaks, because the box is a pure function of this paint's
     * own size and scale.
     */
    _checkOffscreenBox(derived, target) {
        const {state, message} = evaluateInvariant(this._boxLatch,
            offscreenBoxWarning(derived, target), 1);
        this._boxLatch = state;
        if (message)
            console.warn(message);
    }

    /**
     * Clears a suspend the reconcile has just overridden. `WindowDecoration.setOverviewMode`
     * re-enables the clip on every desktop reconcile, possibly before the deferred disable a
     * degenerate paint queued has run; clearing the flag here keeps that idle from disabling a
     * target the reconcile judged paint-able. It is state, not a latch: a target still degenerate
     * on its next paint suspends again.
     */
    resume() {
        this._suspended = false;
    }

    /**
     * Suspends the clip after its target turned degenerate. Disabling the effect is what makes the
     * actor paint directly instead of through an offscreen target that would draw nothing; the
     * manager's next reconcile re-enables it (`WindowDecoration.setOverviewMode`).
     */
    _suspend() {
        // Only the transition schedules a disable. A healthy window never reaches here, and a
        // still-degenerate target must not queue a disable per paint. The flag is state, not a
        // latch: `resume()` and a valid paint both clear it, so a later paint can suspend again.
        if (this._suspended)
            return;
        this._suspended = true;
        // Disabling a Clutter.ActorMeta during its actor's own paint trips Clutter's
        // `!CLUTTER_ACTOR_IN_PAINT` check, so the suspend lands on the idle that follows it.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            // A valid frame can have landed between the paint that queued this and the idle; only
            // disable while the target is still degenerate.
            if (this._suspended)
                this.set_enabled(false);
            return GLib.SOURCE_REMOVE;
        });
    }
});
