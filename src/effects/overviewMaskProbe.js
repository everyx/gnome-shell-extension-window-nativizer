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
 * The `null`/`false` distinction is the whole point of the return type, and it is the caller's job
 * to keep the answer honest: the probe cannot see whether the shaped texture has a buffer or
 * whether we have already touched it. `true` is a real bitmap: the direct-read path the mask
 * would move, and a refusal final for the shaped texture's life. `false` is a NULL, and Mutter
 * returns NULL for four causes it cannot tell apart - no buffer yet, already offscreen (a set
 * mask, an unreadable plane, a viewport, a non-normal transform), a zero destination size, or a
 * clip that misses it (see `overviewMask.maskWouldChangeScreenshot`). A caller may take `false` as
 * "masking is safe" only from a texture that has a buffer and that we have not modified, and then
 * it is final; a verdict taken after our own mask is set would only report that mask. `null` is
 * "cannot tell": the member is missing, or the readback threw, and a caller that caches it can
 * lock a window square forever on one transient failure. On a Shell where the member is present
 * the call is safe (a nullable `CoglBitmap*`, no process abort), so a throw there is a readback
 * that has not settled, not a verdict.
 *
 * @param {object|null} shapedTexture - MetaShapedTexture, or a stand-in in a spec
 * @param {object} args
 * @param {object} args.clip - A 1x1 clip rectangle
 * @param {number} args.format - The Cogl pixel format the bitmap is requested in
 * @returns {boolean|null} True when masking would change the screenshot, false when a NULL says it
 *   would not (a verdict only on a buffered texture the caller has not modified), or null when the
 *   readback cannot tell (member absent, or the call threw)
 */
export function probeWouldChangeScreenshot(shapedTexture, {clip, format}) {
    // No safe probe member: `get_image()` cannot stand in (Shell 50's `cairo_surface_t*` trips
    // GJS's marshaller on a NULL and aborts the process with an "uncatchable exception"), so
    // call nothing and report "cannot tell".
    if (typeof shapedTexture?.paint_to_bitmap !== 'function')
        return null;

    try {
        // A nullable `CoglBitmap*`: a real bitmap means the direct-read path the mask would move,
        // NULL means one of Mutter's own early-outs. The caller already excluded "no buffer yet"
        // and its own mask, so a false here is a stable, buffered answer - but only the caller
        // knows that, and only on a texture it has not touched.
        const bitmap = shapedTexture.paint_to_bitmap(clip, format);
        return bitmap !== null && bitmap !== undefined;
    } catch {
        // The member exists, so the call cannot abort the process on this line; a throw is a
        // readback that has not settled. Report "cannot tell" rather than a verdict.
        return null;
    }
}
