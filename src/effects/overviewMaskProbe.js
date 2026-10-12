/**
 * Pure capability/routing decision behind `maskWouldChangeScreenshot`.
 *
 * The GI call itself (`Meta.ShapedTexture.paint_to_bitmap`, and the `Mtk.Rectangle` and
 * `Cogl.PixelFormat` arguments it needs) lives in `overviewMask.js`; this module holds the
 * decision so a unit spec can reach it without a Cogl typelib. The safety argument is in
 * `overviewMask.maskWouldChangeScreenshot`; the one rule encoded here is that only a
 * capability-probed `paint_to_bitmap` is ever called.
 *
 * @param {object|null} shapedTexture - MetaShapedTexture, or a stand-in in a spec
 * @param {object} args
 * @param {object} args.clip - A 1x1 clip rectangle
 * @param {number} args.format - The Cogl pixel format the bitmap is requested in
 * @returns {boolean} True when masking this window would change its desktop screenshot
 */
export function probeWouldChangeScreenshot(shapedTexture, {clip, format}) {
    try {
        if (typeof shapedTexture?.paint_to_bitmap === 'function')
            return Boolean(shapedTexture.paint_to_bitmap(clip, format));
    } catch {
        // A texture that cannot be probed is not one to take the risk on.
        return true;
    }

    // No safe probe member. Shell 50's `get_image()` cannot stand in: when Mutter hands it a NULL
    // `cairo_surface_t*`, GJS's marshaller trips `CairoSurface::from_c_ptr`'s assertion and aborts
    // the process with an "uncatchable exception" that no `try`/`catch` can intercept. Without a
    // member that returns a nullable bitmap, the answer is "unreadable ⇒ unsafe ⇒ do not mask".
    return true;
}
