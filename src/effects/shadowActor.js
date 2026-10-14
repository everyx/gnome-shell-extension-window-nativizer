/**
 * ShadowActor: 8-slice baked shadow below window actor; cross-fades on style change.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {ZERO_INSETS} from '../lib/frame.js';
import {pipelineOpacityFor} from '../lib/style.js';
import {clipTargetReadChanged, shadowBodyWarning, shadowLayout, shadowLayoutPosition, shadowPhaseOffset, shadowTranslation, SHADOW_PAD} from './shadowGeometry.js';
import {setPipelineOpacity, shadowPipelineFor, styleKey} from './shadowTexture.js';
import {setActorBox, snapSliceRects} from '../lib/snap.js';
import {coglContextForBake} from '../platform/coglContext.js';
import {findMetaWindow, getWindowBufferRect, getWindowFrameRect} from '../platform/window.js';
import {ShadowFadeStateMachine} from './shadowFade.js';

const SYNCED_PROPERTIES = [
    'opacity', 'visible', 'pivot-point', 'scale-x', 'scale-y',
];

/**
 * A live actor's size, or null when the actor is gone or its read throws. The body authority is
 * read from actors we do not own (the surface container can be replaced mid-flight), so a torn-down
 * read is "unknown" and falls through resolveClipSize rather than aborting the paint.
 * @param {{width:number,height:number}|null} actor
 * @returns {{width:number,height:number}|null}
 */
function readActorSize(actor) {
    if (!actor)
        return null;
    try {
        return {width: actor.width, height: actor.height};
    } catch {
        return null;
    }
}

/**
 * The window's own size, read live at relayout: its frame rect, else its buffer rect. The cast
 * must see a resize on the frame it starts, so this is read here rather than taken from the
 * pass; only its previous value travels in the body plan.
 * @param {object|null} win
 * @returns {{width:number,height:number}|null}
 */
function readWindowSize(win) {
    const frame = getWindowFrameRect(win);
    if (frame && frame.width > 0 && frame.height > 0)
        return {width: frame.width, height: frame.height};
    const buffer = getWindowBufferRect(win);
    if (buffer && buffer.width > 0 && buffer.height > 0)
        return {width: buffer.width, height: buffer.height};
    return null;
}

export const SHADOW_ACTOR_G_TYPE = 'WindowNativizerShadowActor';

export const ShadowActor = GObject.registerClass({
    GTypeName: SHADOW_ACTOR_G_TYPE,
}, class ShadowActor extends Clutter.Actor {
    /**
     * @param {Clutter.Actor} windowActor
     * @param {Clutter.Actor} container - windowGroup; shadow inserted below windowActor
     * @param {object|null} [St] - The St namespace the clip target path uses, so the applied
     *        phase read identifies the surface container by the clip's rule, not a global
     */
    _init(windowActor, container, St = null) {
        super._init({name: 'WindowNativizerShadowActor', reactive: false, opacity: 255});

        this._windowActor = windowActor;
        this._container = container;
        this._St = St;
        // The actor the clip resolved as its target. Its read is the shadow's body authority, so the
        // two derive their body from one source (see shadowLayout's bodySource). Kept live by
        // setClipTarget() on every decorate pass; null falls back to the window actor, exactly as
        // resolveClipSize does.
        this._clipTarget = null;
        // The size read from `_clipTarget` when it was last adopted. setClipTarget() compares it
        // against the live read so an in-place resize of the same container still repaints (see
        // clipTargetReadChanged): the shadow's own box is bound to the window actor and does not
        // move for a container-only resize, so nothing else would schedule that paint.
        this._clipTargetSize = null;
        // The pass plan the next relayout settles from: the reference points the hold compares
        // against and the window's own size as of the previous pass. Null until the first pass; the
        // layout then derives the body from the live reads, exactly as it did before the settle
        // existed.
        this._bodyPlan = null;
        // Edge-trigger for the body-authority warning, so a persistent disagreement is one loud
        // journal line per episode rather than one per paint frame.
        this._bodyWarningActive = false;
        this._insets = null;
        this._scale = 1.0;
        // The resolved clip target's phase strategy, kept in step by setPhaseInTransform(). The
        // mirror is the safe default until the decoration reports the real strategy.
        this._phaseInTransform = false;
        // The last phase a pass could read. While the fallback monitor scan cannot complete,
        // the shadow keeps this rather than translating by a fabricated zero; the clip keeps the
        // same phase, so the two cuts stay on one line. Zero is only the start.
        this._lastOffset = {x: 0, y: 0};
        this._fade = new ShadowFadeStateMachine({
            now: () => GLib.get_monotonic_time() / 1000,
        });

        // The bind constraint pins the actor at `window - PAD`; the position derived from the
        // window's transform (below) is applied as a translation on top of it, because assigning
        // `x`/`y` on an actor that still needs an allocation trips Clutter's "can't update stage
        // views ... needs an allocation" warning on every resize frame.
        for (const [coordinate, offset] of [
            [Clutter.BindCoordinate.X, -SHADOW_PAD],
            [Clutter.BindCoordinate.Y, -SHADOW_PAD],
            [Clutter.BindCoordinate.WIDTH, SHADOW_PAD * 2],
            [Clutter.BindCoordinate.HEIGHT, SHADOW_PAD * 2],
        ])
            this.add_constraint(new Clutter.BindConstraint({source: windowActor, coordinate, offset}));

        this._bindings = SYNCED_PROPERTIES.map(property => windowActor.bind_property(
            property, this, property, GObject.BindingFlags.SYNC_CREATE));

        // `x`/`y`, the translations, the actor scale and the pivot all move the shadow's cutout.
        // `allocation` is also needed because the applied phase is read from the surface
        // container's cached transform, and Mutter only invalidates it on the window actor's
        // allocation change: synced on position alone the read held the previous position's phase
        // indefinitely (measured at 1.25x: the shadow stayed one x behind while the clip painted
        // the new phase, opening the straight-edge hairline). On allocation the invalidation
        // handler runs first, so the read is the phase the clip paints with.
        this._geometrySignals = ['x', 'y', 'translation-x', 'translation-y', 'scale-x', 'scale-y',
            'pivot-point', 'allocation'].map(prop =>
            windowActor.connect(`notify::${prop}`, () => this._syncGeometry()));
        this._syncGeometry();

        this._destroyId = windowActor.connect('destroy', () => this.destroy());

        container.insert_child_below(this, windowActor);
    }

    /**
     * Synchronizes the shadow's derived position and translation with the window actor.
     *
     * The layout position is the bind constraint's `window - PAD`. The position that puts the
     * scaled cutout on the window's visual box is `shadowLayoutPosition`, and the difference
     * between the two is carried as a translation: a layout-space offset is in parent space and
     * ignores the actor's own scale, which is what left the cutout a pivot-dependent pad off the
     * window (see shadowLayoutPosition). The translation also carries the window's own translation
     * plus Mutter's Wayland subpixel offset.
     *
     * Every assignment notifies and queues a relayout, and this runs on each position, allocation,
     * translation, scale and pivot change - a resize fires several per frame, and each call writes
     * both axes and both translations, so half of these assignments would restate a value that did
     * not move. Only write what changed: the signals firing twice per frame is what this method's
     * cost is made of (293 calls over one window's 150-step resize, ~27us of shell CPU per call in
     * the assignments and the relayout they queue; the allocation signal adds one more to that set).
     */
    _syncGeometry() {
        if (!this._windowActor)
            return;
        const offset = shadowPhaseOffset(findMetaWindow(this._windowActor), this._phaseInTransform, this._St);
        // A null offset is an unreadable monitor geometry, not a zero phase: keep the last good
        // phase so the shadow's cutout stays on the clip's line instead of hopping to zero.
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

    /**
     * Follows the resolved clip target's phase strategy so both cuts read one source. Flips when
     * the container becomes identified or refused, and re-syncs the translation the shadow already
     * carries so the strategy change is not deferred to the next position change.
     * @param {boolean} phaseInTransform - True when the clip target carries the phase in its transform
     */
    setPhaseInTransform(phaseInTransform) {
        const next = Boolean(phaseInTransform);
        if (this._phaseInTransform === next)
            return;
        this._phaseInTransform = next;
        this._syncGeometry();
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
     * Points the shadow at the clip's resolved target, whose read is the body authority the clip
     * cuts. Called by the decoration on every pass after the target is resolved; a changed target
     * *or* a changed read of the same target re-derives the next paint's cast from it, while a pass
     * that leaves both the reference and the extent alone does nothing. The extent matters because
     * a surface container can resize in place: the same object then hands the shadow a new body,
     * the shadow's bound box does not move, and without the read comparison no paint would follow.
     * @param {Clutter.Actor|null} clipTarget
     */
    setClipTarget(clipTarget) {
        const next = clipTarget ?? null;
        const nextSize = readActorSize(next);
        if (!clipTargetReadChanged(this._clipTarget, next, this._clipTargetSize, nextSize))
            return;
        this._clipTarget = next;
        this._clipTargetSize = nextSize;
        this.queue_redraw();
    }

    /**
     * Sets the body plan the next layout settles from. WindowDecoration hands the same plan to the
     * clip, so the shadow's cast and the clip's cut derive one body by construction; the plan
     * carries no resolved body, and the layout evaluates the settle from the live reads at its own
     * relayout clock (which follows the actor's allocation, so per frame during a drag).
     * @param {{previousBody:object|null, previousAuthority:object|null,
     *   previousWindowSize:object|null}|null} plan
     */
    setBodyPlan(plan) {
        this._bodyPlan = plan ?? null;
    }

    /**
     * @returns {{width:number, height:number, cast:object|null, rightBand:object|null}} Live,
     *          read-only shadow geometry for the debug reply; every field is a read.
     */
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

    /**
     * Sets display scale externally, eliminating Shell queries from paint passes.
     * @param {number} scale
     */
    setScale(scale) {
        if (typeof scale === 'number' && scale > 0 && Number.isFinite(scale) && this._scale !== scale) {
            this._scale = scale;
            this._syncGeometry();
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

        // Inherit Clutter actor paint opacity (e.g. for window minimize/fade animations).
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

    // The layout decision (cast, slices, snapped quads) lives in the pure shadowLayout;
    // this method owns only the Clutter box objects it reuses per physical scale.
    _relayout(style, scale) {
        const layout = shadowLayout(style, {width: this.width, height: this.height},
            this._insets ?? ZERO_INSETS, scale, {
                targetSize: readActorSize(this._clipTarget),
                windowActorSize: readActorSize(this._windowActor),
                windowSize: readWindowSize(findMetaWindow(this._windowActor)),
                bodyPlan: this._bodyPlan,
            });
        this._warnOnBodyDisagreement(layout.authority);

        const slicesChanged = layout.castChanged || !style.slices;
        if (slicesChanged) {
            style.slices = layout.slices;
            style.corner = layout.corner;
            style.cast = Object.freeze(layout.cast);
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

        // Snap only the boxes this paint writes; a repeat paint of the same scale and cast
        // allocates nothing.
        if (slicesChanged || entry.cast !== style.cast) {
            // Snap in actor-local space to keep cutlines invariant during window drag.
            const rects = snapSliceRects(style.cast, style.corner, scale);
            for (let i = 0; i < entry.boxes.length; i++) {
                const rect = rects[i];
                setActorBox(entry.boxes[i], rect.x1, rect.y1, rect.x2, rect.y2);
            }
            entry.cast = style.cast;
        }

        return entry.boxes;
    }

    /**
     * Makes a body-authority disagreement loud, once per episode. `authority` is the body the clip
     * cuts (resolveClipSize of the target and the window actor); the shadow's box is bound to the
     * window actor, so on a healthy window the two agree and this is silent. A disagreement is the
     * glitch this warning exists to catch: the clip follows the container while the shadow follows
     * the actor, and the right band shrinks. Edge-triggered, so a persistent disagreement is one
     * WARNING naming the numbers rather than one per paint frame; agreement re-arms it.
     * @param {{width:number,height:number}|null} authority
     */
    _warnOnBodyDisagreement(authority) {
        const warning = shadowBodyWarning(authority,
            {width: this.width, height: this.height},
            readActorSize(this._windowActor));
        if (warning) {
            if (!this._bodyWarningActive) {
                this._bodyWarningActive = true;
                console.warn(warning);
            }
            return;
        }
        this._bodyWarningActive = false;
    }

    destroy() {
        this._fade.reset();
        for (const binding of this._bindings)
            binding.unbind();
        this._bindings = [];
        for (const sid of this._geometrySignals ?? []) {
            try {
                this._windowActor?.disconnect?.(sid);
            } catch {
                // Ignore.
            }
        }
        this._geometrySignals = [];
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
