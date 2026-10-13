/**
 * Pure uniform-upload decisions for RoundedClipEffect.
 *
 * `setParams()` and `vfunc_paint_target()` decide what to send to the GPU by diffing the
 * incoming values against the cached ones. That diff is arithmetic, but it lived inside a
 * Cogl/Clutter class, so no unit test could reach it. It lives here now: the effect hands
 * over the previous and next values, this module decides what changed, and the effect only
 * performs the uploads.
 */

/**
 * Normalizes an outline to the shader's vec4. `null` means "no outline", which the shader
 * reads as alpha 0.
 * @param {{color:number[],alpha:number}|null} outline
 * @returns {number[]}
 */
export function outlineVector(outline) {
    return outline
        ? [
            outline.color[0] > 1 ? outline.color[0] / 255 : outline.color[0],
            outline.color[1] > 1 ? outline.color[1] / 255 : outline.color[1],
            outline.color[2] > 1 ? outline.color[2] / 255 : outline.color[2],
            outline.alpha,
        ]
        : [0, 0, 0, 0];
}

/**
 * Whether a derived body frame can be painted without erasing the actor.
 *
 * A frame with a non-positive extent has no body. Compositing it is not a no-op: the clip shader's
 * `inSquare` is 0 everywhere, so the offscreen effect draws nothing and the window reads as fully
 * transparent while its sibling shadow actor keeps drawing. The caller suspends the clip instead.
 *
 * @param {{width:number,height:number}|null|undefined} frame
 * @returns {boolean}
 */
export function isPaintableFrame(frame) {
    return Boolean(frame) && frame.width > 0 && frame.height > 0;
}

/**
 * The size the clip derives its frame from, or null when there is no body to paint.
 *
 * The target's own allocation is preferred: normally it is the buffer. A Wayland surface
 * container's allocation can read 0 while its surface child still paints at full size (a buffer
 * swap while opening, a layout that has not settled), so a non-positive target read falls back to
 * the window actor - the authority for whether the window has a body. Only when the window actor
 * has no extent either is the target genuinely degenerate.
 *
 * @param {{width:number,height:number}|null|undefined} targetSize - The clip target's own read
 * @param {{width:number,height:number}|null|undefined} windowActorSize - The window actor's read
 * @returns {{width:number,height:number}|null} Paint-able size, or null to suspend
 */
export function resolveClipSize(targetSize, windowActorSize) {
    if (isPaintableFrame(targetSize))
        return {width: targetSize.width, height: targetSize.height};
    if (isPaintableFrame(windowActorSize))
        return {width: windowActorSize.width, height: windowActorSize.height};
    return null;
}

/**
 * @param {{left:number,top:number,right:number,bottom:number}|null} a
 * @param {{left:number,top:number,right:number,bottom:number}|null} b
 * @returns {boolean}
 */
function sameInsets(a, b) {
    return Boolean(a) && Boolean(b) &&
        a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

/**
 * @param {number[]} a
 * @param {number[]} b
 * @returns {boolean}
 */
function sameVector(a, b) {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/**
 * Diffs the styling decisions `setParams()` stores and uploads.
 *
 * `prev` is the effect's cached state, or null when nothing is cached yet. Its `outline` is
 * the stored normalized vec4; `next.outline` is the raw `{color, alpha}` or null. The
 * returned `frame: true` is not an upload: it is the invalidation the caller applies to the
 * cached frame, because insets moved the body that the next paint recomputes from.
 *
 * @param {object|null} prev - {insets, radius, outline, erase, clearStroke, scale}
 * @param {object} next - {insets, radius, outline, erase, clearStroke, scale}
 * @returns {{changed:boolean, scale?:number, radius?:number, outline?:number[],
 *   erase?:boolean, clearStroke?:boolean, frame?:true}}
 */
export function clipParamChanges(prev, next) {
    const scaleValid = typeof next.scale === 'number' && next.scale > 0 && Number.isFinite(next.scale);
    const scaleChanged = scaleValid && (!prev || prev.scale !== next.scale);

    const insetsChanged = !prev || !sameInsets(prev.insets, next.insets);
    const radiusChanged = !prev || prev.radius !== next.radius;

    const nextOutline = outlineVector(next.outline);
    const outlineChanged = !prev || !prev.outline || !sameVector(prev.outline, nextOutline);

    const nextErase = Boolean(next.erase);
    const nextClearStroke = Boolean(next.clearStroke);
    const eraseChanged = !prev || prev.erase !== nextErase;
    const clearStrokeChanged = !prev || prev.clearStroke !== nextClearStroke;

    const changed = insetsChanged || radiusChanged || outlineChanged ||
        eraseChanged || clearStrokeChanged || scaleChanged;

    return {
        changed,
        scale: scaleChanged ? next.scale : undefined,
        radius: radiusChanged ? next.radius : undefined,
        outline: outlineChanged ? nextOutline : undefined,
        erase: eraseChanged ? nextErase : undefined,
        clearStroke: clearStrokeChanged ? nextClearStroke : undefined,
        frame: insetsChanged || undefined,
    };
}

/**
 * Diffs the paint-time geometry caches.
 *
 * The effect compares the actor's live size and the frame it snapped from it against the
 * last values it uploaded. `next.frame` is reused from the snap, not copied.
 *
 * @param {object|null} prev - {scale, width, height, frame:{x,y,width,height}}
 * @param {object} next - {scale, width, height, frame}
 * @returns {{scale?:number, size?:number[], frame?:number[]}}
 */
export function clipGeometryChanges(prev, next) {
    const changes = {};
    if (!prev || prev.scale !== next.scale)
        changes.scale = next.scale;
    if (!prev || prev.width !== next.width || prev.height !== next.height)
        changes.size = [next.width, next.height];
    const frame = next.frame;
    const previous = prev?.frame;
    if (!previous || previous.x !== frame.x || previous.y !== frame.y ||
        previous.width !== frame.width || previous.height !== frame.height)
        changes.frame = [frame.x, frame.y, frame.width, frame.height];
    return changes;
}
