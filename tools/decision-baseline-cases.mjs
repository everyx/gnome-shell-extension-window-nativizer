#!/usr/bin/env node
/**
 * decision-baseline-cases.mjs - The deterministic corpus behind tools/decision-baseline.json.
 *
 * The decision layer (`evaluateWindowActions`) is about to be reshaped: the ring predicate is
 * unified onto the runtime reading, and the five booleans are replaced by an ownership model.
 * Neither is allowed to change what is drawn, so the corpus is the oracle they are checked
 * against - a case list plus the output the current code produces for it.
 *
 * Two halves. A curated list pins the boundaries the code branches on (the ring kinds that make
 * `insets` null, the minimum decorable size and the minimum band window, every window type the
 * structural gates separate, each reversible axis alone and in combination). A seeded fill then
 * samples the rest of the product so a change nobody thought to curate still shows up. The PRNG
 * is seeded and the fill is a pure function of the seed, so a failure is reproducible and the
 * corpus is a fact rather than an accident of when it ran.
 *
 * Cases carry the shape a window has when it reaches the decision, plus the reading-shaped fields
 * (`clientTypeToken`, `frameRect`, `hasRing`) because the corpus also drives
 * `extractWindowProperties` - the same pairing `Manager` uses to decide and to write a rule. That
 * is deliberate: it pins the picker's key against the runtime's reading, which is exactly where
 * the two currently disagree.
 */

import {WindowType} from '../src/lib/mutterRules.generated.js';
import {hasDeclaredMarginRing} from '../src/lib/frame.js';

/** Base sizes, chosen to straddle the two size gates: MIN_DECORABLE_SIZE (2 x 15) and MIN_BAND_WINDOW (2 x 12). */
export const SIZES = Object.freeze({
    normal: {width: 520, height: 380},
    bandMin: {width: 24, height: 24},
    decorableMin: {width: 30, height: 30},
    tiny: {width: 10, height: 8},
    narrow: {width: 40, height: 300},
});

/**
 * How the buffer and the frame relate, which is the one input the two ring readings disagree on.
 * `null-neg` is a frame shifted past the buffer's left edge and `null-big` one wider than its
 * buffer: both make `insetsFromRects` answer null while the two-sided totals stay positive - the
 * exact shape the corpus exists to pin. `ssd25` is the frame client's ring, which is not the
 * client's own declaration.
 */
export const RINGS = Object.freeze([
    {id: 'none', insets: {left: 0, top: 0, right: 0, bottom: 0}},
    {id: 'csd20', insets: {left: 20, top: 20, right: 20, bottom: 20}},
    {id: 'csd1', insets: {left: 1, top: 1, right: 1, bottom: 1}},
    {id: 'csd-asym', insets: {left: 12, top: 0, right: 4, bottom: 20}},
    {id: 'csd-zero-x', insets: {left: 0, top: 24, right: 0, bottom: 24}},
    {id: 'ssd25', insets: {left: 25, top: 25, right: 25, bottom: 25}, hasSsd: true},
    {id: 'null-neg', insets: null, nullKind: 'neg'},
    {id: 'null-big', insets: null, nullKind: 'big'},
]);

export const SCALES = Object.freeze([1, 1.25, 2]);

/** Every axis state a rule may carry, plus `foreign` for a rule stored against a kind that cannot match. */
export const RULE_STATES = Object.freeze([
    null, 'corners', 'shadow', 'resize',
    'corners,shadow', 'corners,resize', 'shadow,resize', 'corners,shadow,resize',
]);

const WINDOW_TYPES = Object.freeze([
    WindowType.NORMAL, WindowType.DIALOG, WindowType.MODAL_DIALOG, WindowType.UTILITY,
    WindowType.MENU, WindowType.DOCK, WindowType.DESKTOP, WindowType.TOOLBAR,
]);

/** mulberry32: small, fast, deterministic. Same generator as tests/property.test.js. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Geometry for one ring kind. The frame sits inside the buffer for a real ring, past one edge for
 * `null-neg`, and larger than the buffer for `null-big`.
 * @param {{width: number, height: number}} size
 * @param {object} ring
 * @returns {{bufferRect: object, frameRect: object, insets: object|null}}
 */
function geometry(size, ring) {
    const {width: bw, height: bh} = size;
    if (ring.nullKind === 'neg') {
        return {
            bufferRect: {x: 0, y: 0, width: bw, height: bh},
            frameRect: {x: -10, y: 0, width: Math.max(1, bw - 20), height: bh},
            insets: null,
        };
    }
    if (ring.nullKind === 'big') {
        return {
            bufferRect: {x: 0, y: 0, width: bw, height: bh},
            frameRect: {x: 0, y: 0, width: bw + 40, height: bh + 40},
            insets: null,
        };
    }

    const {left, top, right, bottom} = ring.insets;
    return {
        bufferRect: {x: 0, y: 0, width: bw, height: bh},
        frameRect: {
            x: left, y: top,
            width: Math.max(1, bw - left - right),
            height: Math.max(1, bh - top - bottom),
        },
        insets: {...ring.insets},
    };
}

/**
 * One window as it reaches the decision. `hasRing` is what `readWindow` would have put on the
 * reading (the picker's side of the predicate) and is computed by the real predicate;
 * `evaluateWindowActions` ignores it and re-derives the runtime's answer, which is the
 * disagreement this corpus records.
 * @param {object} spec
 * @returns {{label: string, params: object, ruleState: string|null, ruleForeign: boolean}}
 */
function makeCase(spec) {
    const ring = spec.ring;
    const size = spec.size ?? SIZES.normal;
    const {bufferRect, frameRect, insets} = geometry(size, ring);
    const hasSsd = Boolean(spec.hasSsd ?? ring.hasSsd);
    const clientTypeToken = spec.isX11 ? 'x11' : 'wayland';
    const allowsResize = spec.allowsResize !== false;
    const wmClass = spec.wmClass ?? 'demo';

    const params = {
        // Reading-shaped fields: extractWindowProperties() and the picker path read these.
        clientTypeToken,
        bufferRect,
        frameRect,
        declaredWmClass: wmClass,
        hasRing: hasDeclaredMarginRing({buffer: bufferRect, frame: frameRect, hasSsd}),

        // Evaluation fields.
        bufferWidth: bufferRect.width,
        bufferHeight: bufferRect.height,
        frameWidth: frameRect.width,
        frameHeight: frameRect.height,
        insets,
        monitorScale: spec.monitorScale ?? 1,
        isMaximized: Boolean(spec.isMaximized),
        isFullscreen: Boolean(spec.isFullscreen),
        hasSsd,
        isX11: Boolean(spec.isX11),
        nativeLikeCorners: Boolean(spec.nativeLikeCorners),
        hasGtk4Client: Boolean(spec.hasGtk4Client),
        windowType: spec.windowType ?? WindowType.NORMAL,
        hasParent: Boolean(spec.hasParent),
        isAttachedDialog: Boolean(spec.isAttachedDialog),
        allowsResize,
        hasTileMatch: Boolean(spec.hasTileMatch),
        focused: spec.focused !== false,
        tiled: Boolean(spec.tiled),
        highContrast: Boolean(spec.highContrast),
        animationsEnabled: spec.animationsEnabled !== false,
        dark: Boolean(spec.dark),
        wmClass,
        rules: {},
        preferCrispText: Boolean(spec.preferCrispText),
    };

    return {
        label: spec.label,
        params,
        ruleState: spec.ruleState ?? null,
        ruleForeign: Boolean(spec.ruleForeign),
    };
}

const ring = id => RINGS.find(r => r.id === id);

/** Curated boundaries: one entry per branch the decision has, named for the diff it will show. */
function curatedCases() {
    const cases = [];
    const add = (label, spec) => cases.push(makeCase({...spec, label}));

    for (const r of RINGS) {
        add(`ring:${r.id}/plain`, {ring: r});
        add(`ring:${r.id}/x11`, {ring: r, isX11: true});
        add(`ring:${r.id}/native`, {ring: r, nativeLikeCorners: true});
        add(`ring:${r.id}/unresizable`, {ring: r, allowsResize: false});
        add(`ring:${r.id}/maximized`, {ring: r, isMaximized: true});
        add(`ring:${r.id}/fullscreen`, {ring: r, isFullscreen: true});
        add(`ring:${r.id}/tiled`, {ring: r, tiled: true});
        add(`ring:${r.id}/tilematch`, {ring: r, hasTileMatch: true});
        add(`ring:${r.id}/unfocused`, {ring: r, focused: false});
        add(`ring:${r.id}/contrast`, {ring: r, highContrast: true});
        add(`ring:${r.id}/crisp-frac`, {ring: r, preferCrispText: true, monitorScale: 1.25});
        add(`ring:${r.id}/crisp-int`, {ring: r, preferCrispText: true, monitorScale: 2});

        // Each ring kind against every axis a user can reverse, alone and in combination.
        for (const ruleState of RULE_STATES) {
            if (ruleState)
                add(`rules:${r.id}/${ruleState}`, {ring: r, ruleState});
        }
        add(`rules:${r.id}/foreign`, {ring: r, ruleForeign: true});
    }

    // The two size gates, on a taken-over ring and on a bare window.
    for (const sizeName of Object.keys(SIZES)) {
        for (const id of ['none', 'csd20', 'null-neg']) {
            add(`size:${sizeName}/${id}`, {ring: ring(id), size: SIZES[sizeName]});
            add(`size:${sizeName}/${id}/gtk4`, {ring: ring(id), size: SIZES[sizeName], hasGtk4Client: true});
            add(`size:${sizeName}/${id}/resize-rule`, {ring: ring(id), size: SIZES[sizeName], ruleState: 'resize'});
        }
    }

    // Every window type, decorable and not, so the structural gate is pinned on both sides.
    for (const windowType of WINDOW_TYPES) {
        add(`type:${windowType}/bare`, {ring: ring('none'), windowType});
        add(`type:${windowType}/ring`, {ring: ring('csd20'), windowType});
    }

    // GTK4's own handle: the one reading that can retract the band.
    for (const hasGtk4Client of [true, false]) {
        for (const r of RINGS) {
            add(`gtk4:${r.id}/${hasGtk4Client}`, {ring: r, hasGtk4Client});
            add(`gtk4:${r.id}/${hasGtk4Client}/resize-rule`, {ring: r, hasGtk4Client, ruleState: 'resize'});
        }
    }

    // Attached dialogs always have a parent; both attributes ride in the rule key.
    for (const [hasParent, isAttachedDialog] of [[false, false], [true, false], [true, true]]) {
        add(`parent:${hasParent}/${isAttachedDialog}`, {ring: ring('none'), hasParent, isAttachedDialog});
        add(`parent:${hasParent}/${isAttachedDialog}/ring`, {ring: ring('csd20'), hasParent, isAttachedDialog});
        add(`parent:${hasParent}/${isAttachedDialog}/resize-rule`, {ring: ring('none'), hasParent, isAttachedDialog, ruleState: 'resize'});
    }

    // Preferences and the colour scheme, which the style resolver reads rather than the geometry.
    for (const dark of [false, true]) {
        for (const highContrast of [false, true]) {
            for (const focused of [true, false]) {
                add(`style:dark=${dark}/contrast=${highContrast}/focused=${focused}`, {ring: ring('none'), dark, highContrast, focused});
                add(`style:dark=${dark}/contrast=${highContrast}/focused=${focused}/tiled`, {ring: ring('none'), dark, highContrast, focused, tiled: true});
            }
        }
    }

    // A window with no identity at all: the decision still runs, the rule lookup cannot.
    add('identity:none', {ring: ring('none'), wmClass: ''});
    add('identity:none/ring', {ring: ring('csd20'), wmClass: ''});

    return cases;
}

/** The seeded fill: each dimension sampled independently, so combinations the curated list omits still appear. */
function randomCases(count, seed) {
    const rng = mulberry32(seed);
    const pickFrom = xs => xs[Math.floor(rng() * xs.length)];
    const chance = () => rng() < 0.5;
    const cases = [];

    for (let i = 0; i < count; i++) {
        const hasParent = chance();
        const state = pickFrom(RULE_STATES);
        cases.push(makeCase({
            label: `r${String(i).padStart(4, '0')}`,
            ring: pickFrom(RINGS),
            size: pickFrom(Object.values(SIZES)),
            windowType: pickFrom(WINDOW_TYPES),
            monitorScale: pickFrom(SCALES),
            ruleState: state,
            ruleForeign: rng() < 0.1,
            isMaximized: chance(),
            isFullscreen: chance(),
            isX11: chance(),
            nativeLikeCorners: chance(),
            hasGtk4Client: chance(),
            hasParent,
            isAttachedDialog: hasParent && rng() < 0.35,
            allowsResize: rng() < 0.85,
            hasTileMatch: rng() < 0.2,
            focused: rng() < 0.75,
            tiled: rng() < 0.2,
            highContrast: rng() < 0.15,
            dark: chance(),
            animationsEnabled: rng() < 0.9,
            preferCrispText: rng() < 0.2,
        }));
    }
    return cases;
}

/**
 * The corpus, in a stable order: curated first (named), then the seeded fill.
 * @param {object} [options]
 * @param {number} [options.fill=1200]
 * @param {number} [options.seed=0x5eed1a17]
 * @returns {Array<{label: string, params: object, ruleState: string|null, ruleForeign: boolean}>}
 */
export function buildCases({fill = 1200, seed = 0x5eed1a17} = {}) {
    return [...curatedCases(), ...randomCases(fill, seed)];
}
