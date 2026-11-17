/**
 * Pads the paint volume a window's offscreen is allocated from.
 *
 * A separate effect because Clutter skips the effect that is painting when it collects the volume
 * (`clutter-actor.c` compares against `priv->current_effect`): the clip cannot widen the FBO it is
 * about to be painted into, a sibling effect can.
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import {readActorSize} from './bodyPlan.js';
import {SHADOW_PAD} from './shadowGeometry.js';

export const SHADOW_VOLUME_G_TYPE = 'WindowNativizerShadowVolume';

export const ShadowVolume = GObject.registerClass({
    GTypeName: SHADOW_VOLUME_G_TYPE,
}, class ShadowVolume extends Clutter.Effect {
    _init() {
        super._init();
        this._on = false;
    }

    /** The shadow is drawn inside the clip's offscreen, so nothing paints here; only the volume. */
    setEnabled(on) {
        this._on = Boolean(on);
    }

    vfunc_modify_paint_volume(volume) {
        const size = this._on ? readActorSize(this.get_actor()) : null;
        if (!size)
            return true;
        const box = new Clutter.ActorBox();
        box.init(-SHADOW_PAD, -SHADOW_PAD, size.width + SHADOW_PAD, size.height + SHADOW_PAD);
        volume.union_box(box);
        return true;
    }
});
