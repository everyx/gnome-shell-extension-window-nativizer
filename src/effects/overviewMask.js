/**
 * Overview rounded-corner mask: an A_8 alpha texture attached to a window's
 * MetaShapedTexture while the overview is shown.
 *
 * Unlike the desktop clip effect (a Clutter.OffscreenEffect), the mask lives
 * inside Mutter's own shaped-texture pipeline: it is sampled with the same
 * minification filter as the window colour, so a downscaled overview thumbnail
 * keeps Mutter's hardware mipmapping instead of resampling an offscreen FBO.
 *
 * Mutter only consults the mask on the non-opaque path, so the caller must also
 * drop the preview container's opacity below 255 (see WindowDecoration).
 */

import Cogl from 'gi://Cogl';

import {roundedMaskBytes} from './overviewMaskBytes.js';

const opaqueMasks = new WeakMap();

/**
 * A 1x1 fully opaque mask. MetaShapedTexture rejects a null mask, so this is how
 * an overview mask is retired: alpha 1 leaves every pixel unchanged.
 */
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

/**
 * Builds a rounded-corner A_8 mask matching the desktop clip's body geometry.
 *
 * The bytes (body fill, four corner coverage discs) are pure and live in
 * overviewMaskBytes.js; this only uploads them as a Cogl texture.
 *
 * @param geometry - See `roundedMaskBytes`
 */
export function buildRoundedMask(context, geometry) {
    const mask = roundedMaskBytes(geometry);
    if (!mask)
        return null;

    const texture = Cogl.Texture2D.new_from_data(
        context, mask.width, mask.height, Cogl.PixelFormat.A_8, mask.width, mask.data);
    texture.set_auto_mipmap(true);
    return texture;
}
