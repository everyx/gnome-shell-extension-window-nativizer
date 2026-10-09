/**
 * ResizeBand: the strip around a window that starts a resize grab, as one transparent
 * container above its window actor with one reactive child per side. The container is
 * bound to the window actor (position and size), and the strips are placed from the
 * actor's live size on every allocation, so a resize cannot leave the band behind. The
 * children are only hit surfaces; the direction comes from `edgeForPoint()`, GTK's own
 * order.
 */

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {beginWindowGrabOp, CursorShape, getPointerSprite, setActorCursor} from '../compat/index.js';

import {ZERO_INSETS} from './frame.js';
import {
    computeResizeBandsInto,
    edgeForPoint,
    emptyBands,
    normalizeConstrainedEdges,
    RESIZE_BAND,
    RESIZE_BAND_REGIONS,
} from './resizeBand.js';
import {getWindowFromActor} from './pick.js';
import {setActorBox} from './snap.js';

export const RESIZE_BAND_G_TYPE = 'WindowNativizerResizeBand';

// The band reaches RESIZE_BAND (12) outward on every side, so the container has to be
// larger than the window actor by that much, or the regions would be clipped out of it.
const OUTER = RESIZE_BAND;

// Direction-to-grab-op mapping. Cursor shape is resolved via compat/actorCursor.js.
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
        this._bands = emptyBands();
        this._boundsScratch = null;
        this._frame = null;
        this._hover = null;
        this._insets = ZERO_INSETS;
        this._bounds = null;
        this._scale = 1;
        this._constrainedEdges = null;

        // Bind directly to window actor to track live size during drag without debounce lag.
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
        // Bypass St.Widget layout manager to preserve direct child allocations.
        this.set_allocation(box);

        // Guard against late allocations arriving after or during destroy().
        if (!this._childBox)
            return;

        const containerWidth = box.x2 - box.x1;
        const containerHeight = box.y2 - box.y1;
        // The frame and the translated bounds are reused in place: this runs every resize
        // frame, so they must not be new objects each pass. The container is the actor grown
        // by OUTER per side; undo that to place the body, kept in the container's coordinates
        // so `_directionForEvent()` resolves the pointer against it with GTK's own order.
        const frame = this._frame ?? (this._frame = {x: 0, y: 0, width: 0, height: 0});
        frame.x = this._insets.left + OUTER;
        frame.y = this._insets.top + OUTER;
        frame.width = containerWidth - OUTER * 2 - this._insets.left - this._insets.right;
        frame.height = containerHeight - OUTER * 2 - this._insets.top - this._insets.bottom;

        let bounds = null;
        if (this._bounds) {
            bounds = this._boundsScratch ?? (this._boundsScratch = {x: 0, y: 0, width: 0, height: 0});
            bounds.x = this._bounds.x - box.x1;
            bounds.y = this._bounds.y - box.y1;
            bounds.width = this._bounds.width;
            bounds.height = this._bounds.height;
        }

        // Written into `this._bands` in place; the returned flag replaces the old sameBands().
        const changed = computeResizeBandsInto(this._bands, {
            frame,
            bounds,
            // No surface clip: the band may sit outside the client's surface.
            scale: this._scale,
            constrainedEdges: this._constrainedEdges,
        });

        const childBox = this._childBox;
        for (const region of RESIZE_BAND_REGIONS) {
            const child = this._regions.get(region);
            const rect = this._bands[region];
            if (rect)
                setActorBox(childBox, rect.x, rect.y, rect.x + rect.width, rect.y + rect.height);
            else
                // Zero area, not hidden: hiding a child queues a relayout from inside
                // this allocation, which leaves the band itself needing one and trips
                // Clutter's "can't update stage views ... needs an allocation" warning.
                // A zero-size reactive child is simply never picked.
                setActorBox(childBox, 0, 0, 0, 0);
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
            setActorCursor(child, CursorShape.DEFAULT);
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
        setActorCursor(this._regions.get(region), direction ?? CursorShape.DEFAULT);
        return Clutter.EVENT_PROPAGATE;
    }

    /**
     * @param {string} region
     * @returns {boolean} Clutter.EVENT_PROPAGATE
     */
    _clearCursor(region) {
        if (this._hover?.region === region) {
            this._hover = null;
            setActorCursor(this._regions.get(region), CursorShape.DEFAULT);
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

        const win = getWindowFromActor(this._windowActor);
        if (!win?.allows_resize?.())
            return Clutter.EVENT_PROPAGATE;

        const sprite = getPointerSprite(event);
        const [x, y] = event.get_coords();
        const posHint = new Graphene.Point({x, y});

        // Hand off to Mutter via the compositor grab helper.
        const grabbed = beginWindowGrabOp(
            win,
            DIRECTION_GRAB_OP[direction],
            sprite,
            event.get_time(),
            posHint
        );
        if (!grabbed)
            return Clutter.EVENT_PROPAGATE;

        return Clutter.EVENT_STOP;
    }
});
