/** One window's settle state and the live reads both cuts settle from; clipParams stays pure. */

import {BODY_SETTLE_TOLERANCE, isPaintableFrame, settleClipBody} from './clipParams.js';
import {getWindowBufferRect, getWindowFrameRect} from '../platform/window.js';

/** A live actor's size, or null when gone or the read throws: an unowned actor can vanish. */
export function readActorSize(actor) {
    if (!actor)
        return null;
    try {
        return {width: actor.width, height: actor.height};
    } catch {
        return null;
    }
}

/** The window's own size, frame rect else buffer rect; runs on the paint clock, no extra reads. */
export function readWindowSize(win) {
    const frame = getWindowFrameRect(win);
    if (isPaintableFrame(frame))
        return {width: frame.width, height: frame.height};
    const buffer = getWindowBufferRect(win);
    if (isPaintableFrame(buffer))
        return {width: buffer.width, height: buffer.height};
    return null;
}

/** The three reads one paint or relayout settles from, taken live. */
export function readBodySizes(clipTarget, windowActor, win) {
    return {
        targetSize: readActorSize(clipTarget),
        windowActorSize: readActorSize(windowActor),
        windowSize: readWindowSize(win),
    };
}

/** One window's settle: last settled body, its authority and window size, and the hold count. */
export class BodyPlan {
    constructor({tolerance = BODY_SETTLE_TOLERANCE} = {}) {
        this._tolerance = tolerance;
        this._body = null;
        this._authority = null;
        this._windowSize = null;
        this._strikes = 0;
    }

    /** Fresh per pass: a plan moving under a paint would let the cut and the cast disagree. */
    get settle() {
        return {
            previousBody: this._body,
            previousAuthority: this._authority,
            previousWindowSize: this._windowSize,
            pairDisagreementStrikes: this._strikes,
            tolerance: this._tolerance,
        };
    }

    /** An episode boundary must drop these, or the next pass draws a body from before the gap. */
    reset() {
        this._body = null;
        this._authority = null;
        this._windowSize = null;
        this._strikes = 0;
    }

    /** Advances one pass; window size comes from the pass, which is the clock that read it. */
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
