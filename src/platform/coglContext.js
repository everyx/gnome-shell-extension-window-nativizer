/**
 * Resolves CoglContext for shadow texture baking from paintContext framebuffer (GNOME 50+).
 *
 * @param paintContext - ClutterPaintContext passed to vfunc_paint_node
 * @returns A context to bake in, or null when there is none
 */
export function coglContextForBake(paintContext) {
    return paintContext?.get_framebuffer?.()?.get_context?.() ?? null;
}
