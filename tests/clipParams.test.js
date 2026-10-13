/**
 * RoundedClipEffect upload-decision unit tests (jasmine-gjs).
 * Run: pnpm test
 */

import {clipGeometryChanges, clipParamChanges, outlineVector, resolveClipSize} from '../src/effects/clipParams.js';

const insets = (left, top, right, bottom) => ({left, top, right, bottom});

/** @returns {object} A cached params state built from raw setParams arguments */
function state({inset = insets(0, 0, 0, 0), radius = 8, outline = null,
    erase = false, clearStroke = false, scale = 1.0} = {}) {
    return {
        insets: inset,
        radius,
        outline: outlineVector(outline),
        erase,
        clearStroke,
        scale,
    };
}

/** @returns {object} A setParams call payload */
function params({inset = insets(0, 0, 0, 0), radius = 8, outline = null,
    erase = false, clearStroke = false, scale = 1.0} = {}) {
    return {insets: inset, radius, outline, erase, clearStroke, scale};
}

describe('clipParamChanges', () => {
    it('changes nothing for an identical call, so setParams does not repaint', () => {
        const changes = clipParamChanges(state(), params());
        expect(changes.changed).toBe(false);
        expect(changes.scale).toBeUndefined();
        expect(changes.radius).toBeUndefined();
        expect(changes.outline).toBeUndefined();
        expect(changes.erase).toBeUndefined();
        expect(changes.clearStroke).toBeUndefined();
        expect(changes.frame).toBeUndefined();
    });

    it('reports only the radius when the radius moves', () => {
        const changes = clipParamChanges(state({radius: 8}), params({radius: 12}));
        expect(changes.changed).toBe(true);
        expect(changes.radius).toBe(12);
        expect(changes.scale).toBeUndefined();
        expect(changes.outline).toBeUndefined();
        expect(changes.erase).toBeUndefined();
        expect(changes.clearStroke).toBeUndefined();
        expect(changes.frame).toBeUndefined();
    });

    it('invalidates the cached frame when the insets move', () => {
        const changes = clipParamChanges(state(), params({inset: insets(1, 2, 3, 4)}));
        expect(changes.changed).toBe(true);
        expect(changes.frame).toBe(true);
        expect(changes.radius).toBeUndefined();
        expect(changes.scale).toBeUndefined();
    });

    it('reports every decision from a null previous', () => {
        const changes = clipParamChanges(null, params({
            inset: insets(1, 2, 3, 4), radius: 14, outline: {color: [255, 0, 0], alpha: 0.5},
            erase: true, clearStroke: true, scale: 2,
        }));
        expect(changes.changed).toBe(true);
        expect(changes.scale).toBe(2);
        expect(changes.radius).toBe(14);
        expect(changes.outline).toEqual([1, 0, 0, 0.5]);
        expect(changes.erase).toBe(true);
        expect(changes.clearStroke).toBe(true);
        expect(changes.frame).toBe(true);
    });

    it('normalizes an outline against the cached vec4, not the raw object', () => {
        const cached = state({outline: {color: [255, 128, 0], alpha: 0.25}});
        expect(cached.outline).toEqual([1, 128 / 255, 0, 0.25]);
        expect(clipParamChanges(cached, params({outline: {color: [1, 128 / 255, 0], alpha: 0.25}})).outline)
            .toBeUndefined();
        expect(clipParamChanges(cached, params({outline: {color: [1, 0.5, 0], alpha: 0.25}})).outline)
            .toEqual([1, 0.5, 0, 0.25]);
    });

    it('leaves an invalid scale out of the decisions', () => {
        expect(clipParamChanges(state({scale: 1}), params({scale: 0})).changed).toBe(false);
        expect(clipParamChanges(state({scale: 1}), params({scale: Number.NaN})).changed).toBe(false);
    });
});

describe('resolveClipSize', () => {
    it('prefers the target read while it is usable', () => {
        expect(resolveClipSize({width: 825, height: 960}, {width: 825, height: 960}))
            .toEqual({width: 825, height: 960});
        expect(resolveClipSize({width: 800, height: 600}, {width: 825, height: 960}))
            .toEqual({width: 800, height: 600});
    });

    it('falls back to the window actor when the target read is not usable', () => {
        // The Wayland surface container at 0x0 while the window actor is healthy: the container's
        // surface child still paints at full size, so the window actor is the authority.
        expect(resolveClipSize({width: 0, height: 0}, {width: 825, height: 960}))
            .toEqual({width: 825, height: 960});
        expect(resolveClipSize({width: 0, height: 960}, {width: 825, height: 960}))
            .toEqual({width: 825, height: 960});
        expect(resolveClipSize({width: 825, height: -1}, {width: 825, height: 960}))
            .toEqual({width: 825, height: 960});
    });

    it('is degenerate only when neither the target nor the window actor has an extent', () => {
        expect(resolveClipSize({width: 0, height: 0}, {width: 0, height: 0})).toBeNull();
        expect(resolveClipSize(null, null)).toBeNull();
        expect(resolveClipSize({width: 0, height: 0}, undefined)).toBeNull();
    });

    it('holds one verdict across successive paints for a healthy window, whatever the target reads', () => {
        const windowActor = {width: 825, height: 960};
        // The container's allocation read flaps 0 -> real -> 0 across paints (a buffer swap while
        // opening, a lagging layout during a drag). The resolved size must not follow the unusable
        // reads, so the clip neither suspends nor re-enables per paint.
        for (const targetRead of [0, 825, 0, 0, 825]) {
            const size = resolveClipSize(
                {width: targetRead, height: targetRead ? 960 : 0}, windowActor);
            expect(size).withContext(`target read ${targetRead}`).toEqual({width: 825, height: 960});
        }
    });
});

describe('clipGeometryChanges', () => {
    const frame = (x, y, width, height) => ({x, y, width, height});

    it('reports nothing when the size and frame are unchanged', () => {
        const prev = {scale: 1, width: 800, height: 600, frame: frame(0, 0, 800, 600)};
        expect(clipGeometryChanges(prev, {scale: 1, width: 800, height: 600, frame: frame(0, 0, 800, 600)}))
            .toEqual({});
    });

    it('reports the frame alone when an inset invalidation changed its width', () => {
        const prev = {scale: 1, width: 800, height: 600, frame: frame(0, 0, -1, 600)};
        const changes = clipGeometryChanges(prev, {scale: 1, width: 800, height: 600, frame: frame(0, 0, 780, 600)});
        expect(changes.frame).toEqual([0, 0, 780, 600]);
        expect(changes.scale).toBeUndefined();
        expect(changes.size).toBeUndefined();
    });

    it('reports scale and size independently of the frame', () => {
        const prev = {scale: 1, width: 800, height: 600, frame: frame(0, 0, 800, 600)};
        const changes = clipGeometryChanges(prev, {scale: 2, width: 810, height: 600, frame: frame(0, 0, 800, 600)});
        expect(changes.scale).toBe(2);
        expect(changes.size).toEqual([810, 600]);
        expect(changes.frame).toBeUndefined();
    });
});
