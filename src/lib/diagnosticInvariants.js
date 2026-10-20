/**
 * Diagnostic invariants: the conditions a healthy decoration pass must satisfy, and the edge-triggered
 * latches that make a violation speak once per episode. Each invariant is a pure predicate returning a
 * WARNING text or null; `evaluateInvariant` owns the strike policy every invariant shares, and health is
 * silence.
 */

import {OFFSCREEN_BOX_TOLERANCE} from './offscreenBox.js';

const PREFIX = '[window-nativizer]';

/**
 * How far the derived offscreen box's device extent and the FBO Clutter allocated may differ: one
 * device pixel, the subpixel phase an edge may carry. The geometry module owns the number, because
 * it is also what tells an FBO a candidate scale explains from one none does.
 */
export {OFFSCREEN_BOX_TOLERANCE};

/**
 * Consecutive violating passes an invariant must see before it is allowed to speak: a geometry
 * change and the actor allocation that follows settle a pass apart, so one pass would warn on
 * every resize. Agreement resets the count.
 */
export const INVARIANT_STRIKES = 2;

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
 * The largest magnitude a real subpixel phase can have, in logical px: Mutter's transform snaps a
 * layout coordinate to the nearest physical grid line, so a real phase is below `1 / scale` logical
 * px. Beyond this bound a value is a position or a stale transform, not a phase.
 */
export const PHASE_MAGNITUDE_BOUND = 2;

/**
 * @returns A latch that has not seen a violation
 */
export function freshInvariantState() {
    return {strikes: 0, warned: false};
}

/**
 * Advances one invariant's latch by one pass. A null warning is agreement and re-arms the latch; a
 * warning counts a strike and is returned only once the count reaches `strikes` and this episode has
 * not spoken yet. Every later violating pass stays silent until agreement - one WARNING per episode.
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
 * @returns A label, never empty
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
 * Builds the WARNING text for a pass whose buffer rect and window actor allocation disagree - the
 * pair that names which of the two reads lagged, where the body-authority warning cannot. Only the
 * extents are compared: origins may differ legitimately by an animation's translation. Null within
 * `BUFFER_ACTOR_TOLERANCE`, or when either rect is degenerate.
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
 * phase. Unavailable - and no warning - when the two reads came from different actors (a phase
 * against a position) or when either read exceeds `PHASE_MAGNITUDE_BOUND`; the raw values stay in
 * the text. Call only on the fallback path.
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
 * was ready for one - the capability or geometry refusals, not the "not ready yet" deferrals, which
 * the caller separates out. Names the gate so the journal says why the preview stayed square.
 */
export function overviewMaskRefusalWarning(reason, label = windowIdentityLabel()) {
    return `${PREFIX} Overview mask not installed for ${label} although the window was ready: ${reason}`;
}

/**
 * Builds the WARNING text for a shadow bake whose framebuffer could not be allocated. The bake
 * retries on the next paint, so a persistent shortage is one line per episode rather than one per
 * frame.
 */
export function shadowBakeFailureWarning(buffer) {
    return `${PREFIX} Could not allocate a ${buffer}x${buffer} shadow buffer`;
}

/**
 * Builds the WARNING text for a paint whose derived offscreen box does not span the FBO Clutter
 * allocated, both extents in device px. Null when either extent is unknown or they agree within
 * `OFFSCREEN_BOX_TOLERANCE`.
 */
export function offscreenBoxWarning(derived, target) {
    if (!finiteExtent(derived) || !finiteExtent(target))
        return null;
    // Whole device pixels on both sides: rounding keeps float residue from reading as a part, and
    // the tolerance is the subpixel phase an edge may carry.
    const dx = Math.abs(Math.round(derived.width) - Math.round(target.width));
    const dy = Math.abs(Math.round(derived.height) - Math.round(target.height));
    if (dx <= OFFSCREEN_BOX_TOLERANCE && dy <= OFFSCREEN_BOX_TOLERANCE)
        return null;
    return `${PREFIX} Offscreen box ${extentSummary(derived)} device px disagrees with the ` +
        `${extentSummary(target)} FBO Clutter allocated beyond ${OFFSCREEN_BOX_TOLERANCE}px`;
}

function finiteExtent(extent) {
    return Boolean(extent) && Number.isFinite(extent.width) && Number.isFinite(extent.height);
}

function extentSummary(extent) {
    return `${fmt2(extent.width)}x${fmt2(extent.height)}`;
}

function positiveRect(rect) {
    return Boolean(rect) &&
        Number.isFinite(rect.width) && Number.isFinite(rect.height) &&
        rect.width > 0 && rect.height > 0;
}

function extentsAgree(a, b, tolerance) {
    return Math.abs(a.width - b.width) <= tolerance &&
        Math.abs(a.height - b.height) <= tolerance;
}

function rectSummary(rect) {
    return `${rect.width}x${rect.height} at (${rect.x ?? 0},${rect.y ?? 0})`;
}

function finitePhase(phase) {
    return Boolean(phase) && Number.isFinite(phase.x) && Number.isFinite(phase.y);
}

/**
 * @returns Whether the phase is within the subpixel range on both axes
 */
function boundedPhase(phase) {
    return finitePhase(phase) &&
        Math.abs(phase.x) <= PHASE_MAGNITUDE_BOUND &&
        Math.abs(phase.y) <= PHASE_MAGNITUDE_BOUND;
}

function phaseSummary(phase) {
    return `(${fmt2(phase.x)},${fmt2(phase.y)})`;
}

/**
 * @returns The value with two decimal places, so a sub-pixel phase is visible
 */
function fmt2(value) {
    return Number(value).toFixed(2);
}
