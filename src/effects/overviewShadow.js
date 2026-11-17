/** The overview's shadow paints the bake itself; there is no desktop actor left to clone. */

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';

import {coglContextForBake} from '../platform/coglContext.js';
import {snapSliceBoxesInto} from '../lib/snap.js';
import {SHADOW_PAD, shadowGeometry, shadowSlices} from './shadowGeometry.js';
import {shadowTextureFor} from './shadowTexture.js';

export const OVERVIEW_SHADOW_G_TYPE = 'WindowNativizerOverviewShadow';

export const OverviewShadow = GObject.registerClass({
    GTypeName: OVERVIEW_SHADOW_G_TYPE,
}, class OverviewShadow extends Clutter.Actor {
    /**
     * @param style - `{radius, shadows}`, the bake this shadow is drawn from
     * @param windowWidth - Frame width in logical px, the reference the thumbnail is scaled by
     */
    _init(style, preview, container, windowWidth) {
        super._init({name: 'WindowNativizerOverviewShadow', reactive: false});
        this._style = style;
        this._geometry = shadowGeometry(style.radius);
        this._windowWidth = windowWidth > 0 ? windowWidth : 1;
        preview.insert_child_below(this, container);
    }

    /**
     * Pads the thumbnail box so the shadow's body lines up with the container under it.
     * The box is not the thumbnail's: `Shell.WindowPreview` clamps every child to its own preferred
     * size. An unallocated container answers -Infinity.
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

    vfunc_paint_node(node, paintContext) {
        const cast = {x: 0, y: 0, width: this.width, height: this.height};
        const context = coglContextForBake(paintContext);
        const texture = context && shadowTextureFor(context, this._style.radius, this._style.shadows);
        if (!texture || !(cast.width > 0) || !(cast.height > 0))
            return;

        const pipeline = Cogl.Pipeline.new(context);
        const alpha = Math.round(this.get_paint_opacity());
        pipeline.set_color(new Cogl.Color({red: 255, green: 255, blue: 255, alpha}));
        pipeline.set_layer_texture(0, texture);

        const pipelineNode = new Clutter.PipelineNode(pipeline);
        node.add_child(pipelineNode);
        const slices = shadowSlices(this._geometry, cast.width, cast.height);
        const boxes = slices.map(() => new Clutter.ActorBox());
        snapSliceBoxesInto(boxes, cast, this._geometry.corner, 1);
        for (let i = 0; i < slices.length; i++) {
            const slice = slices[i];
            pipelineNode.add_texture_rectangle(boxes[i], slice.s1, slice.t1, slice.s2, slice.t2);
        }
    }
});
