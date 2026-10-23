/**
 * Specs for the diagnostic invariants: the pure predicates and the edge-triggered latch.
 *
 * Run: pnpm test
 */

import {
    BUFFER_ACTOR_TOLERANCE,
    OFFSCREEN_BOX_TOLERANCE,
    PHASE_ALIGNMENT_TOLERANCE,
    PHASE_MAGNITUDE_BOUND,
    Diagnostic,
    bufferAllocationWarning,
    evaluateInvariant,
    freshInvariantState,
    offscreenBoxWarning,
    overviewMaskRefusalWarning,
    phaseAlignmentWarning,
    shadowBakeFailureWarning,
    windowIdentityLabel,
} from '../src/lib/diagnosticInvariants.js';

describe('evaluateInvariant (one WARNING per episode, after a sustained violation)', () => {
    const say = 'boom';

    it('stays silent for a single-pass blip and re-arms on agreement', () => {
        // The pass a resize in flight shows: the buffer and the allocation settle a pass apart.
        let {state, message} = evaluateInvariant(freshInvariantState(), say);
        expect(message).toBeNull();
        expect(state.strikes).toBe(1);

        // Agreement before the second violation resets the count, so the blip never speaks.
        ({state, message} = evaluateInvariant(state, null));
        expect(message).toBeNull();
        expect(state).toEqual(freshInvariantState());
    });

    it('speaks on the second consecutive violating pass', () => {
        const first = evaluateInvariant(freshInvariantState(), say);
        expect(first.message).toBeNull();

        const second = evaluateInvariant(first.state, say);
        expect(second.message).toBe(say);
        expect(second.state.warned).toBeTrue();
    });

    it('does not repeat while the violation persists, and speaks again after it clears', () => {
        let latch = freshInvariantState();
        latch = evaluateInvariant(latch, say).state;
        const fired = evaluateInvariant(latch, say);
        expect(fired.message).toBe(say);
        latch = fired.state;

        // The episode is already loud: every later violating pass is silent.
        for (let i = 0; i < 5; i++) {
            const later = evaluateInvariant(latch, say);
            expect(later.message).toBeNull();
            latch = later.state;
        }

        // Agreement re-arms, so a fresh episode speaks again.
        latch = evaluateInvariant(latch, null).state;
        latch = evaluateInvariant(latch, say).state;
        expect(evaluateInvariant(latch, say).message).toBe(say);
    });

    it('accepts an absent latch and honours a caller-chosen strike count', () => {
        expect(evaluateInvariant(null, say).message).toBeNull();
        expect(evaluateInvariant(null, null).state).toEqual(freshInvariantState());

        const immediate = evaluateInvariant(null, say, 1);
        expect(immediate.message).toBe(say);
    });
});

describe('windowIdentityLabel (a journal line names the window)', () => {
    it('prefers the class, then the title, then the pid', () => {
        expect(windowIdentityLabel({wmClass: 'firefox', pid: 42})).toBe('"firefox"');
        expect(windowIdentityLabel({wmClass: '  ', title: 'Inbox', pid: 42})).toBe('"Inbox"');
        expect(windowIdentityLabel({pid: 42})).toBe('pid 42');
        expect(windowIdentityLabel({})).toBe('an unidentified window');
    });
});

describe('bufferAllocationWarning (the pass\'s two geometry reads must agree)', () => {
    const buffer = {x: 100, y: 50, width: 800, height: 600};

    it('is silent when the extents agree, including within the tolerance', () => {
        expect(bufferAllocationWarning(buffer, {...buffer}, 'x')).toBeNull();
        expect(bufferAllocationWarning(buffer,
            {...buffer, width: 800 + BUFFER_ACTOR_TOLERANCE / 2}, 'x')).toBeNull();
    });

    it('names both extents and the window on a real disagreement', () => {
        const warning = bufferAllocationWarning(buffer, {...buffer, width: 798}, '"firefox"');
        expect(warning).toContain('800x600');
        expect(warning).toContain('798x600');
        expect(warning).toContain('"firefox"');
    });

    it('ignores the origins, which an animation may legitimately translate', () => {
        expect(bufferAllocationWarning(buffer, {...buffer, x: 300, y: 200}, 'x')).toBeNull();
    });

    it('is silent when either read is missing or degenerate', () => {
        expect(bufferAllocationWarning(null, buffer, 'x')).toBeNull();
        expect(bufferAllocationWarning(buffer, null, 'x')).toBeNull();
        expect(bufferAllocationWarning(buffer, {...buffer, width: 0}, 'x')).toBeNull();
    });
});

describe('phaseAlignmentWarning (the fallback mirror must match Mutter\'s applied phase)', () => {
    it('is silent when they agree within the tolerance', () => {
        expect(phaseAlignmentWarning({x: 0.5, y: 0}, {x: 0.5, y: 0}, 'x')).toBeNull();
        expect(phaseAlignmentWarning({x: 0.5, y: 0},
            {x: 0.5 + PHASE_ALIGNMENT_TOLERANCE / 2, y: 0}, 'x')).toBeNull();
    });

    it('warns on a fractional-scale hairline of disagreement', () => {
        const warning = phaseAlignmentWarning({x: 0.5, y: 0}, {x: 1.3, y: 0}, '"firefox"');
        expect(warning).toContain('(0.50,0.00)');
        expect(warning).toContain('(1.30,0.00)');
        expect(warning).toContain('"firefox"');
    });

    it('is silent when either read is unavailable', () => {
        expect(phaseAlignmentWarning(null, {x: 1, y: 0}, 'x')).toBeNull();
        expect(phaseAlignmentWarning({x: 1, y: 0}, null, 'x')).toBeNull();
        expect(phaseAlignmentWarning({x: Number.NaN, y: 0}, {x: 1, y: 0}, 'x')).toBeNull();
    });

    it('reports an out-of-bound read as unavailable and keeps the raw numbers', () => {
        // A phase is bounded; -960 is a layout position, not a phase. The message says the read
        // is unavailable and prints both raw values so the journal still shows what was read.
        const warning = phaseAlignmentWarning({x: 0, y: 0},
            {x: -960, y: -600}, '"telegram"');
        expect(warning).toContain('unavailable');
        expect(warning).toContain('(-960.00,-600.00)');
        expect(warning).toContain(`${PHASE_MAGNITUDE_BOUND}px`);
        expect(warning).toContain('"telegram"');
        expect(warning).not.toContain('disagrees');
    });

    it('keeps a disagreement within the subpixel bound as a phase warning', () => {
        // The magnitude guard only rejects values a phase cannot have; a real fractional-scale
        // hairline is still a disagreement.
        const warning = phaseAlignmentWarning({x: 0, y: 0},
            {x: PHASE_MAGNITUDE_BOUND - 0.1, y: 0}, '"firefox"');
        expect(warning).toContain('disagrees');
    });
});

describe('overviewMaskRefusalWarning (the square-in-the-overview class)', () => {
    it('names the reason and the window', () => {
        const warning = overviewMaskRefusalWarning('no preview container', '"firefox"');
        expect(warning).toContain('no preview container');
        expect(warning).toContain('"firefox"');
    });
});

describe('offscreenBoxWarning (the derived box must span the FBO Clutter allocated)', () => {
    const derived = {width: 556, height: 356};

    it('names both extents when they part beyond the phase an edge may carry', () => {
        const warning = offscreenBoxWarning(derived, {width: 558, height: 356});
        expect(warning).toContain('556.00x356.00');
        expect(warning).toContain('558.00x356.00');
        expect(warning).toContain(String(OFFSCREEN_BOX_TOLERANCE));
    });

    it('stays silent when either extent is unknown, rather than fabricate one', () => {
        expect(offscreenBoxWarning(null, derived)).toBeNull();
        expect(offscreenBoxWarning(derived, null)).toBeNull();
        expect(offscreenBoxWarning(derived, {width: Number.NaN, height: 356})).toBeNull();
    });

    it('stays silent when the target is this box at another monitor scale', () => {
        // A window between two monitors: the pass derived at 1.0 and the engine sized the FBO at
        // 4/3. Holding the derivation already keeps the logical quad right, so this is a transition.
        const context = {declared: 1.0, candidates: [1.0], scales: [1.0, 4 / 3]};
        expect(offscreenBoxWarning({width: 1105, height: 715}, {width: 1474, height: 954},
            context, '"telegram"')).toBeNull();
        // And the reverse, where the declared scale is the fractional one.
        expect(offscreenBoxWarning({width: 1449, height: 866}, {width: 1086, height: 649},
            {...context, declared: 4 / 3}, '"telegram"')).toBeNull();
    });

    it('reports a ratio that lands back on the declared scale, which is drift and not a move', () => {
        // 558/556 is within two percent of 1.0, so it is not another monitor: it is the engine and
        // this pass disagreeing at one scale, which is what the check exists for.
        const warning = offscreenBoxWarning({width: 556, height: 356}, {width: 558, height: 356},
            {declared: 1.0, candidates: [1.0], scales: [1.0, 4 / 3]}, '"firefox"');
        expect(warning).toContain('"firefox"');
    });

    it('reports a target that is no box at any scale', () => {
        // Clutter hands a 1x1 target while the actor has no paint volume; the body would then be
        // sampled from a single texel, so this one is worth a line.
        const warning = offscreenBoxWarning({width: 2277, height: 1338}, {width: 1, height: 1},
            {declared: 4 / 3, candidates: [1.0, 2], scales: [1.0, 4 / 3]}, '"telegram"');
        expect(warning).toContain('"telegram"');
        expect(warning).toContain('1.00x1.00');
    });
});

describe('shadowBakeFailureWarning (one line per bake-failure episode)', () => {
    // The bake retries on every paint until it allocates, so an episode must stay one line and the
    // first successful bake must re-arm the latch. This drives the policy the same way
    // shadowTexture.bake() does; that module imports Cogl, so a unit test cannot load it.
    const attempt = (state, allocated, warn) => {
        const {state: next, message} = evaluateInvariant(state,
            allocated ? null : shadowBakeFailureWarning(1024), 1);
        if (message)
            warn(message);
        return next;
    };

    it('speaks once while the allocation keeps failing', () => {
        const warn = jasmine.createSpy('warn');
        let state = freshInvariantState();
        state = attempt(state, false, warn);
        state = attempt(state, false, warn);
        attempt(state, false, warn);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.calls.mostRecent().args[0]).toContain('1024x1024');
    });

    it('re-arms after a successful bake, so the next failure speaks again', () => {
        const warn = jasmine.createSpy('warn');
        let state = freshInvariantState();
        state = attempt(state, false, warn);
        expect(warn).toHaveBeenCalledTimes(1);
        state = attempt(state, true, warn);
        attempt(state, false, warn);
        expect(warn).toHaveBeenCalledTimes(2);
    });
});

describe('Diagnostic (a latch that writes its own line)', () => {
    const warn = () => {
        const sink = jasmine.createSpy('warn');
        return {sink, quarantine: new Diagnostic({warn: sink})};
    };

    it('speaks once per episode to the journal it was built with', () => {
        const {sink, quarantine} = warn();

        quarantine.check('disagrees');
        quarantine.check('disagrees');

        expect(sink).toHaveBeenCalledOnceWith('disagrees');
    });

    it('re-arms on a pass with nothing to say, so a later episode speaks again', () => {
        // The shape of a bug this object exists to prevent: a decided pass used to skip the call
        // entirely, which left the latch armed for good. Agreement now goes through check(null).
        const {sink, quarantine} = warn();

        quarantine.check('disagrees');
        quarantine.check('disagrees');
        expect(sink).toHaveBeenCalledTimes(1);

        quarantine.check(null);
        quarantine.check('disagrees');
        quarantine.check('disagrees');

        expect(sink).toHaveBeenCalledTimes(2);
    });

    it('honours the strike count it was given', () => {
        const sink = jasmine.createSpy('warn');
        const first = new Diagnostic({warn: sink}, 1);

        first.check('disagrees');

        expect(sink).toHaveBeenCalledOnceWith('disagrees');
    });

    it('forgets the episode on reset, which is a teardown rather than a pass', () => {
        const sink = jasmine.createSpy('warn');
        const quarantine = new Diagnostic({warn: sink}, 1);

        quarantine.check('disagrees');
        quarantine.reset();
        quarantine.check('disagrees');

        expect(sink).toHaveBeenCalledTimes(2);
    });
});
