/**
 * Overview shadow: a clone of a window's ShadowActor placed under the overview
 * preview, so a decorated window keeps its shadowed look in the overview.
 *
 * The desktop shadow is a sibling of the window actor in the window group, so
 * the preview's clone of the window actor never carries it; this clone supplies
 * it, scaled with the thumbnail.
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import {SHADOW_PAD} from './shadowGeometry.js';

export const OVERVIEW_SHADOW_G_TYPE = 'WindowNativizerOverviewShadow';

export const OverviewShadow = GObject.registerClass({
    GTypeName: OVERVIEW_SHADOW_G_TYPE,
}, class OverviewShadow extends Clutter.Clone {
    /**
     * @param {Clutter.Actor} source - The window's ShadowActor
     * @param {Clutter.Actor} preview - WindowPreview that owns the thumbnail
     * @param {Clutter.Actor} container - preview.window_container
     * @param {number} windowWidth - Window frame width, logical px
     */
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
     * Expands the thumbnail box by the shadow padding so the cloned shadow's body
     * lines up with the window container underneath it.
     * @param {Clutter.ActorBox} box
     */
    vfunc_allocate(box) {
        const width = box.get_width();
        const height = box.get_height();
        const scale = width / this._windowWidth;
        const pad = SHADOW_PAD * scale;
        box.set_origin(box.get_x() - pad, box.get_y() - pad);
        box.set_size(width + 2 * pad, height + 2 * pad);
        super.vfunc_allocate(box);
    }
});
