/**
 * ResizeBand: the strip around a window that starts a resize grab, as one transparent
 * container above its window actor with one reactive child per side. The container is
 * bound to the window actor (position and size), and the strips are placed from the
 * actor's live size on every allocation, so a resize cannot leave the band behind. The
 * children are only hit surfaces; the direction comes from `edgeForPoint()`, GTK's own
 * order. Model and cost in docs/decoration-model.md § The resize band; lifecycle in
 * docs/architecture.md.
 */

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {frameFromInsets, ZERO_INSETS} from './frame.js';
import {
    computeResizeBands,
    edgeForPoint,
    normalizeConstrainedEdges,
    RESIZE_BAND,
    RESIZE_BAND_REGIONS,
} from './resizeBand.js';

export const RESIZE_BAND_G_TYPE = 'WindowNativizerResizeBand';

// The band reaches RESIZE_BAND (12) outward on every side, so the container has to be
// larger than the window actor by that much, or the regions would be clipped out of it.
const OUTER = RESIZE_BAND;

// The eight-way cursor and the matching compositor grab op, keyed by the direction
// `edgeForPoint()` resolves. A corner never resolves to a straight edge unless GTK's own
// order says so there.
const DIRECTION_CURSOR = {
    n: Clutter.CursorType.N_RESIZE,
    ne: Clutter.CursorType.NE_RESIZE,
    e: Clutter.CursorType.E_RESIZE,
    se: Clutter.CursorType.SE_RESIZE,
    s: Clutter.CursorType.S_RESIZE,
    sw: Clutter.CursorType.SW_RESIZE,
    w: Clutter.CursorType.W_RESIZE,
    nw: Clutter.CursorType.NW_RESIZE,
};

const DIRECTION_GRAB_OP = {
    n: Meta.GrabOp.RESIZING_N,
    ne: Meta.GrabOp.RESIZING_NE,
    e: Meta.GrabOp.RESIZING_E,
    se: Meta.GrabOp.RESIZING_SE,
    s: Meta.GrabOp.RESIZING_S,
    sw: Meta.GrabOp.RESIZING_SW,
    w: Meta.GrabOp.RESIZING_W,
    nw: Meta.GrabOp.RESIZING_NW,
};

/**
 * @param {Record<string, object|null>|null} a
 * @param {Record<string, object|null>} b
 * @returns {boolean} Whether the two band sets are the same rects
 */
function sameBands(a, b) {
    if (!a)
        return false;
    for (const region of RESIZE_BAND_REGIONS) {
        const left = a[region];
        const right = b[region];
        if (Boolean(left) !== Boolean(right))
            return false;
        if (left && (left.x !== right.x || left.y !== right.y ||
            left.width !== right.width || left.height !== right.height))
            return false;
    }
    return true;
}

/**
 * @param {{x:number,y:number,width:number,height:number}|null} a
 * @param {{x:number,y:number,width:number,height:number}|null} b
 * @returns {boolean}
 */
function sameBounds(a, b) {
    if (!a || !b)
        return a === b;
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * @param {{top:boolean,right:boolean,bottom:boolean,left:boolean}|null} a
 * @param {{top:boolean,right:boolean,bottom:boolean,left:boolean}|null} b
 * @returns {boolean}
 */
function sameConstrainedEdges(a, b) {
    if (!a && !b)
        return true;
    if (!a || !b)
        return false;
    return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}

export const ResizeBand = GObject.registerClass({
    GTypeName: RESIZE_BAND_G_TYPE,
}, class ResizeBand extends St.Widget {
    /**
     * @param {Clutter.Actor} windowActor
     * @param {Clutter.Actor} container - windowGroup; band inserted above windowActor
     */
    _init(windowActor, container) {
        // clip_to_allocation keeps picking inside the band bounding box: nothing of ours
        // may swallow a click the regions do not cover.
        super._init({
            name: RESIZE_BAND_G_TYPE,
            reactive: false,
            clip_to_allocation: true,
            width: 1,
            height: 1,
            // Not a control: an input region with no accessible meaning of its own.
            accessible_role: Atk.Role.INVALID,
        });

        this._windowActor = windowActor;
        this._container = container;
        this._regions = new Map();
        this._childBox = new Clutter.ActorBox();
        this._bands = null;
        this._frame = null;
        this._hover = null;
        this._insets = ZERO_INSETS;
        this._bounds = null;
        this._scale = 1;
        this._constrainedEdges = null;

        // The actor is the ground truth for the band's geometry: it is the thing Mutter
        // resizes every frame, while our reconcile is debounced. Binding here (rather than
        // reading the frame rect on a 50ms tick) is what keeps the regions under the
        // pointer during a drag.
        for (const [coordinate, offset] of [
            [Clutter.BindCoordinate.X, -OUTER],
            [Clutter.BindCoordinate.Y, -OUTER],
            [Clutter.BindCoordinate.WIDTH, OUTER * 2],
            [Clutter.BindCoordinate.HEIGHT, OUTER * 2],
        ])
            this.add_constraint(new Clutter.BindConstraint({source: windowActor, coordinate, offset}));

        for (const region of RESIZE_BAND_REGIONS) {
            const child = new St.Widget({
                name: `${RESIZE_BAND_G_TYPE}-${region}`,
                reactive: true,
            });
            // connectObject attaches the handlers to this band's lifetime: destroy()
            // takes the children with it, so nothing has to be disconnected by hand.
            child.connectObject('enter-event',
                (_actor, event) => this._applyCursor(region, event), this);
            child.connectObject('motion-event',
                (_actor, event) => this._applyCursor(region, event), this);
            child.connectObject('leave-event', () => this._clearCursor(region), this);
            child.connectObject('button-press-event',
                (_actor, event) => this._onButtonPress(event), this);
            this.add_child(child);
            this._regions.set(region, child);
        }

        // Follow the window actor's visibility (minimize, other workspace) so a hidden
        // window leaves no click-catching strip behind.
        this._visibleBinding = windowActor.bind_property(
            'visible', this, 'visible', GObject.BindingFlags.SYNC_CREATE);
        this._destroyId = windowActor.connect('destroy', () => this.destroy());

        container.insert_child_above(this, windowActor);
    }

    /**
     * Store the decisions the geometry is derived from. The regions themselves are placed
     * in vfunc_allocate() from the actor's live size, so this does not carry absolute px.
     * @param {object} params
     * @param {import('./frame.js').Insets|null} params.insets - Ring between actor and body
     * @param {{x:number,y:number,width:number,height:number}|null} [params.bounds=null] - Monitor rect
     * @param {number} [params.scale=1] - Monitor scale the frame was read at
     * @param {{top?: boolean, right?: boolean, bottom?: boolean, left?: boolean}|null} [params.constrainedEdges=null]
     */
    setGeometry({insets, bounds = null, scale = 1, constrainedEdges = null}) {
        const nextInsets = insets ?? ZERO_INSETS;
        const nextConstrained = normalizeConstrainedEdges({constrainedEdges});
        if (this._insets.left === nextInsets.left && this._insets.top === nextInsets.top &&
            this._insets.right === nextInsets.right && this._insets.bottom === nextInsets.bottom &&
            this._scale === scale && sameBounds(this._bounds, bounds) &&
            sameConstrainedEdges(this._constrainedEdges, nextConstrained))
            return;

        this._insets = {
            left: nextInsets.left, top: nextInsets.top,
            right: nextInsets.right, bottom: nextInsets.bottom,
        };
        this._bounds = bounds
            ? {x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height}
            : null;
        this._scale = scale;
        this._constrainedEdges = nextConstrained;
        this.queue_relayout();
    }

    /**
     * Allocate the four strips from the container's own allocation plus the stored insets.
     * Called after the BindConstraints have sized the container for this frame, so the
     * strips are always placed against the size being painted.
     * @param {Clutter.ActorBox} box
     */
    vfunc_allocate(box) {
        // Not super: St.Widget would run the (fixed) layout manager, which would undo the
        // direct child allocations below on the next pass. This is the same shape
        // boxpointer.js uses.
        this.set_allocation(box);

        // Guard against late allocations arriving after or during destroy().
        if (!this._childBox)
            return;

        const containerWidth = box.x2 - box.x1;
        const containerHeight = box.y2 - box.y1;
        // The container is the actor grown by OUTER per side; undo that to place the body.
        const actorSize = {width: containerWidth - OUTER * 2, height: containerHeight - OUTER * 2};
        const body = frameFromInsets(actorSize, this._insets);
        const frame = {
            x: body.x + OUTER, y: body.y + OUTER,
            width: body.width, height: body.height,
        };
        // Kept in the container's coordinates: `_directionForEvent()` resolves the pointer
        // against it with GTK's own order, in the same space.
        this._frame = frame;
        const bounds = this._bounds
            ? {
                x: this._bounds.x - box.x1,
                y: this._bounds.y - box.y1,
                width: this._bounds.width,
                height: this._bounds.height,
            }
            : null;

        const bands = computeResizeBands({
            frame,
            bounds,
            // No surface clip: the band may sit outside the client's surface.
            scale: this._scale,
            constrainedEdges: this._constrainedEdges,
        });
        const changed = !sameBands(this._bands, bands);
        if (changed)
            this._bands = bands;

        const childBox = this._childBox;
        for (const region of RESIZE_BAND_REGIONS) {
            const child = this._regions.get(region);
            const rect = bands[region];
            if (rect) {
                childBox.x1 = rect.x;
                childBox.y1 = rect.y;
                childBox.x2 = rect.x + rect.width;
                childBox.y2 = rect.y + rect.height;
            } else {
                // Zero area, not hidden: hiding a child queues a relayout from inside
                // this allocation, which leaves the band itself needing one and trips
                // Clutter's "can't update stage views ... needs an allocation" warning.
                // A zero-size reactive child is simply never picked.
                childBox.x1 = 0;
                childBox.y1 = 0;
                childBox.x2 = 0;
                childBox.y2 = 0;
            }
            child.allocate(childBox);
        }

        // The ground moved under the pointer: drop the stale cursor until motion resets it.
        // Only when it actually moved, or a hover would flicker on every allocation.
        if (changed)
            this.resetCursor();
    }

    /** Re-pin above the window actor; window_group's stacking is rebuilt on 'restacked'. */
    restack() {
        this._container?.set_child_above_sibling(this, this._windowActor);
    }

    /** Back to the default arrow, e.g. after a grab op or when the window moved. */
    resetCursor() {
        this._hover = null;
        for (const child of this._regions.values())
            child.set_cursor_type(Clutter.CursorType.DEFAULT);
    }

    destroy() {
        this.disconnectObject(this);
        if (this._destroyId) {
            try {
                this._windowActor?.disconnect(this._destroyId);
            } catch {
                // Window actor already destroyed.
            }
            this._destroyId = 0;
        }
        this._visibleBinding?.unbind();
        this._visibleBinding = null;
        this._regions.clear();
        this._childBox = null;
        this._bands = null;
        this._frame = null;
        this._constrainedEdges = null;
        try {
            this._container?.remove_child(this);
        } catch {
            // Container already gone.
        }
        this._container = null;
        this._windowActor = null;
        super.destroy();
    }

    // ---------- Internal ----------

    /**
     * The direction under a pointer event, resolved by GTK's own order. The strip is only
     * the surface that delivered the event; the frame carries the geometry.
     * @param {Clutter.Event} event
     * @returns {'n'|'ne'|'e'|'se'|'s'|'sw'|'w'|'nw'|null}
     */
    _directionForEvent(event) {
        if (!this._frame)
            return null;
        const [x, y] = event.get_coords();
        const [originX, originY] = this.get_transformed_position();
        return edgeForPoint(this._frame, x - originX, y - originY, {
            constrainedEdges: this._constrainedEdges,
        });
    }

    /**
     * @param {string} region
     * @param {Clutter.Event} event
     * @returns {boolean} Clutter.EVENT_PROPAGATE
     */
    _applyCursor(region, event) {
        const direction = this._directionForEvent(event);
        if (this._hover?.region === region && this._hover.direction === direction)
            return Clutter.EVENT_PROPAGATE;
        this._hover = direction ? {region, direction} : null;
        this._regions.get(region)?.set_cursor_type(direction
            ? DIRECTION_CURSOR[direction]
            : Clutter.CursorType.DEFAULT);
        return Clutter.EVENT_PROPAGATE;
    }

    /**
     * @param {string} region
     * @returns {boolean} Clutter.EVENT_PROPAGATE
     */
    _clearCursor(region) {
        if (this._hover?.region === region) {
            this._hover = null;
            this._regions.get(region)?.set_cursor_type(Clutter.CursorType.DEFAULT);
        }
        return Clutter.EVENT_PROPAGATE;
    }

    /**
     * @param {Clutter.Event} event
     * @returns {boolean} EVENT_STOP when the grab was handed to Mutter
     */
    _onButtonPress(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

        const direction = this._directionForEvent(event);
        if (!direction)
            return Clutter.EVENT_PROPAGATE;

        const win = this._windowActor?.meta_window ?? this._windowActor?.metaWindow;
        if (!win?.allows_resize?.())
            return Clutter.EVENT_PROPAGATE;

        // sprite is the pointer the compositor drags with. It is documented nullable, so
        // windowMenu.js's get_pointer_sprite() fallback is kept rather than assumed away.
        const backend = global.stage.get_context().get_backend();
        const sprite = backend.get_sprite(global.stage, event) ||
            backend.get_pointer_sprite(global.stage);
        if (!sprite)
            return Clutter.EVENT_PROPAGATE;

        // begin_grab_op takes the pointer position, not a gravity: pos_hint is a
        // Graphene.Point and Mutter uses it instead of querying the seat. The press
        // coordinate is that position, so no fallback is needed.
        const [x, y] = event.get_coords();
        win.begin_grab_op(
            DIRECTION_GRAB_OP[direction],
            sprite,
            event.get_time(),
            new Graphene.Point({x, y})
        );

        return Clutter.EVENT_STOP;
    }
});
