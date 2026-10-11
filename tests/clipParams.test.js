/**
 * RoundedClipEffect upload-decision unit tests (jasmine-gjs).
 * Run: pnpm test
 */

import {clipGeometryChanges, clipParamChanges, outlineVector} from '../src/effects/clipParams.js';

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
