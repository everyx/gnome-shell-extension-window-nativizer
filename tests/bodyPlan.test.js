/**
 * The body plan's transport: the settle's reference points, and the live reads a paint settles from.
 * The settle rules themselves are pinned in clipParams.test.js; what this covers is the ownership
 * that used to be four loose fields on the decoration and a reader in each effect.
 * Run: pnpm test
 */

import {BodyPlan, readActorSize, readWindowSize, readBodySizes} from '../src/effects/bodyPlan.js';
import {readWindow} from '../src/lib/window.js';
import {INVARIANT_STRIKES} from '../src/lib/diagnosticInvariants.js';

const size = (width, height = 600) => ({width, height});

describe('readWindowSize', () => {
    it('prefers the frame rect over the buffer rect', () => {
        const win = {
            get_frame_rect: () => ({x: 0, y: 0, ...size(800)}),
            get_buffer_rect: () => ({x: 0, y: 0, ...size(790)}),
        };
        expect(readWindowSize(win)).toEqual(size(800));
    });

    it('falls back to the buffer rect when the frame has no extent', () => {
        const win = {
            get_frame_rect: () => ({x: 0, y: 0, width: 0, height: 0}),
            get_buffer_rect: () => ({x: 0, y: 0, ...size(790)}),
        };
        expect(readWindowSize(win)).toEqual(size(790));
    });

    it('reads no buffer when the frame already answers, because this runs on the paint clock', () => {
        let bufferReads = 0;
        const win = {
            get_frame_rect: () => ({x: 0, y: 0, ...size(800)}),
            get_buffer_rect: () => {
                bufferReads++;
                return {x: 0, y: 0, ...size(790)};
            },
        };
        expect(readWindowSize(win)).toEqual(size(800));
        expect(bufferReads).toBe(0);
    });

    it('answers null when neither read is usable', () => {
        expect(readWindowSize(null)).toBeNull();
        expect(readWindowSize({})).toBeNull();
        expect(readWindowSize({
            get_frame_rect: () => ({x: 0, y: 0, width: 0, height: 0}),
            get_buffer_rect: () => null,
        })).toBeNull();
    });

    it('reads a window that is being torn down as unknown rather than throwing', () => {
        const win = {
            get_frame_rect: () => {
                throw new Error('window is gone');
            },
            get_buffer_rect: () => {
                throw new Error('window is gone');
            },
        };
        expect(readWindowSize(win)).toBeNull();
    });
});

describe('readActorSize', () => {
    it('reads a live actor and treats a torn-down one as unknown', () => {
        expect(readActorSize({width: 800, height: 600})).toEqual(size(800));
        expect(readActorSize(null)).toBeNull();
        expect(readActorSize({
            get width() {
                throw new Error('needs an allocation');
            },
        })).toBeNull();
    });

    it('gathers the three reads one paint settles from', () => {
        const win = {get_frame_rect: () => ({x: 0, y: 0, ...size(800)})};
        const reads = readBodySizes({width: 800, height: 600}, {width: 800, height: 600}, win);
        expect(reads).toEqual({
            targetSize: size(800),
            windowActorSize: size(800),
            windowSize: size(800),
        });
    });
});

describe('BodyPlan (a window’s settle, owned in one place)', () => {
    it('starts with no reference points, like a first pass', () => {
        expect(new BodyPlan().settle).toEqual({
            previousBody: null,
            previousAuthority: null,
            previousWindowSize: null,
            pairDisagreementStrikes: 0,
            tolerance: 1.0,
        });
    });

    it('hands the paints the state it held before the pass advanced', () => {
        const plan = new BodyPlan();
        plan.next({targetSize: size(800), windowActorSize: size(800), windowSize: size(800)});

        // What a paint gets after this pass is what the next pass finds as its starting point.
        expect(plan.settle).toEqual({
            previousBody: size(800),
            previousAuthority: size(800),
            previousWindowSize: size(800),
            pairDisagreementStrikes: 0,
            tolerance: 1.0,
        });
    });

    it('does not move a snapshot a paint already holds', () => {
        const plan = new BodyPlan();
        plan.next({targetSize: size(800), windowActorSize: size(800), windowSize: size(800)});
        const handed = plan.settle;

        plan.next({targetSize: size(900), windowActorSize: size(900), windowSize: size(900)});

        expect(handed.previousBody).toEqual(size(800));
        expect(handed.previousWindowSize).toEqual(size(800));
        expect(plan.settle.previousBody).toEqual(size(900));
    });

    it('holds a body that moved while the window did not, and restores it on the next pass', () => {
        const plan = new BodyPlan();
        plan.next({targetSize: size(800), windowActorSize: size(800), windowSize: size(800)});

        // The focus hand-off: both reads trail by the same pixel, the window's own size did not move.
        const held = plan.next({targetSize: size(798), windowActorSize: size(798), windowSize: size(800)});
        expect(held.authority).toEqual(size(798));
        expect(held.body).toEqual(size(800));
        expect(held.unsettled).toBeTrue();

        // Once the authority stops moving, the fresh body is acted on rather than held forever.
        const restored = plan.next({targetSize: size(798), windowActorSize: size(798), windowSize: size(800)});
        expect(restored.body).toEqual(size(798));
        expect(restored.unsettled).toBeFalse();
    });

    it('carries the strike count between passes and acts after the bound', () => {
        const plan = new BodyPlan();
        plan.next({targetSize: size(800), windowActorSize: size(800), windowSize: size(800)});

        // A pair that disagrees with a window size that confirms neither read: held while the count
        // is below the bound, then the window actor is preferred over holding forever.
        const target = size(796);
        const actor = size(804);
        let settled = null;
        for (let i = 0; i < INVARIANT_STRIKES; i++)
            settled = plan.next({targetSize: target, windowActorSize: actor, windowSize: size(800)});

        expect(settled.body).toEqual(actor);
        expect(settled.unsettled).toBeFalse();
        expect(plan.settle.pairDisagreementStrikes).toBe(INVARIANT_STRIKES);
    });

    it('restarts the count when the pair agrees again', () => {
        const plan = new BodyPlan();
        plan.next({targetSize: size(800), windowActorSize: size(800), windowSize: size(800)});
        plan.next({targetSize: size(796), windowActorSize: size(804), windowSize: size(800)});
        expect(plan.settle.pairDisagreementStrikes).toBe(1);

        plan.next({targetSize: size(800), windowActorSize: size(800), windowSize: size(800)});
        expect(plan.settle.pairDisagreementStrikes).toBe(0);
    });

    it('reads a pass with no actor at all as unresolvable rather than throwing', () => {
        const settled = new BodyPlan().next({targetSize: null, windowActorSize: null, windowSize: null});
        expect(settled.body).toBeNull();
        expect(settled.authority).toBeNull();
    });

    it('agrees with the reading it was handed, so a paint settles on the same body a pass did', () => {
        // The pass reads the window's size from its own reading; a paint reads it live. Health means
        // the two agree, so a paint with those same numbers lands on the body the pass recorded.
        const reading = readWindow({
            get_frame_rect: () => ({x: 0, y: 0, ...size(800)}),
            get_buffer_rect: () => ({x: 0, y: 0, ...size(800)}),
        });
        const plan = new BodyPlan();
        const pass = plan.next({
            targetSize: size(800),
            windowActorSize: size(800),
            windowSize: {width: reading.frameWidth, height: reading.frameHeight},
        });
        expect(pass.body).toEqual(size(800));
    });
});
