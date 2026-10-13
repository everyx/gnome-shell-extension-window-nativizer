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
import {probeWouldChangeScreenshot} from './overviewMaskProbe.js';

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
 * `paint_to_bitmap()` answers exactly that question: it returns a `CoglBitmap*`, or `NULL` from
 * one of Mutter's own early-outs. Every NULL branch means the screenshot path cannot move under
 * this mask — no buffer and a zero destination size have no content to change, and the offscreen
 * branch (`should_get_via_offscreen()`, which includes our own already-attached mask) is the one
 * the mask would force — so `null` is read as "the screenshot does not change" and only a real
 * bitmap (the direct-read path, which the mask would move) is a refusal. The 1x1 clip keeps the
 * readback to a single pixel.
 *
 * The member is resolved by capability, not by a Shell version: 51 renamed `get_image()` to
 * `paint_to_bitmap()` and changed its return from `cairo_surface_t*` to `CoglBitmap*`. The 50-era
 * `get_image()` returns a `cairo_surface_t*`; when Mutter hands back NULL, GJS's marshaller trips
 * `CairoSurface::from_c_ptr`'s assertion and aborts the process with an "uncatchable exception"
 * that no `try`/`catch` can intercept. So when no safe probe member exists we call nothing and
 * answer "cannot tell": the caller keeps the window square but must not cache that as a verdict.
 * On a line where the member does exist the call is safe, so a throw is likewise "cannot tell".
 *
 * @param {object|null} shapedTexture - MetaShapedTexture, or null when unavailable
 * @returns {boolean|null} True when masking would change the screenshot, false when it would not,
 *   null when the readback cannot tell
 */
export function maskWouldChangeScreenshot(shapedTexture) {
    return probeWouldChangeScreenshot(shapedTexture, {
        clip: new Mtk.Rectangle({x: 0, y: 0, width: 1, height: 1}),
        format: Cogl.PixelFormat.RGBA_8888,
    });
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
