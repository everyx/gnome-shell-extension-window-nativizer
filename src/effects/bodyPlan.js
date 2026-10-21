/**
 * The body plan: the settle's state for one window, owned here, and the live reads both cuts settle
 * from. The rules themselves stay pure in `clipParams.js`; this owns their clock, so neither the
 * decoration nor the two effects carry the reference points by hand.
 */

import {BODY_SETTLE_TOLERANCE, isPaintableFrame, settleClipBody} from './clipParams.js';
import {getWindowBufferRect, getWindowFrameRect} from '../platform/window.js';

/**
 * A live actor's size, or null when the actor is gone or its read throws. The body authority is read
 * from actors we do not own (a surface container can be replaced mid-flight), so a torn-down read is
 * "unknown" and leaves the settle to fall back rather than aborting the paint.
 */
export function readActorSize(actor) {
    if (!actor)
        return null;
    try {
        return {width: actor.width, height: actor.height};
    } catch {
        return null;
    }
}

/**
 * The window's own size, read live: its frame rect, else its buffer rect. It separates a resize from a
 * body that moved on its own, so both cuts read it on their own frame; only its previous value travels
 * in the plan.
 *
 * The buffer is read only when the frame cannot answer: this runs on the paint clock.
 */
export function readWindowSize(win) {
    const frame = getWindowFrameRect(win);
    if (isPaintableFrame(frame))
        return {width: frame.width, height: frame.height};
    const buffer = getWindowBufferRect(win);
    if (isPaintableFrame(buffer))
        return {width: buffer.width, height: buffer.height};
    return null;
}

/**
 * The three reads one paint or relayout settles from, taken live.
 */
export function readBodySizes(clipTarget, windowActor, win) {
    return {
        targetSize: readActorSize(clipTarget),
        windowActorSize: readActorSize(windowActor),
        windowSize: readWindowSize(win),
    };
}

/**
 * One window's settle: the last settled body, the read it came from, the window's own size then, and
 * the count that bounds a hold. A decoration makes one and advances it once per pass; the paints read
 * the snapshot it hands out.
 */
export class BodyPlan {
    constructor({tolerance = BODY_SETTLE_TOLERANCE} = {}) {
        this._tolerance = tolerance;
        this._body = null;
        this._authority = null;
        this._windowSize = null;
        this._strikes = 0;
    }

    /**
     * The reference points a paint settles against, as one value. Fresh per pass, because a plan that
     * moved under a paint would let the cut and the cast disagree about which frame they are on.
     */
    get settle() {
        return {
            previousBody: this._body,
            previousAuthority: this._authority,
            previousWindowSize: this._windowSize,
            pairDisagreementStrikes: this._strikes,
            tolerance: this._tolerance,
        };
    }

    /**
     * Drops the reference points, which a decoration episode boundary must: the reads they were
     * compared against belonged to the episode that ended, so keeping them lets the next pass hold - and
     * therefore draw - a body from before the gap. The ring hold drops its buffer witness for the same
     * reason.
     */
    reset() {
        this._body = null;
        this._authority = null;
        this._windowSize = null;
        this._strikes = 0;
    }

    /**
     * Advances one pass. The actor sizes come from the resolved target and the window actor; the
     * window's own size comes from the pass's reading, since the pass is the clock that read it.
     *
     * @returns This pass's settle: the body to act on, its authority, and whether it is held
     */
    next({targetSize = null, windowActorSize = null, windowSize = null} = {}) {
        const settled = settleClipBody(targetSize, windowActorSize,
            this._body, this._authority, windowSize, this._windowSize, this._tolerance, this._strikes);
        this._body = settled.body;
        this._authority = settled.authority;
        this._windowSize = windowSize;
        this._strikes = settled.pairDisagreementStrikes;
        return settled;
    }
}
