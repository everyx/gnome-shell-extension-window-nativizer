/** A shaped-texture mask keeps mipmapping; it is only read when the container is non-opaque. */

import Cogl from 'gi://Cogl';

import {roundedMaskBytes} from './overviewMaskBytes.js';

const opaqueMasks = new WeakMap();

/** MetaShapedTexture rejects a null mask, so retiring one means this 1x1 opaque texture. */
export function opaqueMask(context) {
    let mask = opaqueMasks.get(context);
    if (!mask) {
        mask = Cogl.Texture2D.new_from_data(
            context, 1, 1, Cogl.PixelFormat.A_8, 1, new Uint8Array([255]));
        mask.set_auto_mipmap(true);
        opaqueMasks.set(context, mask);
    }
    return mask;
}

/** Uploads the pure mask bytes as a Cogl texture matching the desktop clip's body geometry. */
export function buildRoundedMask(context, geometry) {
    const mask = roundedMaskBytes(geometry);
    if (!mask)
        return null;

    const texture = Cogl.Texture2D.new_from_data(
        context, mask.width, mask.height, Cogl.PixelFormat.A_8, mask.width, mask.data);
    texture.set_auto_mipmap(true);
    return texture;
}
