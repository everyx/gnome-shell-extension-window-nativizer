/**
 * The decoration pass value and the two derivations the cuts read it through. These used to live in
 * WindowDecoration as inline arguments, so they were only observable through a fake effect; here they
 * are pinned directly.
 * Run: pnpm test
 */

import {decorationPass, clipParamsFrom, shadowStyleFrom} from '../src/effects/decorationPass.js';
import {ZERO_INSETS} from '../src/lib/frame.js';

const style = (overrides = {}) => ({
    radius: 12,
    outline: {color: [1, 0, 0], alpha: 1},
    shadows: [{radius: 30}],
    ...overrides,
});

const ring = (overrides = {}) => ({
    insets: {left: 1, top: 2, right: 3, bottom: 4},
    clear: true,
    erase: true,
    ...overrides,
});

describe('clipParamsFrom', () => {
    it('cuts inside the ring the pass is worn with and draws its corner', () => {
        const params = clipParamsFrom(decorationPass({
            style: style(), ring: ring(), drawClip: true, readableScale: 1.5,
            scaleCandidates: [1.5], scale: 1.5,
        }));
        expect(params).toEqual({
            insets: {left: 1, top: 2, right: 3, bottom: 4},
            radius: 12,
            outline: {color: [1, 0, 0], alpha: 1},
            erase: true,
            clearStroke: true,
            scale: 1.5,
            scaleCandidates: [1.5],
        });
    });

    it('states radius 0 and no outline for a pass that draws nothing', () => {
        const params = clipParamsFrom(decorationPass({style: style(), ring: ring(), drawClip: false}));
        expect(params.radius).toBe(0);
        expect(params.outline).toBeNull();
    });

    it('suppresses the outline and the stroke while the overview is open', () => {
        const params = clipParamsFrom(decorationPass({
            style: style(), ring: ring(), drawClip: true, inOverview: true,
        }));
        expect(params.outline).toBeNull();
        expect(params.clearStroke).toBeFalse();
        // The corner itself is still drawn: only the outline and the stroke are the overview's business.
        expect(params.radius).toBe(12);
        expect(params.erase).toBeTrue();
    });

    it('hands the clip the readable scale, not the substituted one', () => {
        // An unreadable pass substitutes 1.0 to lay out with, but the clip must abstain rather than cut
        // a fractional display at a fabricated scale.
        const params = clipParamsFrom(decorationPass({
            style: style(), ring: ring(), drawClip: true, scale: 1.0, readableScale: null,
        }));
        expect(params.scale).toBeNull();
    });

    it('answers the default insets for a pass that never resolved a ring', () => {
        const params = clipParamsFrom(decorationPass({style: style(), drawClip: true}));
        expect(params.insets).toBe(ZERO_INSETS);
        expect(params.erase).toBeFalse();
    });
});

describe('shadowStyleFrom', () => {
    it('wears the corner the clip draws', () => {
        const worn = shadowStyleFrom(decorationPass({style: style(), ring: ring(), drawClip: true}));
        expect(worn.radius).toBe(12);
        expect(worn.shadows).toEqual([{radius: 30}]);
    });

    it('is the square shadow when the pass clips nothing', () => {
        const worn = shadowStyleFrom(decorationPass({style: style(), ring: ring(), drawClip: false}));
        expect(worn.radius).toBe(0);
        // The rest of the resolved style still travels: only the radius follows the clip.
        expect(worn.outline).toEqual({color: [1, 0, 0], alpha: 1});
    });

    it('keeps the resolved style object intact for the effect that owns it', () => {
        const resolved = style();
        const worn = shadowStyleFrom(decorationPass({style: resolved, drawClip: true}));
        expect(worn).not.toBe(resolved);
        expect(resolved.radius).toBe(12);
    });
});
