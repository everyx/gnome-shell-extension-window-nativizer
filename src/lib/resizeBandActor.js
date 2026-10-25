/** Strips placed from the actor's live size each allocation, so a resize cannot strand them. */

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import {beginWindowGrabOp, getPointerSprite, getResizeGrabOp} from '../platform/grabOp.js';
import {CursorShape, setActorCursor} from '../platform/actorCursor.js';
import {setActorAboveSibling} from '../platform/display.js';
import {insetsEqual, rectEquals} from '../platform/rect.js';

import {Subscriptions} from './subscriptions.js';

import {ZERO_INSETS} from './frame.js';
import {
    bandParamsInto,
    computeResizeBandsInto,
    edgeForStagePoint,
    emptyBands,
    normalizeConstrainedEdges,
    RESIZE_BAND,
    RESIZE_BAND_REGIONS,
} from './resizeBand.js';
import {isWindowAllowsResize} from '../platform/window.js';
import {getWindowFromActor} from '../platform/windowActor.js';
import {setActorBox} from './snap.js';

export const RESIZE_BAND_G_TYPE = 'WindowNativizerResizeBand';

// The regions sit outside the actor, so the container must be larger or they would be clipped away.
const OUTER = RESIZE_BAND;

/** What the band is told before the first setGeometry: no ring, no bounds, identity scale. */
const NO_GEOMETRY = Object.freeze({
    insets: ZERO_INSETS, bounds: null, boundsUnknown: false, scale: 1, constrainedEdges: null,
});

// `a === b` first: for a cache, absent on both reads as unchanged, which is a statement about this
// comparison rather than about equality - platform/rect.js answers the latter, where an unreadable
// side never equals anything.
function sameBounds(a, b) {
    return a === b || (a && b && rectEquals(a, b));
}

function sameConstrainedEdges(a, b) {
    return a === b || (a && b && insetsEqual(a, b));
}

/** Whether a setGeometry call would change anything, which is what decides the relayout. */
function sameGeometry(a, b) {
    return a.scale === b.scale && a.boundsUnknown === b.boundsUnknown &&
        insetsEqual(a.insets, b.insets) && sameBounds(a.bounds, b.bounds) &&
        sameConstrainedEdges(a.constrainedEdges, b.constrainedEdges);
}

export const ResizeBand = GObject.registerClass({
    GTypeName: RESIZE_BAND_G_TYPE,
}, class ResizeBand extends St.Widget {
    /** @param container - windowGroup; the band is inserted above windowActor */
    _init(windowActor, container) {
        // clip_to_allocation keeps picking in the band box: nothing of ours swallows a stray click.
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
        this._subscriptions = new Subscriptions();
        this._regions = new Map();
        this._childBox = new Clutter.ActorBox();
        this._bands = emptyBands();
        this._params = {frame: null, bounds: null, scale: 1};
        this._frame = null;
        this._hover = null;
        // Everything setGeometry is told, as one record: the check and the layout read it whole.
        this._geometry = NO_GEOMETRY;

        // Bound directly to the actor: a debounced read would lag the live size during a drag.
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
            // connectObject ties the handlers to this band, so destroy() takes them with it.
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

        // Follow the actor's visibility, so a minimized window leaves no click-catching strip.
        this._visibleBinding = windowActor.bind_property(
            'visible', this, 'visible', GObject.BindingFlags.SYNC_CREATE);
        this._subscriptions.connect(windowActor, 'destroy', () => this.destroy());

        container.insert_child_above(this, windowActor);
    }

    /** What the geometry derives from; strips are placed in vfunc_allocate, so no absolute px. */
    setGeometry({insets, bounds = null, boundsUnknown = false, scale = 1, constrainedEdges = null}) {
        const next = {
            // Copied, so a caller reusing one insets object cannot change the geometry under us.
            insets: {...insets ?? ZERO_INSETS},
            bounds: bounds ? {x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height} : null,
            boundsUnknown: Boolean(boundsUnknown),
            scale,
            constrainedEdges: normalizeConstrainedEdges({constrainedEdges}),
        };
        if (sameGeometry(this._geometry, next))
            return;

        this._geometry = next;
        this.queue_relayout();
    }

    /** Runs after the BindConstraints sized the container, so strips match the painted size. */
    vfunc_allocate(box) {
        // Bypass the layout manager to keep the direct child allocations.
        this.set_allocation(box);

        // A late allocation can arrive after or during destroy().
        if (!this._childBox)
            return;

        // Sign conventions live in the pure bandParamsInto; the scratch record is reused each frame.
        bandParamsInto(this._params, box, this._geometry.insets, this._geometry.bounds, this._geometry.scale);
        // Kept for `_directionForEvent()`, which resolves the pointer in the same container frame.
        this._frame = this._params.frame;

        // Written in place into `this._bands`; the flag says whether any rect moved.
        const changed = computeResizeBandsInto(this._bands, {
            frame: this._params.frame,
            bounds: this._params.bounds,
            boundsUnknown: this._geometry.boundsUnknown,
            // No surface clip: the band may sit outside the client's surface.
            scale: this._params.scale,
            constrainedEdges: this._geometry.constrainedEdges,
        });

        const childBox = this._childBox;
        for (const region of RESIZE_BAND_REGIONS) {
            const child = this._regions.get(region);
            const rect = this._bands[region];
            if (rect)
                setActorBox(childBox, rect.x, rect.y, rect.x + rect.width, rect.y + rect.height);
            else
                // Zero area, not hidden: hiding here queues a relayout and trips Clutter's warning.
                setActorBox(childBox, 0, 0, 0, 0);
            child.allocate(childBox);
        }

        // The ground moved: drop the stale cursor, but only on a move, or hover flickers each time.
        if (changed)
            this.resetCursor();
    }

    restack() {
        setActorAboveSibling(this, this._windowActor, this._container);
    }

    resetCursor() {
        this._hover = null;
        for (const child of this._regions.values())
            setActorCursor(child, CursorShape.DEFAULT);
    }

    destroy() {
        this.disconnectObject(this);
        this._subscriptions?.disconnectAll();
        this._visibleBinding?.unbind();
        this._visibleBinding = null;
        this._regions.clear();
        this._childBox = null;
        this._bands = null;
        this._params = null;
        this._frame = null;
        this._geometry = NO_GEOMETRY;
        try {
            this._container?.remove_child(this);
        } catch {
            // Container already gone.
        }
        this._container = null;
        this._windowActor = null;
        super.destroy();
    }

    /** The strip only delivered the event; the frame carries the geometry, in GTK's own order. */
    _directionForEvent(event) {
        if (!this._frame)
            return null;
        return edgeForStagePoint(this._frame, event.get_coords(), this.get_transformed_position(),
            this._geometry.constrainedEdges);
    }

    _applyCursor(region, event) {
        const direction = this._directionForEvent(event);
        if (this._hover?.region === region && this._hover.direction === direction)
            return Clutter.EVENT_PROPAGATE;
        this._hover = direction ? {region, direction} : null;
        setActorCursor(this._regions.get(region), direction ?? CursorShape.DEFAULT);
        return Clutter.EVENT_PROPAGATE;
    }

    _clearCursor(region) {
        if (this._hover?.region === region) {
            this._hover = null;
            setActorCursor(this._regions.get(region), CursorShape.DEFAULT);
        }
        return Clutter.EVENT_PROPAGATE;
    }

    /** Hands the grab to Mutter, or lets the press through. */
    _onButtonPress(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

        const direction = this._directionForEvent(event);
        if (!direction)
            return Clutter.EVENT_PROPAGATE;

        const win = getWindowFromActor(this._windowActor);
        if (!isWindowAllowsResize(win))
            return Clutter.EVENT_PROPAGATE;

        const sprite = getPointerSprite(event);
        const [x, y] = event.get_coords();
        const posHint = new Graphene.Point({x, y});

        const op = getResizeGrabOp(direction);
        const grabbed = beginWindowGrabOp(
            win,
            op,
            sprite,
            event.get_time(),
            posHint
        );
        if (!grabbed)
            return Clutter.EVENT_PROPAGATE;

        return Clutter.EVENT_STOP;
    }
});
