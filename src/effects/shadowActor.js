/**
 * ShadowActor: 8-slice baked shadow below window actor; cross-fades on style change.
 * See docs/architecture.md (ShadowActor, Shadow baking) for geometry and animation.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {ADWAITA_STYLE} from '../lib/adwaitaStyle.generated.js';
import {bodyFrame, ZERO_INSETS} from '../lib/frame.js';
import {pipelineOpacityFor} from '../lib/style.js';
import {
    setPipelineOpacity,
    shadowGeometry,
    shadowPipelineFor,
    shadowSlices,
    styleKey,
    SHADOW_PAD,
} from './shadowTexture.js';

// libadwaita `$backdrop_transition` (200ms ease-out), generated into ADWAITA_STYLE.transition.
const FADE_MS = ADWAITA_STYLE.transition.durationMs;
const EASE_OUT = ADWAITA_STYLE.transition.easing;
const FADE_STEP_MS = 16; // ~60 fps

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
        this._elapsed = FADE_MS;
        this._fadeId = 0;

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
    setShadowStyle({radius, shadows}) {
        const key = styleKey(radius, shadows);
        if (this._style && this._style.key === key)
            return;

        if (!this._style) {
            this._style = {key, radius, shadows, pipeline: null};
            this._progress = 1;
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
        this._style = {key, radius, shadows, pipeline: null};
        this._progress = 0;

        if (this._outgoing)
            this._startFade();
        else
            this._finishFade();
    }

    vfunc_paint_node(node, paintContext) {
        if (!this._style)
            return;

        if (this._outgoing && this._progress >= 1)
            this._finishFade();

        // Scale by paint opacity; see docs/architecture.md § ShadowActor.
        const paintOpacity = this.get_paint_opacity() / 255;
        if (paintOpacity <= 0)
            return;

        const context = paintContext.get_framebuffer().get_context();
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

    _addRects(node, pipeline, style) {
        this._relayout(style);

        const pipelineNode = new Clutter.PipelineNode(pipeline);
        node.add_child(pipelineNode);
        for (let i = 0; i < style.slices.length; i++) {
            const slice = style.slices[i];
            const box = style.boxes[i];
            box.set_origin(style.cast.x + slice.x1, style.cast.y + slice.y1);
            box.set_size(slice.x2 - slice.x1, slice.y2 - slice.y1);
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
    // body follows from the stored insets, so the cast rect tracks a resize every frame
    // instead of waiting for the manager's 50ms reconcile. No insets = the body is the
    // whole actor, which is what a bare toplevel is. Same fallback as the clip: insets that
    // outrun the actor leave no body, and the whole actor is the cast then.
    _castRect() {
        return bodyFrame({width: this.width, height: this.height}, this._insets ?? ZERO_INSETS);
    }

    // Cache slices/boxes per cast rect; sources are style-fixed.
    _relayout(style) {
        const cast = this._castRect();
        const previous = style.cast;
        if (style.slices && previous && previous.x === cast.x && previous.y === cast.y &&
            previous.width === cast.width && previous.height === cast.height)
            return;
        style.slices = shadowSlices(shadowGeometry(style.radius), cast.width, cast.height);
        if (!style.boxes || style.boxes.length !== style.slices.length)
            style.boxes = style.slices.map(() => new Clutter.ActorBox());
        style.cast = cast;
    }

    _startFade() {
        if (this._fadeId)
            return;
        this._elapsed = 0;
        this._fadeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FADE_STEP_MS, () => {
            this._elapsed += FADE_STEP_MS;
            this._progress = bezier(Math.min(1, this._elapsed / FADE_MS), EASE_OUT);
            if (this._elapsed >= FADE_MS)
                this._finishFade();
            else
                this.queue_redraw();
            return this._fadeId ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        });
        this.queue_redraw();
    }

    _finishFade() {
        if (this._fadeId) {
            GLib.Source.remove(this._fadeId);
            this._fadeId = 0;
        }
        this._outgoing = null;
        this._progress = 1;
        this.queue_redraw();
    }

    destroy() {
        if (this._fadeId) {
            GLib.Source.remove(this._fadeId);
            this._fadeId = 0;
        }
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
