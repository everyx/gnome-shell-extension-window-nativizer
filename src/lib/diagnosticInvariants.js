/**
 * Diagnostic invariants: the conditions a healthy decoration pass must satisfy, and the
 * edge-triggered latches that make a violation say so exactly once per episode.
 *
 * Each invariant is a pure predicate that returns a WARNING text or null, so what counts as a
 * violation is spec-able without a Clutter actor. The caller owns the latch state; the policy of
 * how many consecutive violating passes it takes to speak, and when agreement re-arms it, lives in
 * `evaluateInvariant` so every invariant shares one rule. The `[window-nativizer]` prefix is
 * stable, so one journal grep finds every line this module can emit.
 *
 * Health is silence: the e2e log audit treats an unexpected WARNING as a failure, which is the
 * point. An invariant whose healthy state cannot be proven quiet does not belong here.
 */

const PREFIX = '[window-nativizer]';

/**
 * Consecutive violating passes an invariant must see before it is allowed to speak.
 *
 * A geometry change and the actor allocation that follows it settle a pass apart: Mutter can
 * update the window's buffer rect and the window actor's allocation in separate steps within one
 * frame, so a single pass legitimately shows the two disagreeing while a resize is in flight. A
 * rule that spoke on one pass would warn on every resize, and a warning that fires on every resize
 * is worse than none. A genuine lagging read - the class these warnings exist to find - survives
 * the next pass: the manager debounces geometry signals by 50ms, so a pass is re-run after the
 * update settles while the one-pass skew cannot sustain itself. Two consecutive violating passes
 * separate the defect from the resize; agreement resets the count.
 */
export const INVARIANT_STRIKES = 2;

/** How far the buffer rect and the window actor allocation may differ before it is a defect. */
export const BUFFER_ACTOR_TOLERANCE = 0.5;

/**
 * How far the fallback phase mirror and the phase Mutter applied may differ.
 *
 * Both are exact arithmetic over the same layout coordinates, so a healthy pair agrees to float
 * residue. The observed failure is a whole physical pixel of misalignment (0.8 logical px at
 * 1.25, 0.75 at 1.3333); this tolerance is far below that and far above the residue.
 */
export const PHASE_ALIGNMENT_TOLERANCE = 0.05;

/**
 * The largest magnitude a real subpixel phase can have, in logical px.
 *
 * Mutter's `surface_container_apply_transform` shifts a layout coordinate to the nearest physical
 * grid line, so a phase is smaller than half a physical pixel - below `1 / scale` logical px, and
 * therefore strictly under one logical pixel at any monitor scale. A couple of logical pixels is a
 * generous ceiling. A value beyond it is not a subpixel phase: it is a layout position (or a
 * transform read from the wrong actor), and treating it as a phase turns a position into a
 * nonsensical "disagreement" of hundreds of pixels.
 */
export const PHASE_MAGNITUDE_BOUND = 2;

/**
 * @returns {{strikes: number, warned: boolean}} A latch that has not seen a violation
 */
export function freshInvariantState() {
    return {strikes: 0, warned: false};
}

/**
 * Advances one invariant's latch by one pass.
 *
 * A null warning is agreement: the latch re-arms, so the next episode can speak again. A warning
 * counts a strike and is returned only when the count reaches `strikes` and this episode has not
 * spoken yet; every later violating pass is silent until agreement, which is the "one WARNING per
 * episode" policy.
 *
 * @param {{strikes: number, warned: boolean}|null} state - The previous latch, or null/absent
 * @param {string|null} warning - This pass's warning text, or null when the pass is healthy
 * @param {number} [strikes=INVARIANT_STRIKES] - Consecutive violations required before speaking
 * @returns {{state: {strikes: number, warned: boolean}, message: string|null}} The next latch and
 *          the text to log this pass (null when this pass says nothing)
 */
export function evaluateInvariant(state, warning, strikes = INVARIANT_STRIKES) {
    if (!warning)
        return {state: freshInvariantState(), message: null};

    const previous = state ?? freshInvariantState();
    const next = {strikes: previous.strikes + 1, warned: previous.warned};
    if (next.strikes < strikes || next.warned)
        return {state: next, message: null};

    next.warned = true;
    return {state: next, message: warning};
}

/**
 * Names a window for a journal line: class first, then title, then pid, so a reader can find it.
 * The reading's `wmClass` is the class, and a pick reply's `windowTitle` is the title.
 *
 * @param {{wmClass?: string, title?: string, pid?: number}} reading
 * @returns {string} A label, never empty
 */
export function windowIdentityLabel({wmClass, title, pid} = {}) {
    const name = `${wmClass ?? ''}`.trim() || `${title ?? ''}`.trim();
    if (name)
        return `"${name}"`;
    if (typeof pid === 'number' && pid > 0)
        return `pid ${pid}`;
    return 'an unidentified window';
}

/**
 * Builds the WARNING text for a pass whose buffer rect and window actor allocation disagree.
 *
 * The manager assembles both in one pass (`readWindow`'s `bufferRect` and the live window actor),
 * and a healthy pass has them equal (`frameRect == bufferRect == windowActorAllocation`), so a
 * disagreement means one of the two reads lagged the other in that pass. That is not the
 * body-authority glitch `shadowBodyWarning` watches: there the authority itself moved and both
 * cuts followed it, so only this pair can say which read was behind. Both full rects are named
 * because the right edge is `x + width`: a narrower width with a fixed x is the inward shift, and
 * the position says whether the whole body moved instead.
 *
 * Only width and height are compared. The two origins can legitimately differ by the actor's
 * translation during an animation; the transient this watches changes the extent.
 *
 * @param {{x:number,y:number,width:number,height:number}|null} bufferRect - The window's buffer
 * @param {{x:number,y:number,width:number,height:number}|null} actorBox - The window actor's allocation
 * @param {string} [label] - Window identity from `windowIdentityLabel`
 * @returns {string|null} Warning text, or null when they agree within BUFFER_ACTOR_TOLERANCE
 */
export function bufferAllocationWarning(bufferRect, actorBox, label = windowIdentityLabel()) {
    if (!positiveRect(bufferRect) || !positiveRect(actorBox))
        return null;
    if (extentsAgree(bufferRect, actorBox, BUFFER_ACTOR_TOLERANCE))
        return null;
    return `${PREFIX} Window buffer ${rectSummary(bufferRect)} disagrees with the window actor ` +
        `allocation ${rectSummary(actorBox)} for ${label} beyond ${BUFFER_ACTOR_TOLERANCE}px`;
}

/**
 * Builds the WARNING text for a fallback pass whose mirror phase does not match Mutter's applied
 * phase.
 *
 * On the fallback path the clip folds the mirror (`getWindowSubpixelOffset`) into its geometry and
 * the shadow carries the same mirror as a translation, because the phase lives in a child
 * transform the offscreen FBO cannot keep. The applied read (`getAppliedSubpixelPhase`) is the
 * phase actually on the surface container's transform; when the two disagree, our cut is off
 * Mutter's real phase by that amount - the fractional-scale hairline. On the container path the
 * clip reads the applied phase back and the mirror is unused, so a disagreement there is not a
 * defect and the caller must not call this.
 *
 * A read may carry the `actor` it came from. When both reads name an actor and the two differ,
 * they are not the same quantity: the mirror folds the surface container's layout while the
 * applied read is that container's transform, so a mirror and an applied read taken from different
 * actors compare a phase against a position. That pair is unavailable and contributes nothing.
 *
 * A real phase is also bounded (`PHASE_MAGNITUDE_BOUND`). A read beyond it is a misread, not a
 * phase disagreement, so it is reported as unavailable and the raw value is left in the text - the
 * journal keeps the evidence, but nothing warns about a position as if it were a phase.
 *
 * @param {{x:number,y:number,actor?:object|null}|null} mirror - The reconstructed phase the
 *        fallback folds, tagged with the container it was read from
 * @param {{x:number,y:number,actor?:object|null}|null} applied - The phase read from the container
 *        transform, tagged with the same container
 * @param {string} [label] - Window identity from `windowIdentityLabel`
 * @returns {string|null} Warning text, or null when they agree, are unavailable, or were read
 *          from different actors
 */
export function phaseAlignmentWarning(mirror, applied, label = windowIdentityLabel()) {
    // A pair read from two actors is not comparable: the mirror's actor carried one layout and the
    // applied read subtracted another. Report unavailable rather than fabricate a phase.
    if (mirror?.actor !== undefined && applied?.actor !== undefined && mirror.actor !== applied.actor)
        return null;

    if (!finitePhase(mirror) || !finitePhase(applied))
        return null;

    // A read outside the subpixel range is a misread (a position, or a stale transform). Surface it
    // as unavailable with the raw numbers rather than as a phase disagreement.
    if (!boundedPhase(mirror) || !boundedPhase(applied)) {
        return `${PREFIX} Fallback subpixel phase unavailable for ${label}: mirror ` +
            `${phaseSummary(mirror)} applied ${phaseSummary(applied)} exceeds ` +
            `${PHASE_MAGNITUDE_BOUND}px`;
    }

    if (Math.abs(mirror.x - applied.x) <= PHASE_ALIGNMENT_TOLERANCE &&
        Math.abs(mirror.y - applied.y) <= PHASE_ALIGNMENT_TOLERANCE)
        return null;
    return `${PREFIX} Fallback subpixel phase ${phaseSummary(mirror)} disagrees with the phase ` +
        `Mutter applied ${phaseSummary(applied)} for ${label} beyond ${PHASE_ALIGNMENT_TOLERANCE}px`;
}

/**
 * Builds the WARNING text for an overview pass that could not install the mask although the window
 * was ready for one.
 *
 * The overview has two ways a pass can leave a window square: the "not ready yet" gates (no
 * buffer, no paint-able actor) are a legitimate deferral with nothing cached, and the capability
 * or geometry refusals (no preview container, no shaped-texture context, a non-positive size, a
 * builder that returned nothing) are the "square in the overview" defect. The caller separates
 * them; this names the second so the journal says why the preview stayed square.
 *
 * @param {string} reason - Which gate refused, in the caller's words
 * @param {string} [label] - Window identity from `windowIdentityLabel`
 * @returns {string} Warning text
 */
export function overviewMaskRefusalWarning(reason, label = windowIdentityLabel()) {
    return `${PREFIX} Overview mask not installed for ${label} although the window was ready: ${reason}`;
}

/**
 * @param {{width:number,height:number}|null} rect
 * @returns {boolean}
 */
function positiveRect(rect) {
    return Boolean(rect) &&
        Number.isFinite(rect.width) && Number.isFinite(rect.height) &&
        rect.width > 0 && rect.height > 0;
}

/**
 * @param {{width:number,height:number}} a
 * @param {{width:number,height:number}} b
 * @param {number} tolerance
 * @returns {boolean}
 */
function extentsAgree(a, b, tolerance) {
    return Math.abs(a.width - b.width) <= tolerance &&
        Math.abs(a.height - b.height) <= tolerance;
}

/**
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @returns {string}
 */
function rectSummary(rect) {
    return `${rect.width}x${rect.height} at (${rect.x ?? 0},${rect.y ?? 0})`;
}

/**
 * @param {{x:number,y:number}|null} phase
 * @returns {boolean}
 */
function finitePhase(phase) {
    return Boolean(phase) && Number.isFinite(phase.x) && Number.isFinite(phase.y);
}

/**
 * @param {{x:number,y:number}|null} phase
 * @returns {boolean} Whether the phase is within the subpixel range on both axes
 */
function boundedPhase(phase) {
    return finitePhase(phase) &&
        Math.abs(phase.x) <= PHASE_MAGNITUDE_BOUND &&
        Math.abs(phase.y) <= PHASE_MAGNITUDE_BOUND;
}

/**
 * @param {{x:number,y:number}} phase
 * @returns {string}
 */
function phaseSummary(phase) {
    return `(${fmt2(phase.x)},${fmt2(phase.y)})`;
}

/**
 * @param {number} value
 * @returns {string} The value with two decimal places, so a sub-pixel phase is visible
 */
function fmt2(value) {
    return Number(value).toFixed(2);
}
