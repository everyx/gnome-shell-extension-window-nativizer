/**
 * ShadowActor: 8-slice baked shadow below window actor; cross-fades on style change.
 * See docs/architecture.md (ShadowActor, Shadow baking) for geometry and animation.
 */

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {ADWAITA_STYLE} from '../lib/adwaitaStyle.generated.js';
import {bodyFrame, ZERO_INSETS} from '../lib/frame.js';
import {pipelineOpacityFor} from '../lib/style.js';
import {shadowGeometry, shadowSlices, SHADOW_PAD} from './shadowGeometry.js';
import {setPipelineOpacity, shadowPipelineFor, styleKey} from './shadowTexture.js';
import {getPhysicalMonitorScale, snapSliceBoxesInto} from '../lib/snap.js';

// libadwaita `$backdrop_transition` (200ms ease-out), generated into ADWAITA_STYLE.transition.
// The blend advances from the paint pass rather than from a timer: progress is computed from the
// wall clock when a frame is actually drawn, so steps land on displayed frames at any refresh
// rate, the duration is real time instead of a count of 16ms callbacks, and a blend still running
// asks for the next frame by queueing a redraw. The curve stays the generated cubic-bezier -
// Clutter's own EASE_OUT_* modes are different curves, and this one is upstream's.
//
// A ClutterTimeline would be the other way to do this and does not work here: a standalone
// timeline is not driven by the stage's clock in this shell, and measured zero frames in 600ms.
const FADE_MS = ADWAITA_STYLE.transition.durationMs;
const EASE_OUT = ADWAITA_STYLE.transition.easing;

/**
 * @param {number} t - 0..1
 * @param {number[]} curve - x1,y1,x2,y2
 * @returns {number}
 */
function bezier(t, [x1, y1, x2, y2]) {
    const at = (u, p1, p2) => 3 * (1 - u) ** 2 * u * p1 + 3 * (1 - u) * u ** 2 * p2 + u ** 3;
    let u = t;
    for (let i = 0; i < 4; i++) {
        const slope = 3 * (1 - u) ** 2 * x1 + 6 * (1 - u) * u * (x2 - x1) + 3 * u ** 2 * (1 - x2);
        if (slope === 0)
            break;
        u -= (at(u, x1, x2) - t) / slope;
    }
    return at(Math.max(0, Math.min(1, u)), y1, y2);
}

const SYNCED_PROPERTIES = [
    'opacity', 'visible', 'pivot-point', 'scale-x', 'scale-y', 'translation-x', 'translation-y',
];

export const SHADOW_ACTOR_G_TYPE = 'WindowNativizerShadowActor';

export const ShadowActor = GObject.registerClass({
    GTypeName: SHADOW_ACTOR_G_TYPE,
}, class ShadowActor extends Clutter.Actor {
    /**
     * @param {Clutter.Actor} windowActor
     * @param {Clutter.Actor} container - windowGroup; shadow inserted below windowActor
     */
    _init(windowActor, container) {
        super._init({name: 'WindowNativizerShadowActor', reactive: false, opacity: 255});

        this._windowActor = windowActor;
        this._container = container;
        this._style = null;
        this._insets = null;
        this._outgoing = null;
        this._progress = 1;
        this._fadeStart = 0;
        this._borderPipelines = new Map();

        for (const [coordinate, offset] of [
            [Clutter.BindCoordinate.X, -SHADOW_PAD],
            [Clutter.BindCoordinate.Y, -SHADOW_PAD],
            [Clutter.BindCoordinate.WIDTH, SHADOW_PAD * 2],
            [Clutter.BindCoordinate.HEIGHT, SHADOW_PAD * 2],
        ])
            this.add_constraint(new Clutter.BindConstraint({source: windowActor, coordinate, offset}));

        this._bindings = SYNCED_PROPERTIES.map(property => windowActor.bind_property(
            property, this, property, GObject.BindingFlags.SYNC_CREATE));

        this._destroyId = windowActor.connect('destroy', () => this.destroy());

        container.insert_child_below(this, windowActor);
    }

    /**
     * The ring the client declared, per side. Stored, not the body: the body is recomputed
     * from this actor's live size on every paint, so a resize cannot leave a stale cast.
     * @param {import('../lib/frame.js').Insets|null} insets - null = whole actor
     */
    setShadowInsets(insets) {
        const next = insets
            ? {left: insets.left, top: insets.top, right: insets.right, bottom: insets.bottom}
            : null;
        const current = this._insets;
        if (current === next || (current && next &&
            current.left === next.left && current.top === next.top &&
            current.right === next.right && current.bottom === next.bottom))
            return;

        this._insets = next;
        this.queue_redraw();
    }

    /**
     * @param {{radius:number,shadows:Array<object>}} style - resolved for current window state
     */
    setShadowStyle(style) {
        const {radius, shadows, animate = false} = style;
        const key = styleKey(radius, shadows, style.border ?? null);
        if (this._style && this._style.key === key)
            return;

        // Spread the given style rather than rebuilding it: rebuilding dropped `animate` once and
        // `border` once, and each time the field was correct everywhere the unit tests looked.
        if (!this._style) {
            this._style = {...style, key, pipeline: null};
            this._progress = 1;
            this.queue_redraw();
            return;
        }

        // Upstream declares the transition on the backdrop state alone, so entering backdrop
        // fades and every other change - gaining focus, maximizing, tiling - snaps. The flag is
        // generated from the SCSS, so this file does not decide which states animate. It defaults
        // to false: most states snap, and a caller that forgets the flag should land on the side
        // that is merely abrupt rather than the one that fades when upstream does not.
        if (!animate) {
            this._finishFade();
            this._style = {...style, key, pipeline: null};
            this.queue_redraw();
            return;
        }

        const keepStyle = this._progress >= 0.5;
        const kept = keepStyle ? this._style : this._outgoing?.style;
        let keptWeight = 0;
        if (keepStyle)
            keptWeight = this._progress;
        else if (this._outgoing)
            keptWeight = (1 - this._progress) * this._outgoing.weight;

        this._outgoing = kept ? {style: kept, weight: keptWeight} : null;
        this._style = {...style, key, pipeline: null};
        this._progress = 0;

        if (this._outgoing)
            this._startFade();
        else
            this._finishFade();
    }

    vfunc_paint_node(node, paintContext) {
        if (this.width <= 0 || this.height <= 0 || !this._style)
            return;

        // Bring the blend up to the frame being drawn, then keep frames coming while it runs.
        if (this._advanceFade())
            this.queue_redraw();

        // Scale by paint opacity; see docs/architecture.md § ShadowActor.
        const paintOpacity = this.get_paint_opacity() / 255;
        if (paintOpacity <= 0)
            return;

        const context = paintContext.get_framebuffer().get_context();

        // A tiled window has no shadow, only the 1px ring upstream draws with a zero-blur box-shadow.
        // GTK fills such a ring rather than texturing it, and it cannot be recoloured inside a baked
        // shadow layer, so it is drawn here as four solid rectangles outside the body.
        if (this._style.border) {
            this._addBorder(node, context, paintOpacity);
            return;
        }

        const pipeline = this._pipelineFor(context, this._style);
        if (!pipeline)
            return;

        if (this._outgoing && this._progress < 1) {
            const {style, weight} = this._outgoing;
            const outgoing = this._pipelineFor(context, style);
            if (outgoing) {
                setPipelineOpacity(outgoing, pipelineOpacityFor((1 - this._progress) * weight, paintOpacity));
                this._addRects(node, outgoing, style);
            }
        }

        setPipelineOpacity(pipeline, pipelineOpacityFor(this._outgoing ? this._progress : 1, paintOpacity));
        this._addRects(node, pipeline, this._style);
    }

    /**
     * The tiled ring: one rectangle per side, outside the body, in the style's border colour.
     * @param {Clutter.PaintNode} node
     * @param {Cogl.Context} context
     * @param {number} paintOpacity - 0..1
     */
    _addBorder(node, context, paintOpacity) {
        const {width, color, alpha} = this._style.border;
        const key = `${color.join(',')}|${alpha}|${Math.round(paintOpacity * 255)}`;
        let pipeline = this._borderPipelines.get(key);
        if (!pipeline) {
            // Cogl colors are premultiplied, and this pipeline has no texture to modulate, so the
            // color it is given is what the GPU blends. Passing white at alpha 38 un-premultiplied
            // made the ring read as `255 + 0.85 * backdrop` - a near-opaque line on a dark theme -
            // where upstream's 15% white is `0.15 * 255 + 0.85 * backdrop`.
            const a = Math.round(alpha * paintOpacity * 255);
            pipeline = Cogl.Pipeline.new(context);
            pipeline.set_color(new Cogl.Color({
                red: Math.round(color[0] * a / 255),
                green: Math.round(color[1] * a / 255),
                blue: Math.round(color[2] * a / 255),
                alpha: a,
            }));
            this._borderPipelines.set(key, pipeline);
        }

        // `_castRect()` is in the shadow texture's coordinates, where the visible window sits at
        // `SHADOW_PAD` inside it - the slices are placed by that offset in `_relayout`, which is why
        // the shadow hugs the window. The ring has to shift by the same amount, or it lands a
        // SHADOW_PAD outside the window with nothing in between.
        const cast = this._castRect();
        const body = {
            x: cast.x + SHADOW_PAD,
            y: cast.y + SHADOW_PAD,
            width: cast.width - 2 * SHADOW_PAD,
            height: cast.height - 2 * SHADOW_PAD,
        };
        const pipelineNode = new Clutter.PipelineNode(pipeline);
        node.add_child(pipelineNode);

        for (const [x, y, w, h] of [
            [body.x - width, body.y - width, body.width + 2 * width, width],
            [body.x - width, body.y + body.height, body.width + 2 * width, width],
            [body.x - width, body.y, width, body.height],
            [body.x + body.width, body.y, width, body.height],
        ]) {
            const box = new Clutter.ActorBox();
            box.x1 = x;
            box.y1 = y;
            box.x2 = x + w;
            box.y2 = y + h;
            pipelineNode.add_rectangle(box);
        }
    }

    _addRects(node, pipeline, style) {
        const scale = getPhysicalMonitorScale(this._windowActor, 1.0);
        const boxes = this._relayout(style, scale);

        const pipelineNode = new Clutter.PipelineNode(pipeline);
        node.add_child(pipelineNode);

        for (let i = 0; i < style.slices.length; i++) {
            const slice = style.slices[i];
            const box = boxes[i];
            pipelineNode.add_texture_rectangle(box, slice.s1, slice.t1, slice.s2, slice.t2);
        }
    }

    _pipelineFor(context, style) {
        if (!style.pipeline)
            style.pipeline = shadowPipelineFor(context, style.radius, style.shadows);
        return style.pipeline;
    }

    // Padded body: actor sits at -PAD, so cast starts at body.xy and grows by PAD each side.
    // `this.width/height` is this actor's live size (the window actor plus `2*PAD`) and the
    // body follows from the stored insets, so the cast tracks a resize every frame
    // instead of waiting for the manager's 50ms reconcile. No insets = the body is the
    // whole actor, which is what a bare toplevel is. Same fallback as the clip: insets that
    // outrun the actor leave no body, and the whole actor is the cast then.
    _castRect() {
        return bodyFrame({width: this.width, height: this.height}, this._insets ?? ZERO_INSETS);
    }

    // Cache slices per cast rect, and pre-allocated boxes per physical scale.
    _relayout(style, scale) {
        const cast = this._castRect();
        const previous = style.cast;
        const castChanged = !previous ||
            previous.x !== cast.x || previous.y !== cast.y ||
            previous.width !== cast.width || previous.height !== cast.height;

        if (castChanged || !style.slices) {
            style.slices = shadowSlices(shadowGeometry(style.radius), cast.width, cast.height);
            // Freeze to enforce the immutability contract so token-aliasing in entry.cast cannot be defeated
            style.cast = Object.freeze(cast);
        }

        if (!style.boxesByScale)
            style.boxesByScale = new Map();

        let entry = style.boxesByScale.get(scale);
        if (!entry || entry.boxes.length !== style.slices.length) {
            entry = {
                boxes: style.slices.map(() => new Clutter.ActorBox()),
                cast: null,
            };
            style.boxesByScale.set(scale, entry);
        }

        if (entry.cast !== style.cast) {
            const corner = SHADOW_PAD + style.radius;
            // Actor-Local snapping: cutlines remain invariant in local space during window drag,
            // while mutating pre-allocated boxes in-place on resize achieves zero GC allocation.
            snapSliceBoxesInto(entry.boxes, style.cast, corner, scale);
            entry.cast = style.cast;
        }

        return entry.boxes;
    }

    /**
     * Advances the blend to the frame being drawn, and reports whether it is still running - that
     * answer is what asks for the next frame, since a redraw queued from inside a paint schedules
     * one. Progress comes from the wall clock, so a frame the compositor skipped costs nothing and
     * a late frame does not stretch the blend.
     * @returns {boolean}
     */
    _advanceFade() {
        if (this._fadeStart === 0)
            return false;
        const elapsedMs = (GLib.get_monotonic_time() - this._fadeStart) / 1000;
        this._progress = bezier(Math.min(1, elapsedMs / FADE_MS), EASE_OUT);
        if (elapsedMs >= FADE_MS) {
            this._finishFade();
            return false;
        }
        return true;
    }

    _startFade() {
        // Starting from 0 on every entry, including a re-entry mid-blend, is what keeps a style
        // change ramping from the start instead of resuming the previous blend's position.
        this._fadeStart = GLib.get_monotonic_time();
        this._progress = 0;
        this.queue_redraw();
    }

    _finishFade() {
        this._fadeStart = 0;
        this._outgoing = null;
        this._progress = 1;
        this.queue_redraw();
    }

    destroy() {
        this._fadeStart = 0;
        this._borderPipelines.clear();
        for (const binding of this._bindings)
            binding.unbind();
        this._bindings = [];
        try {
            this._windowActor.disconnect(this._destroyId);
        } catch {
            // Already destroyed.
        }
        this._style = null;
        this._outgoing = null;
        try {
            this._container?.remove_child(this);
        } catch {
            // Container already gone.
        }
        this._container = null;
        super.destroy();
    }
});
