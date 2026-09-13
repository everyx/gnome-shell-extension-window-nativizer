/**
 * ShadowActor: the shadow of one window, drawn from a baked texture.
 *
 * Geometry is the compositor's job. Four Clutter.BindConstraint sync the padded rect with
 * the window actor and seven property bindings carry opacity, visibility, pivot, scale and
 * translation through the map, close and minimize animations, so neither a frame nor a
 * resize costs any JavaScript.
 *
 * Painting is eight texture rectangles out of one baked buffer (shadowTexture.js): four
 * corners, four edges stretched from a one-pixel strip, and no middle, because the
 * shader's hollow mask leaves the window's interior transparent.
 *
 * A style change cross-fades rather than cutting, which is what libadwaita does: its
 * backdrop rule declares `transition: box-shadow 200ms ease-out`, and it makes the biggest
 * shadow layer transparent in backdrop on purpose so the extents stay put. A window switch
 * moves focus several times before it holds still, and without the fade every one of those
 * turns into a visible pop.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {
    setPipelineOpacity,
    shadowGeometry,
    shadowPipelineFor,
    shadowSlices,
    styleKey,
    SHADOW_PAD,
} from './shadowTexture.js';

/** libadwaita's `$backdrop_transition`. */
const FADE_MS = 200;

/** The curve it is timed with: CSS `ease-out`, as a unit cubic Bézier. */
const EASE_OUT = [0, 0, 0.58, 1];

/** Frame interval the fade is stepped at; the fade stops itself when it reaches the end. */
const FADE_STEP_MS = 16;

/**
 * A unit cubic Bézier evaluated the way CSS does: solve for the parameter whose x is the
 * input, then read y. Four Newton steps land well inside a pixel's worth of alpha.
 *
 * @param {number} t - Progress along the curve, 0 to 1
 * @param {number[]} curve - x1, y1, x2, y2
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

/** Properties that carry the shadow through the window's own animations. */
const SYNCED_PROPERTIES = [
    'opacity', 'visible', 'pivot-point', 'scale-x', 'scale-y', 'translation-x', 'translation-y',
];

/** Registered type name, the stable identity of one of our actors. */
export const SHADOW_ACTOR_G_TYPE = 'WindowNativizerShadowActor';

export const ShadowActor = GObject.registerClass({
    GTypeName: SHADOW_ACTOR_G_TYPE,
}, class ShadowActor extends Clutter.Actor {
    /**
     * @param {Clutter.Actor} windowActor - Actor of the window being decorated
     * @param {Clutter.Actor} container - Container actor (windowGroup), which the shadow
     *   is inserted below
     */
    _init(windowActor, container) {
        super._init({name: 'WindowNativizerShadowActor', reactive: false, opacity: 255});

        this._windowActor = windowActor;
        this._container = container;
        this._style = null;
        this._body = null;
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
     * Set the rect the shadow is cast by: the window body, in window actor coordinates.
     * A client-side decorated window reserves a margin ring around its body for its own
     * shadow, and a ring is not part of the window. Null or degenerate casts the whole
     * actor, which is the same rect for a window that reserves no ring.
     *
     * @param {{x: number, y: number, width: number, height: number}|null} body
     */
    setShadowBody(body) {
        const next = body && body.width > 0 && body.height > 0
            ? {x: body.x, y: body.y, width: body.width, height: body.height}
            : null;
        const current = this._body;
        if (current === next || (current && next &&
            current.x === next.x && current.y === next.y &&
            current.width === next.width && current.height === next.height))
            return;

        this._body = next;
        this.queue_redraw();
    }

    /**
     * Draw this shadow: corner radius and shadow layers, already resolved for the window's
     * state. The bake happens at the first paint of a style, because the Cogl context does
     * not exist outside a paint.
     *
     * @param {{radius: number, shadows: Array<object>}} style
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

        // A change arriving mid-fade keeps whichever side is more visible as the one fading
        // out, so a burst of focus changes reads as one movement instead of a series of
        // jumps. Its weight carries over, so the fade never pops back to full.
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

        const context = paintContext.get_framebuffer().get_context();
        const pipeline = this._pipelineFor(context, this._style);
        if (!pipeline)
            return;

        if (this._outgoing && this._progress < 1) {
            const {style, weight} = this._outgoing;
            const outgoing = this._pipelineFor(context, style);
            if (outgoing) {
                setPipelineOpacity(outgoing, (1 - this._progress) * weight);
                this._addRects(node, outgoing, style);
            }
        }

        setPipelineOpacity(pipeline, this._outgoing ? this._progress : 1);
        this._addRects(node, pipeline, this._style);

        if (this._outgoing && this._progress >= 1)
            this._finishFade();
    }

    /** Adds the eight texture rectangles of one style to the paint node. */
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

    /**
     * The padded rect the shadow is laid out over, in this actor's coordinates: the cast
     * body shifted by nothing (the actor sits at -SHADOW_PAD from the window actor, which
     * is where the padded body rect starts) and grown by SHADOW_PAD on each side.
     */
    _castRect() {
        const body = this._body ?? {
            x: 0, y: 0,
            width: this.width - SHADOW_PAD * 2,
            height: this.height - SHADOW_PAD * 2,
        };
        return {
            x: body.x, y: body.y,
            width: body.width + SHADOW_PAD * 2,
            height: body.height + SHADOW_PAD * 2,
        };
    }

    /** Destination boxes follow the cast rect; the sources never change. */
    _relayout(style) {
        const cast = this._castRect();
        const previous = style.cast;
        if (style.slices && previous && previous.x === cast.x && previous.y === cast.y &&
            previous.width === cast.width && previous.height === cast.height)
            return;
        style.slices = shadowSlices(shadowGeometry(style.radius), cast.width, cast.height);
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
            // Window actor already destroyed: its signals went with it
        }
        this._style = null;
        this._outgoing = null;
        try {
            this._container?.remove_child(this);
        } catch {
            // Container may already be destroyed
        }
        this._container = null;
        super.destroy();
    }
});
