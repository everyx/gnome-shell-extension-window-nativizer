/**
 * Rect and inset comparisons in one place: a rect is four loose numbers everywhere else, so every
 * caller that compared two of them wrote the field list again. A missing side never equals anything,
 * which is what lets `!rectEquals(a, b)` read as "it moved".
 */

/** Whether two rects cover the same box. */
export function rectEquals(a, b) {
    return Boolean(a && b) && a.x === b.x && a.y === b.y &&
        a.width === b.width && a.height === b.height;
}

/** Whether two sizes agree, origin aside. */
export function sameSize(a, b) {
    return Boolean(a && b) && a.width === b.width && a.height === b.height;
}

/** Whether `outer` covers `inner` on all four sides, edges inclusive. */
export function rectContains(outer, inner) {
    return Boolean(outer && inner) && outer.x <= inner.x && outer.y <= inner.y &&
        outer.x + outer.width >= inner.x + inner.width &&
        outer.y + outer.height >= inner.y + inner.height;
}

/** Whether two layout rects overlap with positive area, matching `mtk_rectangle_intersect`. */
export function rectanglesOverlap(a, b) {
    if (!a || !b)
        return false;
    const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return width > 0 && height > 0;
}

/** Whether any side of two inset sets differs by `tolerance` or more; a missing side counts as 0. */
export function insetsMoved(a, b, tolerance = 1) {
    if (!a || !b)
        return false;
    return Math.abs((a.left ?? 0) - (b.left ?? 0)) >= tolerance ||
        Math.abs((a.top ?? 0) - (b.top ?? 0)) >= tolerance ||
        Math.abs((a.right ?? 0) - (b.right ?? 0)) >= tolerance ||
        Math.abs((a.bottom ?? 0) - (b.bottom ?? 0)) >= tolerance;
}
