/** Pure cross-fade state machine and math; no Clutter or GObject, so tests step a fake clock. */

import {ADWAITA_STYLE} from '../lib/adwaitaStyle.generated.js';

export const DEFAULT_FADE_DURATION_MS = ADWAITA_STYLE.transition.durationMs;
export const DEFAULT_FADE_EASING = ADWAITA_STYLE.transition.easing;

/** Solves cubic-bezier(x1, y1, x2, y2) at t by Newton-Raphson; CSS easing has no closed form. */
export function solveCubicBezier(t, [x1, y1, x2, y2]) {
    const clampedT = Math.max(0, Math.min(1, t));
    const at = (u, p1, p2) => 3 * (1 - u) ** 2 * u * p1 + 3 * (1 - u) * u ** 2 * p2 + u ** 3;
    let u = clampedT;
    for (let i = 0; i < 4; i++) {
        const slope = 3 * (1 - u) ** 2 * x1 + 6 * (1 - u) * u * (x2 - x1) + 3 * u ** 2 * (1 - x2);
        if (slope === 0)
            break;
        u -= (at(u, x1, x2) - clampedT) / slope;
    }
    return at(Math.max(0, Math.min(1, u)), y1, y2);
}

/** Opacity weights for a progress; `outgoingWeight` carries a weight inherited mid-fade. */
export function computeFadeWeights(progress, outgoingWeight = 1) {
    const p = Math.max(0, Math.min(1, progress));
    return {
        incoming: p,
        outgoing: (1 - p) * outgoingWeight,
    };
}


export function createFadeState(options = {}) {
    return {
        style: null,
        outgoing: null,
        progress: 1,
        fadeStart: 0,
        durationMs: options.durationMs ?? DEFAULT_FADE_DURATION_MS,
        easing: options.easing ?? DEFAULT_FADE_EASING,
    };
}

/** New fade state for an incoming style; without `animate` it snaps, dropping the outgoing one. */
export function transitionFadeStyle(state, nextStyle, {animate = false, nowMs = 0} = {}) {
    if (!state.style || !animate) {
        return {
            ...state,
            style: nextStyle,
            outgoing: null,
            progress: 1,
            fadeStart: 0,
        };
    }

    // Re-entry mid-fade keeps the more visible side, with its weight, so opacity never jumps.
    const keepStyle = state.progress >= 0.5;
    const kept = keepStyle ? state.style : state.outgoing?.style;
    let keptWeight = 0;
    if (keepStyle)
        keptWeight = state.progress;
    else if (state.outgoing)
        keptWeight = (1 - state.progress) * state.outgoing.weight;

    const outgoing = kept ? {style: kept, weight: keptWeight} : null;

    if (!outgoing) {
        return {
            ...state,
            style: nextStyle,
            outgoing: null,
            progress: 1,
            fadeStart: 0,
        };
    }

    return {
        ...state,
        style: nextStyle,
        outgoing,
        progress: 0,
        fadeStart: nowMs,
    };
}

/** Advances the fade clock to `nowMs`; progress follows the eased curve and settles at 1. */
export function advanceFadeState(state, nowMs) {
    if (state.fadeStart === 0 || !state.outgoing)
        return {state, running: false};

    const elapsedMs = Math.max(0, nowMs - state.fadeStart);
    if (elapsedMs >= state.durationMs) {
        return {
            state: {
                ...state,
                progress: 1,
                outgoing: null,
                fadeStart: 0,
            },
            running: false,
        };
    }

    const t = Math.min(1, elapsedMs / state.durationMs);
    const progress = solveCubicBezier(t, state.easing);
    return {
        state: {
            ...state,
            progress,
        },
        running: true,
    };
}

/** Cross-fade state machine for ShadowActor, on an injectable clock so tests stay deterministic. */
export class ShadowFadeStateMachine {
    /** `options.now` is the clock, defaulting to `Date.now`, so tests can step time. */
    constructor(options = {}) {
        this._durationMs = options.durationMs ?? DEFAULT_FADE_DURATION_MS;
        this._easing = options.easing ?? DEFAULT_FADE_EASING;
        this._now = options.now ?? (() => Date.now());
        this._state = createFadeState({durationMs: this._durationMs, easing: this._easing});
    }

    get style() {
        return this._state.style;
    }

    get outgoing() {
        return this._state.outgoing;
    }

    get progress() {
        return this._state.progress;
    }

    get fadeStart() {
        return this._state.fadeStart;
    }

    get isFading() {
        return this._state.outgoing !== null && this._state.progress < 1;
    }

    get isSettled() {
        return !this.isFading;
    }

    get incomingWeight() {
        return this._state.outgoing ? this._state.progress : 1;
    }

    get outgoingWeight() {
        if (!this._state.outgoing)
            return 0;
        return (1 - this._state.progress) * this._state.outgoing.weight;
    }

    /** Sets the target style and returns whether a fade is now running. */
    setStyle(nextStyle, options = {}) {
        const nowMs = typeof options.nowMs === 'number' ? options.nowMs : this._now();
        this._state = transitionFadeStyle(this._state, nextStyle, {
            animate: options.animate ?? false,
            nowMs,
        });
        return this.isFading;
    }

    /** Advances the clock and returns whether another frame is still needed. */
    advance(nowMs = null) {
        const time = typeof nowMs === 'number' ? nowMs : this._now();
        const {state, running} = advanceFadeState(this._state, time);
        this._state = state;
        return running;
    }

    /** Ends any running fade at once, snapping to the target style. */
    finish() {
        this._state = {
            ...this._state,
            outgoing: null,
            progress: 1,
            fadeStart: 0,
        };
    }

    /** Resets to the initial state, keeping the configured duration and easing. */
    reset() {
        this._state = createFadeState({durationMs: this._durationMs, easing: this._easing});
    }
}
