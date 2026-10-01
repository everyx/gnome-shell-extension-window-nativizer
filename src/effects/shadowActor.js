/**
 * ShadowActor: 8-slice baked shadow below window actor; cross-fades on style change.
 * See docs/architecture.md (ShadowActor, Shadow baking) for geometry and animation.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {bodyFrame, ZERO_INSETS} from '../lib/frame.js';
import {pipelineOpacityFor} from '../lib/style.js';
import {shadowGeometry, shadowSlices, SHADOW_PAD} from './shadowGeometry.js';
import {setPipelineOpacity, shadowPipelineFor, styleKey} from './shadowTexture.js';
import {snapSliceBoxesInto} from '../lib/snap.js';
import {ShadowFadeStateMachine} from './shadowFade.js';

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
        this._insets = null;
        this._scale = 1.0;
        this._fade = new ShadowFadeStateMachine({
            now: () => GLib.get_monotonic_time() / 1000,
        });

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

    /** @returns {boolean} Whether a cross-fade animation is currently active */
    get isFading() {
        return this._fade.isFading;
    }

    /** @returns {boolean} Whether the shadow is completely settled */
    get isSettled() {
        return this._fade.isSettled;
    }

    /** @returns {number} Current incoming fade progress [0..1] */
    get progress() {
        return this._fade.progress;
    }

    /** @returns {{style: object, weight: number}|null} */
    get outgoing() {
        return this._fade.outgoing;
    }

    /** @returns {object|null} Current target shadow style */
    get style() {
        return this._fade.style;
    }

    /**
     * Sets display scale externally, eliminating Shell queries from paint passes.
     * @param {number} scale
     */
    setScale(scale) {
        if (typeof scale === 'number' && scale > 0 && Number.isFinite(scale) && this._scale !== scale) {
            this._scale = scale;
            this.queue_relayout();
        }
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
     * @param {{radius:number,shadows:Array<object>,animate?:boolean,border?:boolean}} style - resolved for current window state
     */
    setShadowStyle(style) {
        const {radius, shadows, animate = false} = style;
        const key = styleKey(radius, shadows);
        if (this._fade.style && this._fade.style.key === key)
            return;

        const nextStyle = {...style, key, pipeline: null};
        this._fade.setStyle(nextStyle, {animate});
        this.queue_redraw();
    }

    vfunc_paint_node(node, paintContext) {
        const currentStyle = this._fade.style;
        if (this.width <= 0 || this.height <= 0 || !currentStyle)
            return;

        // Bring the blend up to the frame being drawn, then keep frames coming while it runs.
        if (this._fade.advance())
            this.queue_redraw();

        // Scale by paint opacity; see docs/architecture.md § ShadowActor.
        const paintOpacity = this.get_paint_opacity() / 255;
        if (paintOpacity <= 0)
            return;

        const context = paintContext.get_framebuffer().get_context();

        const pipeline = this._pipelineFor(context, currentStyle);
        if (!pipeline)
            return;

        const outgoing = this._fade.outgoing;
        if (outgoing && this._fade.progress < 1) {
            const outgoingPipeline = this._pipelineFor(context, outgoing.style);
            if (outgoingPipeline) {
                setPipelineOpacity(outgoingPipeline, pipelineOpacityFor(this._fade.outgoingWeight, paintOpacity));
                this._addRects(node, outgoingPipeline, outgoing.style);
            }
        }

        setPipelineOpacity(pipeline, pipelineOpacityFor(this._fade.incomingWeight, paintOpacity));
        this._addRects(node, pipeline, currentStyle);
    }

    _addRects(node, pipeline, style) {
        const scale = this._scale ?? 1.0;
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

    destroy() {
        this._fade.reset();
        for (const binding of this._bindings)
            binding.unbind();
        this._bindings = [];
        try {
            this._windowActor.disconnect(this._destroyId);
        } catch {
            // Already destroyed.
        }
        try {
            this._container?.remove_child(this);
        } catch {
            // Container already gone.
        }
        this._container = null;
        super.destroy();
    }
});
