/**
 * Pure capability/routing decision behind `maskWouldChangeScreenshot`.
 *
 * The GI call itself (`Meta.ShapedTexture.paint_to_bitmap`, and the `Mtk.Rectangle` and
 * `Cogl.PixelFormat` arguments it needs) lives in `overviewMask.js`; this module holds the
 * decision so a unit spec can reach it without a Cogl typelib. The safety argument is in
 * `overviewMask.maskWouldChangeScreenshot`; the rules encoded here are that only a
 * capability-probed `paint_to_bitmap` is ever called, and that a readback that cannot answer
 * (`null`) is told apart from one that answers "no" (`false`).
 *
 * The `null`/`false` distinction is the whole point of the return type. `true` and `false` are
 * definitive answers a caller may cache for a shaped texture; `null` is "cannot tell", and a
 * caller that caches it can lock a window square forever on one transient failure. On a Shell
 * where the member is present the call is safe (a nullable `CoglBitmap*`, no process abort), so a
 * throw there is a readback that has not settled, not a verdict.
 *
 * @param {object|null} shapedTexture - MetaShapedTexture, or a stand-in in a spec
 * @param {object} args
 * @param {object} args.clip - A 1x1 clip rectangle
 * @param {number} args.format - The Cogl pixel format the bitmap is requested in
 * @returns {boolean|null} True when masking would change the screenshot, false when it would not,
 *   or null when the readback cannot tell (member absent, or the call threw)
 */
export function probeWouldChangeScreenshot(shapedTexture, {clip, format}) {
    // No safe probe member: `get_image()` cannot stand in (Shell 50's `cairo_surface_t*` trips
    // GJS's marshaller on a NULL and aborts the process with an "uncatchable exception"), so
    // call nothing and report "cannot tell".
    if (typeof shapedTexture?.paint_to_bitmap !== 'function')
        return null;

    try {
        // A nullable `CoglBitmap*`: a real bitmap means the direct-read path the mask would move,
        // NULL means one of Mutter's own early-outs, where masking changes nothing.
        const bitmap = shapedTexture.paint_to_bitmap(clip, format);
        return bitmap !== null && bitmap !== undefined;
    } catch {
        // The member exists, so the call cannot abort the process on this line; a throw is a
        // readback that has not settled. Report "cannot tell" rather than a verdict.
        return null;
    }
}
