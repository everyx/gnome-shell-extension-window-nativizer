let giDeps = null;

async function loadGiDeps() {
    if (giDeps)
        return giDeps;
    try {
        const [{default: Gio}, {default: Shell}] = await Promise.all([
            import('gi://Gio'),
            import('gi://Shell'),
        ]);
        if (typeof Shell?.Screenshot?.composite_to_stream !== 'function')
            return null;
        giDeps = {Gio, Shell};
        return giDeps;
    } catch {
        return null;
    }
}

/** Alpha of a one-pixel composite; a pixbuf without alpha is opaque, not unknown. */
export function pixbufAlpha(pixbuf) {
    if (!pixbuf)
        return null;
    if (!pixbuf.get_has_alpha?.())
        return 255;
    const channels = pixbuf.get_n_channels();
    const pixels = pixbuf.get_pixels();
    return channels >= 4 && pixels.length >= 4 ? pixels[3] : null;
}

const CORNER_INSET = 1;

/**
 * Reads 1px alpha at the four corners and the centre of `actor`.
 *
 * One composite per point: `composite_to_stream` takes a rect and returns the pixbuf it rendered,
 * and its `scale` is the surface's device scale - it scales drawing, not the output, so a whole
 * window in one call would be a full-size pixbuf rather than a cheaper one.
 */
export async function readActorCornerAlpha(actor, frameRect, cancellable = null) {
    if (!actor || typeof actor.paint_to_content !== 'function' ||
        !frameRect || frameRect.width < 32 || frameRect.height < 32)
        return null;

    // GNOME Shell animates new windows with scale + opacity around the centre; a mid-animation
    // paint shrinks the body away from the actor's corners and reads alpha 0.
    if ((actor.opacity ?? 255) < 255 ||
        Math.abs((actor.scale_x ?? 1) - 1) > 1e-3 ||
        Math.abs((actor.scale_y ?? 1) - 1) > 1e-3)
        return null;

    const deps = await loadGiDeps();
    if (!deps || cancellable?.is_cancelled())
        return null;

    const texture = actor.paint_to_content(null)?.get_texture?.() ?? null;
    const texW = texture?.get_width?.() ?? 0;
    const texH = texture?.get_height?.() ?? 0;
    if (texW < 32 || texH < 32)
        return null;

    const points = [
        [CORNER_INSET, CORNER_INSET],
        [texW - 1 - CORNER_INSET, CORNER_INSET],
        [CORNER_INSET, texH - 1 - CORNER_INSET],
        [texW - 1 - CORNER_INSET, texH - 1 - CORNER_INSET],
        [Math.floor(texW / 2), Math.floor(texH / 2)],
    ];
    const alphas = await Promise.all(
        points.map(([px, py]) => readPixelAlpha(deps, texture, px, py)));
    if (cancellable?.is_cancelled())
        return null;
    if (alphas.some(alpha => alpha === null))
        return null;
    return {corners: alphas.slice(0, 4), interior: alphas[4]};
}

/** One point, one composite; the stream is the call's required sink and its contents go unread. */
async function readPixelAlpha(deps, texture, x, y) {
    const {Gio, Shell} = deps;
    const stream = Gio.MemoryOutputStream.new_resizable();
    try {
        const pixbuf = await Shell.Screenshot.composite_to_stream(
            texture, x, y, 1, 1, 1, null, 0, 0, 1, stream);
        return pixbufAlpha(pixbuf);
    } catch {
        return null;
    } finally {
        try {
            if (!stream.is_closed())
                stream.close(null);
        } catch {
            // Stream may already be closed or cancelled during teardown.
        }
    }
}
