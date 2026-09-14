/**
 * ResizeBand: the 12px strip around a window that starts a resize grab, as one
 * transparent container above its window actor with one reactive child per region.
 * Model and cost in docs/decoration-model.md § The resize band; lifecycle in
 * docs/architecture.md.
 */

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {RESIZE_BAND_REGIONS} from './resizeBand.js';

export const RESIZE_BAND_G_TYPE = 'WindowNativizerResizeBand';

// Eight regions → the eight-way cursor and the matching compositor grab op.
const REGION_CURSOR = {
    n: Clutter.CursorType.N_RESIZE,
    ne: Clutter.CursorType.NE_RESIZE,
    e: Clutter.CursorType.E_RESIZE,
    se: Clutter.CursorType.SE_RESIZE,
    s: Clutter.CursorType.S_RESIZE,
    sw: Clutter.CursorType.SW_RESIZE,
    w: Clutter.CursorType.W_RESIZE,
    nw: Clutter.CursorType.NW_RESIZE,
};

const REGION_GRAB_OP = {
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
 * @param {Record<string, object|null>} bands
 * @returns {Record<string, object|null>}
 */
function copyBands(bands) {
    const copy = {};
    for (const region of RESIZE_BAND_REGIONS) {
        const rect = bands[region];
        copy[region] = rect
            ? {x: rect.x, y: rect.y, width: rect.width, height: rect.height}
            : null;
    }
    return copy;
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
        this._bands = null;
        this._hover = null;

        for (const region of RESIZE_BAND_REGIONS) {
            const child = new St.Widget({
                name: `${RESIZE_BAND_G_TYPE}-${region}`,
                reactive: true,
            });
            // connectObject attaches the handlers to this band's lifetime: destroy()
            // takes the children with it, so nothing has to be disconnected by hand.
            child.connectObject('enter-event', () => this._applyCursor(region), this);
            child.connectObject('motion-event', () => this._applyCursor(region), this);
            child.connectObject('leave-event', () => this._clearCursor(region), this);
            child.connectObject('button-press-event',
                (_actor, event) => this._onButtonPress(region, event), this);
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
     * @param {Record<string, object|null>} bands - From computeResizeBands()
     */
    setBands(bands) {
        if (sameBands(this._bands, bands))
            return;
        this._bands = copyBands(bands);

        let x1 = Infinity;
        let y1 = Infinity;
        let x2 = -Infinity;
        let y2 = -Infinity;
        for (const region of RESIZE_BAND_REGIONS) {
            const rect = this._bands[region];
            if (!rect)
                continue;
            x1 = Math.min(x1, rect.x);
            y1 = Math.min(y1, rect.y);
            x2 = Math.max(x2, rect.x + rect.width);
            y2 = Math.max(y2, rect.y + rect.height);
        }

        if (x1 === Infinity) {
            this._hideRegions();
            return;
        }

        this.set_position(x1, y1);
        this.set_size(Math.max(1, x2 - x1), Math.max(1, y2 - y1));

        for (const region of RESIZE_BAND_REGIONS) {
            const child = this._regions.get(region);
            const rect = this._bands[region];
            if (!rect) {
                child.hide();
                continue;
            }
            child.set_position(rect.x - x1, rect.y - y1);
            child.set_size(rect.width, rect.height);
            child.show();
        }

        // The ground moved under the pointer: drop the stale cursor until motion resets it.
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
        this._bands = null;
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

    _hideRegions() {
        for (const child of this._regions.values())
            child.hide();
        this.resetCursor();
    }

    /**
     * @param {string} region
     * @returns {boolean} Clutter.EVENT_PROPAGATE
     */
    _applyCursor(region) {
        if (this._hover !== region) {
            this._hover = region;
            this._regions.get(region)?.set_cursor_type(REGION_CURSOR[region]);
        }
        return Clutter.EVENT_PROPAGATE;
    }

    /**
     * @param {string} region
     * @returns {boolean} Clutter.EVENT_PROPAGATE
     */
    _clearCursor(region) {
        if (this._hover === region) {
            this._hover = null;
            this._regions.get(region)?.set_cursor_type(Clutter.CursorType.DEFAULT);
        }
        return Clutter.EVENT_PROPAGATE;
    }

    /**
     * @param {string} region
     * @param {Clutter.Event} event
     * @returns {boolean} EVENT_STOP when the grab was handed to Mutter
     */
    _onButtonPress(region, event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
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
            REGION_GRAB_OP[region],
            sprite,
            event.get_time(),
            new Graphene.Point({x, y})
        );

        return Clutter.EVENT_STOP;
    }
});
