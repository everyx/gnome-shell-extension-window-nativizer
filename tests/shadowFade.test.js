import {
    DEFAULT_FADE_DURATION_MS,
    DEFAULT_FADE_EASING,
    ShadowFadeStateMachine,
    computeFadeWeights,
    createFadeState,
    solveCubicBezier,
    transitionFadeStyle,
    advanceFadeState,
} from '../src/effects/shadowFade.js';

describe('shadowFade mathematics and pure functions', () => {
    describe('solveCubicBezier', () => {
        it('evaluates endpoints correctly', () => {
            expect(solveCubicBezier(0, DEFAULT_FADE_EASING)).toBeCloseTo(0, 5);
            expect(solveCubicBezier(1, DEFAULT_FADE_EASING)).toBeCloseTo(1, 5);
        });

        it('clamps inputs below 0 and above 1', () => {
            expect(solveCubicBezier(-0.5, DEFAULT_FADE_EASING)).toBeCloseTo(0, 5);
            expect(solveCubicBezier(1.5, DEFAULT_FADE_EASING)).toBeCloseTo(1, 5);
        });

        it('is monotonic increasing for standard ease-out easing', () => {
            let last = -1;
            for (let t = 0; t <= 1.0; t += 0.1) {
                const val = solveCubicBezier(t, DEFAULT_FADE_EASING);
                expect(val).toBeGreaterThanOrEqual(last);
                last = val;
            }
        });
    });

    describe('computeFadeWeights', () => {
        it('returns zero incoming and full outgoing at progress 0', () => {
            const weights = computeFadeWeights(0, 1.0);
            expect(weights.incoming).toBe(0);
            expect(weights.outgoing).toBe(1.0);
        });

        it('returns full incoming and zero outgoing at progress 1', () => {
            const weights = computeFadeWeights(1, 1.0);
            expect(weights.incoming).toBe(1);
            expect(weights.outgoing).toBe(0);
        });

        it('scales outgoing weight proportionally', () => {
            const weights = computeFadeWeights(0.5, 0.6);
            expect(weights.incoming).toBe(0.5);
            expect(weights.outgoing).toBeCloseTo(0.3, 5);
        });
    });

    describe('transitionFadeStyle pure state transitions', () => {
        const styleA = {key: 'style-A', radius: 10};
        const styleB = {key: 'style-B', radius: 12};

        it('snaps when initial style is set', () => {
            const initial = createFadeState();
            const next = transitionFadeStyle(initial, styleA, {animate: true, nowMs: 1000});
            expect(next.style).toBe(styleA);
            expect(next.outgoing).toBeNull();
            expect(next.progress).toBe(1);
            expect(next.fadeStart).toBe(0);
        });

        it('snaps when animate is false', () => {
            const stateWithA = {
                ...createFadeState(),
                style: styleA,
            };
            const next = transitionFadeStyle(stateWithA, styleB, {animate: false, nowMs: 1000});
            expect(next.style).toBe(styleB);
            expect(next.outgoing).toBeNull();
            expect(next.progress).toBe(1);
        });

        it('initiates blend when animate is true', () => {
            const stateWithA = {
                ...createFadeState(),
                style: styleA,
                progress: 1,
            };
            const next = transitionFadeStyle(stateWithA, styleB, {animate: true, nowMs: 1000});
            expect(next.style).toBe(styleB);
            expect(next.outgoing).toEqual({style: styleA, weight: 1});
            expect(next.progress).toBe(0);
            expect(next.fadeStart).toBe(1000);
        });
    });

    describe('advanceFadeState pure clock advancement', () => {
        const styleA = {key: 'style-A'};
        const styleB = {key: 'style-B'};

        it('reports not running when fadeStart is 0 or outgoing is null', () => {
            const settled = createFadeState();
            const {running} = advanceFadeState(settled, 1000);
            expect(running).toBeFalse();
        });

        it('advances progress smoothly and finishes at or past durationMs', () => {
            const active = {
                ...createFadeState({durationMs: 200}),
                style: styleB,
                outgoing: {style: styleA, weight: 1},
                fadeStart: 1000,
                progress: 0,
            };

            const halfway = advanceFadeState(active, 1100);
            expect(halfway.running).toBeTrue();
            expect(halfway.state.progress).toBeGreaterThan(0);
            expect(halfway.state.progress).toBeLessThan(1);

            const finished = advanceFadeState(active, 1200);
            expect(finished.running).toBeFalse();
            expect(finished.state.progress).toBe(1);
            expect(finished.state.outgoing).toBeNull();
            expect(finished.state.fadeStart).toBe(0);
        });

        it('handles zero or backwards clock elapsed time defensively', () => {
            const active = {
                ...createFadeState({durationMs: 200}),
                style: styleB,
                outgoing: {style: styleA, weight: 1},
                fadeStart: 1000,
                progress: 0,
            };
            const result = advanceFadeState(active, 950);
            expect(result.running).toBeTrue();
            expect(result.state.progress).toBeCloseTo(0, 5);
        });
    });
});

describe('ShadowFadeStateMachine (deterministic millisecond clock testing)', () => {
    let mockTime = 1000;
    /** @type {ShadowFadeStateMachine} */
    let fsm;

    const style1 = {key: 's1', radius: 8};
    const style2 = {key: 's2', radius: 12};
    const style3 = {key: 's3', radius: 16};

    beforeEach(() => {
        mockTime = 1000;
        fsm = new ShadowFadeStateMachine({
            durationMs: 200,
            now: () => mockTime,
        });
    });

    it('initializes in settled state with default duration', () => {
        const defaultFsm = new ShadowFadeStateMachine();
        expect(defaultFsm.isSettled).toBeTrue();
        expect(defaultFsm.isFading).toBeFalse();
        expect(defaultFsm.progress).toBe(1);
        expect(defaultFsm.outgoing).toBeNull();
        expect(defaultFsm.style).toBeNull();
        expect(defaultFsm._durationMs).toBe(DEFAULT_FADE_DURATION_MS);
    });

    it('snaps initial style without animation', () => {
        const isFading = fsm.setStyle(style1, {animate: true});
        expect(isFading).toBeFalse();
        expect(fsm.isSettled).toBeTrue();
        expect(fsm.style).toBe(style1);
        expect(fsm.outgoing).toBeNull();
    });

    it('executes a complete 200ms cross-fade between styles', () => {
        fsm.setStyle(style1, {animate: false});
        expect(fsm.isSettled).toBeTrue();

        // Trigger animation to style2 at 1000ms
        const started = fsm.setStyle(style2, {animate: true});
        expect(started).toBeTrue();
        expect(fsm.isFading).toBeTrue();
        expect(fsm.isSettled).toBeFalse();
        expect(fsm.progress).toBe(0);
        expect(fsm.outgoing).toEqual({style: style1, weight: 1});
        expect(fsm.incomingWeight).toBe(0);
        expect(fsm.outgoingWeight).toBe(1);

        // Advance 100ms (halfway)
        mockTime = 1100;
        const stillRunning = fsm.advance();
        expect(stillRunning).toBeTrue();
        expect(fsm.isFading).toBeTrue();
        expect(fsm.progress).toBeGreaterThan(0.5); // ease-out is front-loaded
        expect(fsm.incomingWeight).toBe(fsm.progress);
        expect(fsm.outgoingWeight).toBeCloseTo(1 - fsm.progress, 5);

        // Advance to 200ms (completion)
        mockTime = 1200;
        const complete = fsm.advance();
        expect(complete).toBeFalse();
        expect(fsm.isSettled).toBeTrue();
        expect(fsm.isFading).toBeFalse();
        expect(fsm.progress).toBe(1);
        expect(fsm.outgoing).toBeNull();
        expect(fsm.incomingWeight).toBe(1);
        expect(fsm.outgoingWeight).toBe(0);
    });

    it('handles interruption in first half (< 50% progress): keeps old outgoing', () => {
        fsm.setStyle(style1, {animate: false});

        // Start fade to style2 at 1000ms
        fsm.setStyle(style2, {animate: true});

        // Advance only 20ms: progress is small (< 0.5)
        mockTime = 1020;
        fsm.advance();
        const progressAtInterrupt = fsm.progress;
        expect(progressAtInterrupt).toBeLessThan(0.5);

        // Interrupted by style3 at 1020ms
        fsm.setStyle(style3, {animate: true});
        expect(fsm.style).toBe(style3);
        // Kept style remains style1 because it was still dominant
        expect(fsm.outgoing.style).toBe(style1);
        expect(fsm.outgoing.weight).toBeCloseTo(1 - progressAtInterrupt, 4);
        expect(fsm.progress).toBe(0);

        // Finish transition to style3 at 1220ms
        mockTime = 1220;
        fsm.advance();
        expect(fsm.isSettled).toBeTrue();
        expect(fsm.style).toBe(style3);
        expect(fsm.outgoing).toBeNull();
    });

    it('handles interruption in second half (>= 50% progress): adopts style2 as outgoing', () => {
        fsm.setStyle(style1, {animate: false});

        // Start fade to style2 at 1000ms
        fsm.setStyle(style2, {animate: true});

        // Advance 120ms: progress is >= 0.5
        mockTime = 1120;
        fsm.advance();
        const progressAtInterrupt = fsm.progress;
        expect(progressAtInterrupt).toBeGreaterThanOrEqual(0.5);

        // Interrupted by style3 at 1120ms
        fsm.setStyle(style3, {animate: true});
        expect(fsm.style).toBe(style3);
        // Kept style switches to style2 because it had become the dominant style
        expect(fsm.outgoing.style).toBe(style2);
        expect(fsm.outgoing.weight).toBeCloseTo(progressAtInterrupt, 4);
        expect(fsm.progress).toBe(0);

        // Advance to 1320ms to settle
        mockTime = 1320;
        fsm.advance();
        expect(fsm.isSettled).toBeTrue();
        expect(fsm.style).toBe(style3);
        expect(fsm.outgoing).toBeNull();
    });

    it('snaps immediately when animate is false during active blend', () => {
        fsm.setStyle(style1, {animate: false});
        fsm.setStyle(style2, {animate: true});
        mockTime = 1050;
        fsm.advance();
        expect(fsm.isFading).toBeTrue();

        fsm.setStyle(style3, {animate: false});
        expect(fsm.isSettled).toBeTrue();
        expect(fsm.style).toBe(style3);
        expect(fsm.outgoing).toBeNull();
        expect(fsm.progress).toBe(1);
    });

    it('resets cleanly with reset()', () => {
        fsm.setStyle(style1, {animate: false});
        fsm.setStyle(style2, {animate: true});
        fsm.reset();

        expect(fsm.isSettled).toBeTrue();
        expect(fsm.style).toBeNull();
        expect(fsm.outgoing).toBeNull();
        expect(fsm.progress).toBe(1);
    });

    it('snaps immediately to settled state with finish()', () => {
        fsm.setStyle(style1, {animate: false});
        fsm.setStyle(style2, {animate: true});
        mockTime = 1050;
        fsm.advance();
        expect(fsm.isFading).toBeTrue();
        expect(fsm.isSettled).toBeFalse();

        fsm.finish();
        expect(fsm.isSettled).toBeTrue();
        expect(fsm.isFading).toBeFalse();
        expect(fsm.progress).toBe(1);
        expect(fsm.style).toBe(style2);
        expect(fsm.outgoing).toBeNull();
        expect(fsm.incomingWeight).toBe(1);
        expect(fsm.outgoingWeight).toBe(0);
    });

    it('handles boundary interruption at exactly 50% progress', () => {
        const s1 = {key: 's1'};
        const s2 = {key: 's2'};
        const s3 = {key: 's3'};
        const stateAtHalf = {
            ...createFadeState({durationMs: 200}),
            style: s2,
            outgoing: {style: s1, weight: 1},
            progress: 0.5,
            fadeStart: 1000,
        };
        const next = transitionFadeStyle(stateAtHalf, s3, {animate: true, nowMs: 1100});
        expect(next.style).toBe(s3);
        expect(next.outgoing.style).toBe(s2);
        expect(next.outgoing.weight).toBeCloseTo(0.5, 5);
        expect(next.progress).toBe(0);
    });

    it('cascades weight attenuation smoothly across multiple rapid interruptions', () => {
        fsm.setStyle(style1, {animate: false});

        // 第一次过渡到 style2
        fsm.setStyle(style2, {animate: true});
        mockTime = 1020;
        fsm.advance();
        const p1 = fsm.progress;

        // 第一次打断：前半段切换到 style3
        fsm.setStyle(style3, {animate: true});
        expect(fsm.outgoing.style).toBe(style1);
        expect(fsm.outgoing.weight).toBeCloseTo(1 - p1, 5);

        // 前进到前半段 (< 0.5)
        mockTime = 1040;
        fsm.advance();
        const p2 = fsm.progress;

        // 第二次打断：前半段再次切换到 style4
        const style4 = {key: 's4'};
        fsm.setStyle(style4, {animate: true});
        expect(fsm.outgoing.style).toBe(style1);
        // 权重连续相乘衰减
        expect(fsm.outgoing.weight).toBeCloseTo((1 - p2) * (1 - p1), 5);
    });
});
