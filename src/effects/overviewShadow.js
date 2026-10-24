/** The shadow is the actor's sibling, not its child, so the preview's clone never carries it. */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import {SHADOW_PAD} from './shadowGeometry.js';

export const OVERVIEW_SHADOW_G_TYPE = 'WindowNativizerOverviewShadow';

export const OverviewShadow = GObject.registerClass({
    GTypeName: OVERVIEW_SHADOW_G_TYPE,
}, class OverviewShadow extends Clutter.Clone {
    /** @param windowWidth - Frame width in logical px, the reference the thumbnail is scaled by */
    _init(source, preview, container, windowWidth) {
        super._init({
            source,
            name: 'WindowNativizerOverviewShadow',
            reactive: false,
        });
        this._windowWidth = windowWidth > 0 ? windowWidth : 1;
        preview.insert_child_below(this, container);
    }

    /**
     * Pads the thumbnail box so the cloned shadow's body lines up with the container under it.
     * The box is not the thumbnail's: `Shell.WindowPreview` clamps every child to its own preferred
     * size, and a clone's preferred size is its source's - the desktop shadow actor, already a window
     * plus two pads. An unallocated container answers -Infinity.
     */
    vfunc_allocate(box) {
        const cbox = this.get_parent()?.window_container?.get_allocation_box?.() ?? null;
        const width = cbox && cbox.get_width() > 0 ? cbox.get_width() : box.get_width();
        const height = cbox && cbox.get_height() > 0 ? cbox.get_height() : box.get_height();
        const scale = width / this._windowWidth;
        const pad = SHADOW_PAD * scale;
        box.set_origin(box.get_x() - pad, box.get_y() - pad);
        box.set_size(width + 2 * pad, height + 2 * pad);
        super.vfunc_allocate(box);
    }
});
