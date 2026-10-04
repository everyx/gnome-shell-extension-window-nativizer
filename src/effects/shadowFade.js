/**
 * Pure transition state machine and mathematics for window shadow cross-fades.
 * Decouples fade timing, cubic-bezier easing, and interruptible weight blending
 * from Clutter/GObject actor rendering.
 */

import {ADWAITA_STYLE} from '../lib/adwaitaStyle.generated.js';

export const DEFAULT_FADE_DURATION_MS = ADWAITA_STYLE.transition.durationMs;
export const DEFAULT_FADE_EASING = ADWAITA_STYLE.transition.easing;

/**
 * Solves cubic-bezier(x1, y1, x2, y2) for a given progress t in [0..1]
 * using Newton-Raphson iteration.
 *
 * @param {number} t - Time progression [0..1]
 * @param {readonly [number, number, number, number]} curve - [x1, y1, x2, y2]
 * @returns {number} Value in [0..1]
 */
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

/**
 * Computes individual incoming and outgoing opacity weights from transition progress.
 *
 * @param {number} progress - Progress in [0..1]
 * @param {number} [outgoingWeight=1] - Inherited weight factor for outgoing style
 * @returns {{incoming: number, outgoing: number}}
 */
export function computeFadeWeights(progress, outgoingWeight = 1) {
    const p = Math.max(0, Math.min(1, progress));
    return {
        incoming: p,
        outgoing: (1 - p) * outgoingWeight,
    };
}

/**
 * @typedef {object} FadeState
 * @property {object|null} style - Current active/incoming target style
 * @property {{style: object, weight: number}|null} outgoing - Outgoing style and its inherited weight factor
 * @property {number} progress - Interpolated progress [0..1]
 * @property {number} fadeStart - Wall clock start timestamp in milliseconds, or 0 when not fading
 * @property {number} durationMs - Configured transition duration in milliseconds
 * @property {readonly [number, number, number, number]} easing - Cubic bezier coordinates
 */

/**
 * @param {object} [options]
 * @param {number} [options.durationMs]
 * @param {readonly [number, number, number, number]} [options.easing]
 * @returns {FadeState}
 */
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

/**
 * Pure state transition: computes new fade state when a style update arrives.
 *
 * @param {FadeState} state - Previous fade state
 * @param {object} nextStyle - Newly requested style
 * @param {object} [options]
 * @param {boolean} [options.animate=false] - Whether to animate the transition
 * @param {number} [options.nowMs=0] - Current wall clock timestamp in milliseconds
 * @returns {FadeState}
 */
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

    // Blend re-entry mid-transition: pick whichever side is currently more visible (progress >= 0.5)
    // as outgoing and inherit its proportional weight to avoid opacity jumps on rapid interruption.
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

/**
 * Pure state advance: advances the transition clock to nowMs.
 *
 * @param {FadeState} state - Previous fade state
 * @param {number} nowMs - Current wall clock timestamp in milliseconds
 * @returns {{state: FadeState, running: boolean}}
 */
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

/**
 * Encapsulates the cross-fade state machine for ShadowActor.
 * Supports deterministic millisecond testing without Clutter or system timers.
 */
export class ShadowFadeStateMachine {
    /**
     * @param {object} [options]
     * @param {number} [options.durationMs]
     * @param {readonly [number, number, number, number]} [options.easing]
     * @param {() => number} [options.now] - Clock function returning milliseconds
     */
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

    /**
     * @param {object} nextStyle
     * @param {object} [options]
     * @param {boolean} [options.animate=false]
     * @param {number} [options.nowMs]
     * @returns {boolean} Whether a fade transition is running
     */
    setStyle(nextStyle, options = {}) {
        const nowMs = typeof options.nowMs === 'number' ? options.nowMs : this._now();
        this._state = transitionFadeStyle(this._state, nextStyle, {
            animate: options.animate ?? false,
            nowMs,
        });
        return this.isFading;
    }

    /**
     * @param {number} [nowMs]
     * @returns {boolean} Whether a fade transition is still running (requires another frame)
     */
    advance(nowMs = null) {
        const time = typeof nowMs === 'number' ? nowMs : this._now();
        const {state, running} = advanceFadeState(this._state, time);
        this._state = state;
        return running;
    }

    /**
     * Immediately finishes any running transition and snaps to the current target style.
     */
    finish() {
        this._state = {
            ...this._state,
            outgoing: null,
            progress: 1,
            fadeStart: 0,
        };
    }

    /**
     * Resets the state machine to initial empty state.
     */
    reset() {
        this._state = createFadeState({durationMs: this._durationMs, easing: this._easing});
    }
}
