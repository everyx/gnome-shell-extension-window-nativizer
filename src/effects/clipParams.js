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
 * How far the clip target's read and the window actor may differ before the body is unsettled.
 *
 * The two reads are the same rectangle in health, but they are not always written in the same
 * step: a Wayland surface container's allocation can trail the window actor's for a pass around a
 * focus hand-off. At a fractional monitor scale the container's logical extent is `buffer / scale`
 * while the actor's allocation is an integer, so a sub-pixel difference between the two is normal
 * by construction and must not be read as movement. One logical pixel sits above that residue and
 * below the whole-pixel defects this exists to separate (the observed one was 2px), so it is the
 * threshold both the settle and the body-authority warning use.
 */
export const BODY_SETTLE_TOLERANCE = 1.0;

/**
 * Whether the window's own size moved since the previous pass, i.e. a resize is in flight.
 *
 * The window's frame rect (else its buffer rect) is an integer rectangle, so any difference is a
 * whole logical pixel and `!==` draws the same boundary a one-pixel tolerance would. The read is
 * independent of the two body reads: during an interactive resize the window actor takes its new
 * size a frame or two before the surface container does, and this predicate is what tells that lag
 * apart from a body that moved on its own (a focus hand-off leaves the window's own size standing).
 * An unknown size on either side is not a resize: with no previous pass there is nothing to
 * compare, and a failed read is not evidence of movement.
 *
 * @param {{width:number,height:number}|null|undefined} windowSize - The window's own size this pass
 * @param {{width:number,height:number}|null|undefined} previousWindowSize - The previous pass's
 * @returns {boolean}
 */
export function windowResizedSince(windowSize, previousWindowSize) {
    if (!isPaintableFrame(windowSize) || !isPaintableFrame(previousWindowSize))
        return false;
    return windowSize.width !== previousWindowSize.width ||
        windowSize.height !== previousWindowSize.height;
}

/**
 * The body authority for a pass: which of the two reads the clip's cut and the shadow's cast must
 * follow.
 *
 * In steady state the clip target's read wins - on a Wayland window that is the surface container,
 * the client's real surface - and the window actor is only the documented fallback when the target
 * read is unusable (`resolveClipSize`). While a resize is in flight the preference flips: the
 * window actor takes its new size first and the container's allocation trails it by a frame or
 * two, so the actor's read is the fresh one and the cut must track the frame the user is dragging
 * rather than the older, smaller box. The unpreferred read is still the fallback when the
 * preferred one has no extent.
 *
 * @param {{width:number,height:number}|null|undefined} targetSize - The clip target's own read
 * @param {{width:number,height:number}|null|undefined} windowActorSize - The window actor's read
 * @param {boolean} resizeInFlight - Whether the window's own size moved since the previous pass
 * @returns {{width:number,height:number}|null}
 */
export function resolveBodyAuthority(targetSize, windowActorSize, resizeInFlight) {
    if (!resizeInFlight)
        return resolveClipSize(targetSize, windowActorSize);
    if (isPaintableFrame(windowActorSize))
        return {width: windowActorSize.width, height: windowActorSize.height};
    if (isPaintableFrame(targetSize))
        return {width: targetSize.width, height: targetSize.height};
    return null;
}

/**
 * The body the clip and the shadow should act on, holding the last good one while the two reads
 * that name it disagree **or** while the body moves on its own between passes.
 *
 * The authority itself is chosen by `resolveBodyAuthority`: the clip target's read (the surface
 * container) in steady state, the window actor's read while a resize is in flight, because then
 * the actor takes its new size before the container's allocation follows. `resolveClipSize` then
 * answers which usable read that preference lands on; it does not ask whether the two reads agree,
 * nor whether the body has moved since the last pass. Two cases are held:
 *
 *   - within a pass, the target's read and the window actor's read differ by more than `tolerance`,
 *     so at least one is stale and this pass alone cannot say which - unless a resize is in
 *     flight, which already says the window actor is the fresh one and makes the lagging pair
 *     expected rather than unsettled;
 *   - between passes, the body authority moved by `tolerance` or more since the previous pass's
 *     authority while the window's own size (`windowSize`) did not. A focus hand-off can leave the
 *     target and the window actor trailing together, so the pair comparison sees agreement while
 *     the cut is a whole pixel or two off; the window's own size is the independent authority that
 *     separates a moving body from a resizing window. Comparing the fresh authority with the last
 *     pass's (not with the held body) is what makes the hold last one pass: once the authority
 *     stops moving it is acted on, even though the held body still differs from it.
 *
 * In both cases the fresh authority is returned (so the body-authority warning still names it) but
 * the *acted-on* body stays the previous settled one, keeping the clip's cut and the shadow's cast
 * on identical geometry. Neither hold can latch: every pass re-reads the live quantities.
 *
 * A degenerate target read is the documented fallback, not a disagreement: `resolveClipSize`
 * already falls back to the window actor there, and that verdict is stable across paints.
 *
 * @param {{width:number,height:number}|null|undefined} targetSize - The clip target's own read
 * @param {{width:number,height:number}|null|undefined} windowActorSize - The window actor's read
 * @param {{width:number,height:number}|null} [previousBody=null] - The last settled body
 * @param {{width:number,height:number}|null} [previousAuthority=null] - The previous pass's body
 *        authority (the fresh read, whether or not it was acted on)
 * @param {{width:number,height:number}|null} [windowSize=null] - The window's own size this pass
 * @param {{width:number,height:number}|null} [previousWindowSize=null] - The previous pass's
 * @param {number} [tolerance=BODY_SETTLE_TOLERANCE]
 * @returns {{authority: {width:number,height:number}|null, body: {width:number,height:number}|null,
 *   unsettled: boolean}}
 */
export function settleClipBody(targetSize, windowActorSize, previousBody = null,
    previousAuthority = null, windowSize = null, previousWindowSize = null,
    tolerance = BODY_SETTLE_TOLERANCE, insets = null, declared = null) {
    const windowResized = windowResizedSince(windowSize, previousWindowSize);
    const authority = resolveBodyAuthority(targetSize, windowActorSize, windowResized);
    if (!authority)
        return {authority: null, body: null, unsettled: false};
    // The fallback path is not a disagreement: a target with no extent is handled by the window
    // actor by construction, and the actor is the authority for whether the window has a body.
    if (!isPaintableFrame(targetSize) || !isPaintableFrame(windowActorSize))
        return {authority, body: authority, unsettled: false};
    // Strictly greater: a difference of exactly the tolerance is agreement, which is also what the
    // warning's own comparison says (`|delta| <= tolerance` is silent there). The two must read the
    // same boundary or a pair differing by exactly it would warn while still being acted on.
    // Like-for-like, not raw-reads-to-raw-reads. The target is the Wayland surface container, whose
    // box carries the client's declared decoration margins (the journal showed a 22 px-per-side
    // window reading 44 px wider than its actor, and another with the origin shifted by (69,65) ->
    // (87,67)); the window actor's box is the frame without them. So both sides are reduced to the
    // body each implies before comparing: the target by the insets the clip cuts with, the actor by
    // only the part of those insets that is *our* safe trim (the declared ring is already outside
    // the actor, the flat safe inset is inside it). Comparing the raw reads reported a permanent
    // disagreement on every window that declares a ring - which is a false alarm, and in the
    // steady state it froze the body.
    const padWidth = insets ? (insets.left ?? 0) + (insets.right ?? 0) : 0;
    const padHeight = insets ? (insets.top ?? 0) + (insets.bottom ?? 0) : 0;
    const declaredWidth = declared ? (declared.left ?? 0) + (declared.right ?? 0) : 0;
    const declaredHeight = declared ? (declared.top ?? 0) + (declared.bottom ?? 0) : 0;
    const pairDisagrees =
        Math.abs(targetSize.width - padWidth - (windowActorSize.width - (padWidth - declaredWidth))) > tolerance ||
        Math.abs(targetSize.height - padHeight - (windowActorSize.height - (padHeight - declaredHeight))) > tolerance;
    // Between passes the body's normal residue (`buffer / scale` on a fractional monitor) is below
    // the tolerance and a whole-pixel move is the defect, so this boundary is inclusive.
    const bodyMoved = isPaintableFrame(previousAuthority) &&
        (Math.abs(authority.width - previousAuthority.width) >= tolerance ||
         Math.abs(authority.height - previousAuthority.height) >= tolerance);
    // The window's own size is read independently; when it moved too the body is genuinely new,
    // and an unknown window size counts as moved. That is the one asymmetry here, and it is
    // deliberate: `windowResizedSince` above reads the same unknown as "not a resize" because there
    // it only picks which read is the authority, where the steady-state preference is the safe
    // answer. Here the unknown decides whether to veto the hold, and vetoing freezes the cut for a
    // pass. An unreadable window size is an interactive drag - the one case where a frame of lag is
    // most visible - so the unknown is spent on acting. The accepted cost is the focus hand-off
    // this hold was written for: with no window size to compare, a body that moved while the window
    // stood still is followed for that pass instead of held.
    const windowKnown = isPaintableFrame(windowSize) && isPaintableFrame(previousWindowSize);
    const windowMoved = !windowKnown ||
        Math.abs(windowSize.width - previousWindowSize.width) >= tolerance ||
        Math.abs(windowSize.height - previousWindowSize.height) >= tolerance;

    // A resize in flight already explains a pair disagreement: the container trails the actor, so
    // the actor is trusted and there is nothing to hold. In steady state the same disagreement is
    // still unresolved. The between-pass hold is unchanged: `windowMoved` vetoes it as before.
    const unsettled = (pairDisagrees && !windowResized) || (bodyMoved && !windowMoved);
    if (!unsettled)
        return {authority, body: authority, unsettled: false};
    return {
        authority,
        body: isPaintableFrame(previousBody) ? {...previousBody} : authority,
        unsettled: true,
    };
}

/**
 * The body one paint (or the shadow's matching relayout) acts on, resolved from the live actor
 * reads and the pass's plan.
 *
 * The settle rules are the ones `settleClipBody` has always applied; what this adds is their
 * clock. The two body reads - the clip target's and the window actor's - are taken live at
 * paint, so the frame the shader uses is the frame the compositor is drawing that frame, rather
 * than the frame frozen at the last debounced pass. The window's own size is read live too
 * (`windowSize`), because it is what separates a resize from a body that moved on its own, and a
 * resize must be seen on the frame it starts, not 50 ms later; only its previous value
 * (`plan.previousWindowSize`), the last settled body and the previous authority stay on the pass
 * clock. The two clocks are deliberate: the geometry follows the frame, the hold keeps its pass
 * boundary.
 *
 * @param {{width:number,height:number}|null|undefined} targetSize - The clip target's live read
 * @param {{width:number,height:number}|null|undefined} windowActorSize - The window actor's live read
 * @param {{width:number,height:number}|null} windowSize - The window's own size, live at paint
 * @param {{previousBody?:object|null, previousAuthority?:object|null,
 *   previousWindowSize?:object|null, tolerance?:number}|null} [plan] - The pass plan; a null plan
 *   (before the first pass) behaves as an unknown previous read
 * @returns {{authority: {width:number,height:number}|null, body: {width:number,height:number}|null,
 *   unsettled: boolean}}
 */
export function resolvePaintBody(targetSize, windowActorSize, windowSize, plan = null) {
    return settleClipBody(targetSize, windowActorSize,
        plan?.previousBody ?? null, plan?.previousAuthority ?? null,
        windowSize, plan?.previousWindowSize ?? null,
        plan?.tolerance ?? BODY_SETTLE_TOLERANCE,
        plan?.insets ?? null, plan?.declared ?? null);
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
