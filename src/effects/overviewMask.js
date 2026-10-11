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
import Mtk from 'gi://Mtk';

import {roundedMaskBytes} from './overviewMaskBytes.js';

/** One reusable 1x1 opaque mask per Cogl context. */
const opaqueMasks = new WeakMap();

/**
 * Whether attaching the mask would move a path the desktop can see.
 *
 * Mutter reads a window's shaped texture directly for a window screenshot only while
 * `should_get_via_offscreen()` is false, and any non-null mask makes it true. The mask cannot
 * be detached from GJS (`set_mask_texture` rejects null), so for such a window the screenshot
 * would keep taking the actor-render path — rounded corners, alpha channel — for the rest of
 * the session, which is a change the desktop can show.
 *
 * `paint_to_bitmap()` (51) / `get_image()` (50) answer exactly that question: they return NULL
 * before reading anything back while the offscreen path is already in use, and a 1x1 clip keeps
 * the readback to a single pixel when it is not. The probe therefore costs nothing for the
 * windows that are already offscreen (direct scanout buffers) and one pixel for the rest.
 *
 * @param {object|null} shapedTexture - MetaShapedTexture, or null when unavailable
 * @returns {boolean} True when masking this window would change its desktop screenshot
 */
export function maskWouldChangeScreenshot(shapedTexture) {
    const clip = new Mtk.Rectangle({x: 0, y: 0, width: 1, height: 1});

    try {
        if (typeof shapedTexture?.paint_to_bitmap === 'function')
            return Boolean(shapedTexture.paint_to_bitmap(clip, Cogl.PixelFormat.RGBA_8888));
        if (typeof shapedTexture?.get_image === 'function')
            return Boolean(shapedTexture.get_image(clip));
    } catch {
        // A texture that cannot be probed is not one to take the risk on.
        return true;
    }

    return true;
}

/**
 * A 1x1 fully opaque mask. MetaShapedTexture rejects a null mask, so this is how
 * an overview mask is retired: alpha 1 leaves every pixel unchanged.
 * @param {Cogl.Context} context
 * @returns {Cogl.Texture}
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
 * @param {Cogl.Context} context
 * @param {object} geometry - See `roundedMaskBytes`
 * @returns {Cogl.Texture|null}
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
