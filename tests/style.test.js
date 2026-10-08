/**
 * style state machine unit tests: maps a window state onto a libadwaita style entry.
 *
 * Every expectation is written against the generated ADWAITA_STYLE, never as a
 * copy of its numbers. tools/gen-style.mjs already pins that file to upstream, so
 * repeating the numbers here would only block upstream changes the code absorbs
 * anyway - the layers we draw are whatever the generated file says. What is worth
 * asserting is our own share: which state selects which entry, and the outline we
 * drop for the square states.
 */

import {pipelineOpacityFor, styleForWindow} from '../src/lib/style.js';
import {ADWAITA_STYLE} from '../src/lib/adwaitaStyle.generated.js';

describe('styleForWindow', () => {
    const base = {focused: true, maximized: false, fullscreen: false, tiled: false, highContrast: false};
    const {window: w} = ADWAITA_STYLE;

    it('focused -> the window entry and the normal outline', () => {
        expect(styleForWindow(base)).toEqual({
            radius: w.radius,
            shadows: w.shadows,
            animate: w.animate,
            outline: w.outline.normal,
        });
    });

    it('unfocused -> the backdrop entry, same outline source', () => {
        expect(styleForWindow({...base, focused: false})).toEqual({
            radius: w.backdrop.radius,
            shadows: w.backdrop.shadows,
            animate: w.backdrop.animate,
            outline: w.outline.normal,
        });
    });

    it('tiled -> the tiled entry, without an outline', () => {
        expect(styleForWindow({...base, tiled: true})).toEqual({
            ...w.tiled,
            outline: null,
            shadows: w.tiled.shadows.map(layer => ({...layer, color: [0, 0, 0]})),
        });
    });

    it('tiled border takes its colour from the colour scheme, as a layer colour', () => {
        // Upstream's border colour is currentColor - the client's foreground, which the compositor
        // cannot see - so the system scheme is the closest honest signal. It travels on the shadow
        // layer, which is upstream's own model: the tiled rule is a box-shadow with a colour.
        expect(styleForWindow({...base, tiled: true, dark: true}).shadows[0].color).toEqual([255, 255, 255]);
        expect(styleForWindow({...base, tiled: true, dark: false}).shadows[0].color).toEqual([0, 0, 0]);
        expect(styleForWindow({...base, tiled: true}).shadows.length).toBe(1);
        // And no shadow layer of a normal window carries one: they are all black.
        expect(styleForWindow(base).shadows.every(layer => layer.color === undefined)).toBeTrue();
    });

    it('maximized -> the maximized entry, without an outline', () => {
        expect(styleForWindow({...base, maximized: true})).toEqual({...w.maximized, outline: null});
    });

    it('fullscreen -> the fullscreen entry, without an outline', () => {
        expect(styleForWindow({...base, fullscreen: true})).toEqual({...w.fullscreen, outline: null});
    });

    it('high contrast -> the HC shadow set, keeping the ordinary outline source', () => {
        expect(styleForWindow({...base, highContrast: true})).toEqual({
            radius: w.radius,
            shadows: w.highContrast.shadows,
            animate: w.animate,
            outline: w.outline.highContrast,
        });
    });

    it('high contrast, unfocused -> the HC backdrop shadow set', () => {
        expect(styleForWindow({...base, highContrast: true, focused: false})).toEqual({
            radius: w.backdrop.radius,
            shadows: w.highContrast.backdropShadows,
            animate: w.backdrop.animate,
            outline: w.outline.highContrast,
        });
    });

    it('suppresses the one transition when animations are off', () => {
        // GTK gives a CSS transition no frame clock when `gtk-enable-animations` is false, so a
        // native window snaps in every direction. The generated flag still says backdrop animates;
        // the setting is what takes it away. The positive case is the generated value, not a literal
        // repeated here - only the suppression is this spec's own fact.
        expect(styleForWindow({...base, focused: false, animationsEnabled: false}).animate).toBeFalse();
        expect(styleForWindow({...base, focused: false, animationsEnabled: true}).animate).toBe(w.backdrop.animate);
    });

    it('maximized wins over tiled', () => {
        // The only precedence pair whose output differs, because the tiled entry
        // keeps a border layer the maximized one does not.
        expect(styleForWindow({...base, maximized: true, tiled: true}))
            .toEqual({...w.maximized, outline: null});
    });
});

describe('pipelineOpacityFor', () => {
    it('returns base opacity when paint opacity is 1', () => {
        expect(pipelineOpacityFor(1, 1)).toBe(1);
        expect(pipelineOpacityFor(0.8, 1)).toBeCloseTo(0.8, 5);
        expect(pipelineOpacityFor(0, 1)).toBe(0);
    });

    it('modulates base opacity by fractional paint opacity', () => {
        expect(pipelineOpacityFor(1, 0.5)).toBeCloseTo(0.5, 5);
        expect(pipelineOpacityFor(0.8, 0.5)).toBeCloseTo(0.4, 5);
        expect(pipelineOpacityFor(0.5, 0.25)).toBeCloseTo(0.125, 5);
    });

    it('returns 0 when paint opacity is 0 or negative (culling / invisible)', () => {
        expect(pipelineOpacityFor(1, 0)).toBe(0);
        expect(pipelineOpacityFor(0.5, -0.1)).toBe(0);
        expect(pipelineOpacityFor(0, 0)).toBe(0);
    });

    it('clamps inputs to [0, 1]', () => {
        expect(pipelineOpacityFor(1.5, 1.5)).toBe(1);
        expect(pipelineOpacityFor(-0.5, 0.8)).toBe(0);
    });
});

