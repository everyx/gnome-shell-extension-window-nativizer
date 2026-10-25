// Baked 8-slice shadow below a window actor; cross-fades between styles on a style change.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {ZERO_INSETS} from '../lib/frame.js';
import {pipelineOpacityFor} from '../lib/style.js';
import {clipTargetReadChanged, settleUndecidedState, shadowBodyWarning, shadowLayout, shadowLayoutPosition, shadowPhaseOffset, shadowTranslation, SHADOW_PAD} from './shadowGeometry.js';
import {readBodySizes, readActorSize} from './bodyPlan.js';
import {Diagnostic} from '../lib/diagnosticInvariants.js';
import {journal} from '../platform/journal.js';
import {Subscriptions} from '../lib/subscriptions.js';
import {shadowStyleFrom} from './decorationPass.js';
import {setPipelineOpacity, shadowPipelineFor, styleKey} from './shadowTexture.js';
import {snapSliceBoxesInto} from '../lib/snap.js';
import {coglContextForBake} from '../platform/coglContext.js';
import {findMetaWindowCached} from '../platform/windowActor.js';
import {ShadowFadeStateMachine} from './shadowFade.js';

const SYNCED_PROPERTIES = [
    'opacity', 'visible', 'pivot-point', 'scale-x', 'scale-y',
];

export const SHADOW_ACTOR_G_TYPE = 'WindowNativizerShadowActor';

export const ShadowActor = GObject.registerClass({
    GTypeName: SHADOW_ACTOR_G_TYPE,
}, class ShadowActor extends Clutter.Actor {
    /** St decides the clip's phase read; options.journal is where the body diagnostic writes. */
    _init(windowActor, container, St = null, options = {}) {
        super._init({name: 'WindowNativizerShadowActor', reactive: false, opacity: 255});

        this._windowActor = windowActor;
        this._container = container;
        this._St = St;
        this._subscriptions = new Subscriptions();
        // Clip's resolved target, adopted by setClipTarget(); its read is the body authority.
        this._clipTarget = null;
        // Read at adoption so an in-place container resize repaints: the bound box cannot move.
        this._clipTargetSize = null;
        // Reference points the next settle compares against; null until a pass derives them live.
        this._bodyPlan = null;
        // One journal line per episode; the actor is rebuilt per decoration, so nothing to reset.
        this._bodyDiagnostic = new Diagnostic(options.journal ?? journal, 1);
        this._insets = null;
        this._scale = 1.0;
        // Mirror of the clip target's phase strategy; false is the safe default until reported.
        this._phaseInTransform = false;
        // Last readable phase; a failed monitor scan keeps it, so both cuts stay on one line.
        this._lastOffset = {x: 0, y: 0};
        this._fade = new ShadowFadeStateMachine({
            now: () => GLib.get_monotonic_time() / 1000,
        });

        // Bind pins window - PAD; x/y on an unallocated actor warns, so translate instead.
        for (const [coordinate, offset] of [
            [Clutter.BindCoordinate.X, -SHADOW_PAD],
            [Clutter.BindCoordinate.Y, -SHADOW_PAD],
            [Clutter.BindCoordinate.WIDTH, SHADOW_PAD * 2],
            [Clutter.BindCoordinate.HEIGHT, SHADOW_PAD * 2],
        ])
            this.add_constraint(new Clutter.BindConstraint({source: windowActor, coordinate, offset}));

        this._bindings = SYNCED_PROPERTIES.map(property => windowActor.bind_property(
            property, this, property, GObject.BindingFlags.SYNC_CREATE));

        // allocation too: Mutter invalidates its cached surface transform on allocation change.
        for (const prop of ['x', 'y', 'translation-x', 'translation-y', 'scale-x', 'scale-y',
            'pivot-point', 'allocation'])
            this._subscriptions.connect(windowActor, `notify::${prop}`, () => this._syncGeometry());
        this._syncGeometry();

        this._subscriptions.connect(windowActor, 'destroy', () => this.destroy());

        container.insert_child_below(this, windowActor);
    }

    /** Folds position and subpixel phase into a translation: a layout offset ignores scale. */
    _syncGeometry() {
        if (!this._windowActor)
            return;
        const offset = shadowPhaseOffset(findMetaWindowCached(this._windowActor), this._phaseInTransform, this._St);
        // Null is an unreadable monitor, not zero: keep the last phase instead of hopping to 0.
        if (offset)
            this._lastOffset = offset;
        const position = shadowLayoutPosition(this._windowActor);
        const baseX = (this._windowActor.x ?? 0) - SHADOW_PAD;
        const baseY = (this._windowActor.y ?? 0) - SHADOW_PAD;
        const {x, y} = shadowTranslation(this._windowActor, this._lastOffset);
        const nextX = x + position.x - baseX;
        const nextY = y + position.y - baseY;
        if (this.translation_x !== nextX)
            this.translation_x = nextX;
        if (this.translation_y !== nextY)
            this.translation_y = nextY;
    }

    /** Re-syncs the translation on a flip, so the change is not deferred to the next move. */
    setPhaseInTransform(phaseInTransform) {
        const next = Boolean(phaseInTransform);
        if (this._phaseInTransform === next)
            return;
        this._phaseInTransform = next;
        this._syncGeometry();
    }

    get isFading() {
        return this._fade.isFading;
    }

    get isSettled() {
        return this._fade.isSettled;
    }

    get progress() {
        return this._fade.progress;
    }

    get outgoing() {
        return this._fade.outgoing;
    }

    get style() {
        return this._fade.style;
    }

    /** A changed read of the same target repaints too: a container resizes while the box cannot. */
    setClipTarget(clipTarget) {
        const next = clipTarget ?? null;
        const nextSize = readActorSize(next);
        if (!clipTargetReadChanged(this._clipTarget, next, this._clipTargetSize, nextSize))
            return;
        this._clipTarget = next;
        this._clipTargetSize = nextSize;
        this.queue_redraw();
    }

    /** Same plan the clip gets, so cast and cut derive one body; it carries no resolved body. */
    setBodyPlan(plan) {
        this._bodyPlan = plan ?? null;
    }

    /** Live reads only, for the debug reply. */
    get diagnosticsView() {
        const style = this._fade?.style ?? null;
        const cast = style?.cast ?? null;
        const entry = style?.boxesByScale?.get?.(this._scale) ?? null;
        const box = entry?.boxes?.[7] ?? null;
        return {
            width: this.width,
            height: this.height,
            cast: cast
                ? {x: cast.x, y: cast.y, width: cast.width, height: cast.height}
                : null,
            rightBand: box
                ? {x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2}
                : null,
        };
    }

    /** Scale set from outside so paint passes issue no Shell query. */
    setScale(scale) {
        if (typeof scale === 'number' && scale > 0 && Number.isFinite(scale) && this._scale !== scale) {
            this._scale = scale;
            this._syncGeometry();
            this.queue_relayout();
        }
    }

    /** Stores the declared ring, not the body: the body re-derives from live size each paint. */
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

    setShadowStyle(style) {
        const {radius, shadows, animate = false} = style;
        const key = styleKey(radius, shadows);
        if (this._fade.style && this._fade.style.key === key)
            return;

        const nextStyle = {...style, key, pipeline: null};
        this._fade.setStyle(nextStyle, {animate});
        this.queue_redraw();
    }

    /** Setter order is the actor's invariant: target, phase, then plan and scale, style last. */
    applyPass(pass) {
        this.setPhaseInTransform(pass.phaseInTransform);
        this.setClipTarget(pass.clipTarget);
        this.setBodyPlan(pass.bodyPlan);
        this.setScale(pass.scale);
        this.setShadowInsets(pass.ring?.insets ?? null);
        this.setShadowStyle(shadowStyleFrom(pass));
    }

    vfunc_paint_node(node, paintContext) {
        const currentStyle = this._fade.style;
        if (this.width <= 0 || this.height <= 0 || !currentStyle)
            return;

        // Advance the blend to the drawn frame, then queue more frames while it runs.
        if (this._fade.advance())
            this.queue_redraw();

        // Carry Clutter's actor paint opacity through, so minimize and fade animations apply.
        const paintOpacity = this.get_paint_opacity() / 255;
        if (paintOpacity <= 0)
            return;

        const context = coglContextForBake(paintContext);
        if (!context)
            return;

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

    /** shadowLayout owns the decision; this owns only the Clutter boxes reused per scale. */
    _relayout(style, scale) {
        const layout = shadowLayout(style, {width: this.width, height: this.height},
            this._insets ?? ZERO_INSETS, scale, {
                ...readBodySizes(this._clipTarget, this._windowActor,
                    findMetaWindowCached(this._windowActor)),
                bodyPlan: this._bodyPlan,
            });
        // Called on every pass, decided or not: a decided pass re-arms the one-strike latch.
        this._reportBodyDisagreement(layout);

        const slicesChanged = layout.castChanged || !style.slices;
        if (slicesChanged) {
            style.slices = layout.slices;
            style.corner = layout.corner;
            style.cast = layout.cast;
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

        // Snap only the boxes this paint writes: a repeat paint of the same cast allocates nothing.
        if (slicesChanged || entry.cast !== style.cast) {
            // Actor-local space keeps the cutlines invariant while the window is dragged.
            snapSliceBoxesInto(entry.boxes, style.cast, style.corner, scale);
            entry.cast = style.cast;
        }

        return entry.boxes;
    }

    /** Speaks once per episode; any pass with nothing to say re-arms the one-strike latch. */
    _reportBodyDisagreement(layout) {
        const state = settleUndecidedState(layout);
        if (!state) {
            this._bodyDiagnostic.check(null);
            return;
        }
        this._bodyDiagnostic.check(shadowBodyWarning(layout.authority,
            {width: this.width, height: this.height},
            readActorSize(this._windowActor), state));
    }

    destroy() {
        this._fade.reset();
        for (const binding of this._bindings)
            binding.unbind();
        this._bindings = [];
        this._subscriptions?.disconnectAll();
        try {
            this._container?.remove_child(this);
        } catch {
            // remove_child failed because the container is already gone.
        }
        this._container = null;
        super.destroy();
    }
});
