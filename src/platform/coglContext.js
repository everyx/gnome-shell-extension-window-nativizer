/** The framebuffer's context, or null when the paint context offers none (GNOME 50+ only). */
export function coglContextForBake(paintContext) {
    return paintContext?.get_framebuffer?.()?.get_context?.() ?? null;
}
