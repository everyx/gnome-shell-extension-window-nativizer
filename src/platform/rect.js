/**
 * Rect and inset comparisons in one place: a rect is four loose numbers everywhere else, so every
 * caller that compared two of them wrote the field list again. A missing side never equals anything,
 * which is what lets `!rectEquals(a, b)` read as "it moved".
 */

/** Whether two rects cover the same box. */
export function rectEquals(first, second) {
    return Boolean(first && second) && first.x === second.x && first.y === second.y &&
        first.width === second.width && first.height === second.height;
}

/** Whether two sizes agree, origin aside. */
export function sameSize(first, second) {
    return Boolean(first && second) && first.width === second.width && first.height === second.height;
}

/** Whether `outer` covers `inner` on all four sides, edges inclusive. */
export function rectContains(outer, inner) {
    return Boolean(outer && inner) && outer.x <= inner.x && outer.y <= inner.y &&
        outer.x + outer.width >= inner.x + inner.width &&
        outer.y + outer.height >= inner.y + inner.height;
}

/** Whether two layout rects overlap with positive area, matching `mtk_rectangle_intersect`. */
export function rectanglesOverlap(first, second) {
    if (!first || !second)
        return false;
    const width = Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x);
    const height = Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y);
    return width > 0 && height > 0;
}

/** Whether two inset sets name the same four sides; a missing side counts as 0. */
export function insetsEqual(first, second) {
    if (!first || !second)
        return false;
    return (first.left ?? 0) === (second.left ?? 0) &&
        (first.top ?? 0) === (second.top ?? 0) &&
        (first.right ?? 0) === (second.right ?? 0) &&
        (first.bottom ?? 0) === (second.bottom ?? 0);
}

/** Whether any side of two inset sets differs by `tolerance` or more; a missing side counts as 0. */
export function insetsMoved(first, second, tolerance = 1) {
    if (!first || !second)
        return false;
    return Math.abs((first.left ?? 0) - (second.left ?? 0)) >= tolerance ||
        Math.abs((first.top ?? 0) - (second.top ?? 0)) >= tolerance ||
        Math.abs((first.right ?? 0) - (second.right ?? 0)) >= tolerance ||
        Math.abs((first.bottom ?? 0) - (second.bottom ?? 0)) >= tolerance;
}
