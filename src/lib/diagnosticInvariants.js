/** Pure predicates plus a strike latch, so a violation speaks once per episode; health is quiet. */

import {OFFSCREEN_BOX_TOLERANCE} from './offscreenBox.js';

/** One device pixel, the subpixel phase an edge may carry; the geometry module owns the number. */
export {OFFSCREEN_BOX_TOLERANCE};

/** Violating passes before speaking: a geometry change and its allocation settle a pass apart. */
export const INVARIANT_STRIKES = 2;

export const BUFFER_ACTOR_TOLERANCE = 0.5;

/** The misalignment seen is a whole physical pixel; this sits far below it, above float residue. */
export const PHASE_ALIGNMENT_TOLERANCE = 0.05;

/** A real phase is under `1 / scale` logical px: Mutter snaps to the grid, so more is a position. */
export const PHASE_MAGNITUDE_BOUND = 2;

export function freshInvariantState() {
    return {strikes: 0, warned: false};
}

/** A null warning re-arms; a warning speaks once per episode and stays silent until agreement. */
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

/** Latch plus journal, so a pass holds no state and cannot skip the call that re-arms it. */
export class Diagnostic {
    /** `strikes` is how many consecutive violating passes this instance waits for. */
    constructor(journal, strikes = INVARIANT_STRIKES) {
        this._journal = journal;
        this._strikes = strikes;
        this._state = freshInvariantState();
    }

    /** Agreeing re-arms the episode; a violation speaks once per episode. */
    check(warning) {
        const {state, message} = evaluateInvariant(this._state, warning, this._strikes);
        this._state = state;
        if (message)
            this._journal.warn(message);
    }

    /** For a teardown, which is not a pass: the object outlives what it described. */
    reset() {
        this._state = freshInvariantState();
    }
}

/** Class first, then title, then pid, so the journal line names a window a reader can find. */
export function windowIdentityLabel({wmClass, title, pid} = {}) {
    const name = `${wmClass ?? ''}`.trim() || `${title ?? ''}`.trim();
    if (name)
        return `"${name}"`;
    if (typeof pid === 'number' && pid > 0)
        return `pid ${pid}`;
    return 'an unidentified window';
}

/** Extents only: origins may differ by an animation's translation. Null on a degenerate rect. */
export function bufferAllocationWarning(bufferRect, actorBox, label = windowIdentityLabel()) {
    if (!positiveRect(bufferRect) || !positiveRect(actorBox))
        return null;
    if (extentsAgree(bufferRect, actorBox, BUFFER_ACTOR_TOLERANCE))
        return null;
    return `Window buffer ${rectSummary(bufferRect)} disagrees with the window actor ` +
        `allocation ${rectSummary(actorBox)} for ${label} beyond ${BUFFER_ACTOR_TOLERANCE}px`;
}

/** Unavailable, not a disagreement, when a read exceeds the bound; fallback path only. */
export function phaseAlignmentWarning(mirror, applied, label = windowIdentityLabel()) {
    if (!finitePhase(mirror) || !finitePhase(applied))
        return null;

    // Past the subpixel range a read is a position or stale transform: unavailable, with raw values.
    if (!boundedPhase(mirror) || !boundedPhase(applied)) {
        return `Fallback subpixel phase unavailable for ${label}: mirror ` +
            `${phaseSummary(mirror)} applied ${phaseSummary(applied)} exceeds ` +
            `${PHASE_MAGNITUDE_BOUND}px`;
    }

    if (Math.abs(mirror.x - applied.x) <= PHASE_ALIGNMENT_TOLERANCE &&
        Math.abs(mirror.y - applied.y) <= PHASE_ALIGNMENT_TOLERANCE)
        return null;
    return `Fallback subpixel phase ${phaseSummary(mirror)} disagrees with the phase ` +
        `Mutter applied ${phaseSummary(applied)} for ${label} beyond ${PHASE_ALIGNMENT_TOLERANCE}px`;
}

/** The capability and geometry refusals only; the caller separates out the "not ready yet" ones. */
export function overviewMaskRefusalWarning(reason, label = windowIdentityLabel()) {
    return `Overview mask not installed for ${label} although the window was ready: ${reason}`;
}

/** The bake retries next paint, so a persistent shortage is one line per episode, not per frame. */
export function shadowBakeFailureWarning(buffer) {
    return `Could not allocate a ${buffer}x${buffer} shadow buffer`;
}

/** One axis may round a little more than the other; two percent is far above the padding's doing. */
const SCALE_MATCH_TOLERANCE = 0.02;

/** True when the target is this box at another monitor's scale. A ratio that lands on the declared
 *  scale is drift rather than a transition, because that is the scale the pass already used. */
function isMonitorTransition(derived, target, declared, scales) {
    const rx = target.width / derived.width;
    const ry = target.height / derived.height;
    if (!(rx > 0) || !(ry > 0) || Math.abs(rx - ry) > Math.max(rx, ry) * SCALE_MATCH_TOLERANCE)
        return false;
    const real = rx * declared;
    if (Math.abs(real - declared) <= declared * SCALE_MATCH_TOLERANCE)
        return false;
    return scales.some(scale => Math.abs(real - scale) <= scale * SCALE_MATCH_TOLERANCE);
}

/** Called only for a pass whose FBO no candidate explained; null when another monitor's did it. */
export function offscreenBoxWarning(derived, target, context, label = windowIdentityLabel()) {
    if (!(derived?.width > 0) || !(derived?.height > 0) || !(target?.width > 0) || !(target?.height > 0))
        return null;
    const {declared, candidates, scales} = context ?? {};
    if (scales && isMonitorTransition(derived, target, declared, scales))
        return null;
    return `Offscreen box ${extentSummary(derived)} device px is not this box at any monitor ` +
        `scale, against the ${extentSummary(target)} FBO Clutter allocated beyond ` +
        `${OFFSCREEN_BOX_TOLERANCE}px for ${label} (scale ${declared}, ` +
        `candidates ${candidates?.join('|') ?? 'none'})`;
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

/** False is out of the subpixel range on an axis: a position or stale transform, not a phase. */
function boundedPhase(phase) {
    return finitePhase(phase) &&
        Math.abs(phase.x) <= PHASE_MAGNITUDE_BOUND &&
        Math.abs(phase.y) <= PHASE_MAGNITUDE_BOUND;
}

function phaseSummary(phase) {
    return `(${fmt2(phase.x)},${fmt2(phase.y)})`;
}

/** Two decimals, so a sub-pixel phase stays visible. */
function fmt2(value) {
    return Number(value).toFixed(2);
}
