#!/usr/bin/env node
/**
 * gen-style.mjs - Extracts window.csd decoration parameters from vendored libadwaita SCSS,
 * generating src/lib/adwaitaStyle.generated.js.
 *
 * Design: narrow parser + assertions. Only recognizes specific file/block/variable chains,
 * rather than implementing a generic SCSS parser.
 * If upstream format changes break any assertion, this script immediately errors out (never emits bad data).
 *
 * Usage: node tools/gen-style.mjs [--check]
 *   --check: Only verifies generated results match existing adwaitaStyle.generated.js (used in CI), exits with 1 if mismatch.
 */

import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor', 'libadwaita');
const OUT = path.join(ROOT, 'src', 'lib', 'adwaitaStyle.generated.js');

const CHECK = process.argv.includes('--check');

// ---------- Narrow Parser ----------

function read(name) {
    const p = path.join(VENDOR, name);
    if (!existsSync(p))
        throw new Error(`[gen-style] Missing vendor file: ${name} (vendor upstream first)`);
    return readFileSync(p, 'utf8');
}

/** Extract SCSS variable definition `$name: value;` */
function parseVar(scss, name) {
    const re = new RegExp(`\\$${name}\\s*:\\s*([^;]+);`);
    const m = scss.match(re);
    if (!m) throw new Error(`[gen-style] Assertion failed: variable not found $${name}`);
    return m[1].trim();
}

/** Evaluate percentage literal: `15%` */
function parsePercent(expr) {
    const m = expr.match(/^(\d+(?:\.\d+)?)%$/);
    if (!m)
        throw new Error(`[gen-style] Assertion failed: cannot evaluate percentage "${expr}"`);
    return +m[1] / 100;
}

/** Evaluate px expression: `9px`, `9px + 6`, `$button_radius + 6` */
function evalPx(expr, vars = {}) {
    const resolved = expr.replace(/\$([a-z0-9_]+)/g, (_, n) => vars[n] ?? '');
    const single = resolved.match(/^\s*(-?\d+(?:\.\d+)?)\s*px\s*$/);
    if (single) return parseFloat(single[1]);
    const sum = resolved.match(/^\s*(-?\d+(?:\.\d+)?)\s*px\s*\+\s*(\d+(?:\.\d+)?)\s*$/);
    if (sum) return parseFloat(sum[1]) + parseFloat(sum[2]);
    throw new Error(`[gen-style] Assertion failed: cannot evaluate px expression "${expr}"`);
}

/** Parse box-shadow declaration -> [{blur, spread, alpha}] (outer to inner) */
function parseBoxShadow(decl) {
    const layers = decl.replace(/\/\*.*?\*\//gs, '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    if (layers.length === 0)
        throw new Error('[gen-style] Assertion failed: box-shadow is empty');
    return layers.map(layer => {
        // backdrop first layer may be `... transparent` (keeps extents to prevent jitter)
        const transparent = /^0\s+0\s+(?:(?:(\d+(?:\.\d+)?)px)|0)\s+(\d+(?:\.\d+)?)px\s+transparent$/;
        const tm = layer.match(transparent);
        if (tm)
            return {blur: tm[1] ? parseInt(tm[1]) : 0, spread: parseFloat(tm[2]), alpha: 0};
        // When color is an SCSS variable (e.g. $border_color): retain spread semantics, alpha/outline handled in shader
        const vm = layer.match(/^0\s+0\s+(?:(?:(\d+(?:\.\d+)?)px)|0)\s+(\d+(?:\.\d+)?)px\s+\$([a-z0-9_]+)$/);
        if (vm)
            return {blur: vm[1] ? parseInt(vm[1]) : 0, spread: parseFloat(vm[2]), colorVar: vm[3]};
        // Format: 0 0 [blur] spreadpx RGB(0 0 0 / NN%)
        const m = layer.match(/^0\s+0\s+(?:(?:(\d+(?:\.\d+)?)px)|0)\s+(\d+(?:\.\d+)?)px\s+RGB\(\s*0\s+0\s+0\s*\/\s*(\d+)%\s*\)$/);
        if (!m)
            throw new Error(`[gen-style] Assertion failed: cannot parse box-shadow layer "${layer}"`);
        const blur = m[1] ? parseInt(m[1]) : 0;
        const spread = parseFloat(m[2]);
        return {blur, spread, alpha: parseInt(m[3]) / 100};
    });
}

/** Extract block content starting at `selector` (balanced braces) */
function extractBlock(scss, selector) {
    const idx = scss.indexOf(selector);
    if (idx < 0) throw new Error(`[gen-style] Assertion failed: block not found ${selector}`);
    const open = scss.indexOf('{', idx);
    let depth = 0;
    for (let i = open; i < scss.length; i++) {
        if (scss[i] === '{') depth++;
        else if (scss[i] === '}') {
            depth--;
            if (depth === 0) return scss.slice(open + 1, i);
        }
    }
    throw new Error(`[gen-style] Assertion failed: unclosed braces in block ${selector}`);
}

/** Extract property value `prop: value;` from block (first match) */
function propIn(block, prop) {
    const re = new RegExp(`${prop}\\s*:\\s*([^;]+);`);
    const m = block.match(re);
    if (!m) throw new Error(`[gen-style] Assertion failed: property not found in block: ${prop}`);
    return m[1].trim();
}

// ---------- Main Flow ----------

const common = read('_common.scss');
const colorsScss = read('_colors.scss');
const windowScss = read('_window.scss');

// 1. Radius: --window-radius = $button_radius + 6
const buttonRadius = evalPx(parseVar(common, 'button_radius'));
const radiusDecl = common.match(/--window-radius:\s*#\{\s*(\$button_radius\s*\+\s*\d+)\s*\}/);
if (!radiusDecl)
    throw new Error('[gen-style] Assertion failed: cannot find --window-radius: #{$button_radius + N}');
const radius = evalPx(radiusDecl[1], {button_radius: `${buttonRadius}px`});

// 2. window.csd main shadows
const csdBlock = extractBlock(windowScss, '&.csd');
const shadows = parseBoxShadow(propIn(csdBlock, 'box-shadow'));

// 3. backdrop: shadows fade but extents remain unchanged
const backdropBlock = extractBlock(csdBlock, '&:backdrop');
const backdropShadows = parseBoxShadow(propIn(backdropBlock, 'box-shadow'));

// 4. tiled: radius becomes 0 + 1px outline
const tiledBlock = extractBlock(csdBlock, '&.tiled,');
const tiledShadows = parseBoxShadow(propIn(tiledBlock, 'box-shadow'))
    // Filter libadwaita transparent control workaround layer (-- #3670, meaningless in shader)
    .filter(s => !(s.blur === 0 && s.spread >= 10 && (s.alpha === 0 || s.colorVar)));

// 5. High contrast: full shadow set replacement (outline darkened to 80%), backdrop also has HC variant
const hcBlock = extractBlock(csdBlock, '@media (prefers-contrast: more)');
const hcShadows = parseBoxShadow(propIn(hcBlock, 'box-shadow'));
const hcBackdropBlock = extractBlock(backdropBlock, '@media (prefers-contrast: more)');
const hcBackdropShadows = parseBoxShadow(propIn(hcBackdropBlock, 'box-shadow'));

// 6. Border opacity (tiled $border_color dynamic color staticized: color is pure black, opacity from upstream)
const borderOpacity = parsePercent(parseVar(colorsScss, 'border_opacity'));

// 7. Window outline color (libadwaita paints 1px light edge outside window; HC deepens to 30%)
function parseStaticColor(decl) {
    const m = decl.match(/RGB\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*(\d+)%\s*\)/);
    if (!m)
        throw new Error(`[gen-style] Assertion failed: cannot parse static color "${decl}"`);
    return {color: [+m[1], +m[2], +m[3]], alpha: +m[4] / 100};
}
const outlineColor = parseStaticColor(parseVar(colorsScss, 'window_outline_color'));
const outlineColorHc = parseStaticColor(parseVar(colorsScss, 'window_outline_color_hc'));

// 8. Backdrop transition: the `&:backdrop` box-shadow fade in window.csd is `$backdrop_transition`.
//    The curve is a CSS keyword (CSS Easing Functions Level 1), resolved to cubic-bezier control points.
const CSS_EASING = {
    'linear': [0, 0, 1, 1],
    'ease': [0.25, 0.1, 0.25, 1],
    'ease-in': [0.42, 0, 1, 1],
    'ease-out': [0, 0, 0.58, 1],
    'ease-in-out': [0.42, 0, 0.58, 1],
};
const backdropTransition = parseVar(common, 'backdrop_transition');
const transitionMatch = backdropTransition.match(/^(\d+(?:\.\d+)?)ms\s+([a-z-]+)$/);
if (!transitionMatch)
    throw new Error(`[gen-style] Assertion failed: cannot parse $backdrop_transition "${backdropTransition}"`);
const durationMs = +transitionMatch[1];
const easingName = transitionMatch[2];
const easing = CSS_EASING[easingName];
if (!easing)
    throw new Error(`[gen-style] Assertion failed: unknown CSS easing keyword "${easingName}"`);

// 9. Shadow bake padding: the farthest Gaussian reach over every generated layer.
//    The shader uses `sigma = 0.5 * blur` (GTK4 GSK `_sigma = GSK_GLOBAL_SCALE * 0.5 * blur_radius`)
//    and truncates at ~3 sigma (gskgpuboxshadow.glsl `blur_corner`), so a layer reaches
//    `3 * 0.5 * blur + spread`. Plus the Cogl/Clutter offscreen top-left offset
//    (`_clutter_actor_box_enlarge_for_effects`, see gen-shader.mjs FBO_OFFSET).
const COGL_FBO_OFFSET = 2;
const allShadowLayers = [...shadows, ...backdropShadows, ...hcShadows, ...hcBackdropShadows, ...tiledShadows];
const shadowReach = Math.max(...allShadowLayers.map(s => 3 * (0.5 * s.blur) + s.spread));
const shadowPad = Math.ceil(shadowReach) + COGL_FBO_OFFSET;

// ---------- Assertions (prevent corrupted data) ----------

if (radius < 4 || radius > 40)
    throw new Error(`[gen-style] Assertion failed: unexpected radius ${radius}`);
if (shadows.length < 2 || shadows.length > 4)
    throw new Error(`[gen-style] Assertion failed: unexpected shadows count ${shadows.length}`);
if (backdropShadows[0].alpha > 0.05)
    throw new Error('[gen-style] Assertion failed: backdrop first layer should be transparent (prevent jitter)');
if (tiledShadows[0].blur !== 0 || tiledShadows[0].spread !== 1)
    throw new Error('[gen-style] Assertion failed: tiled should be 1px outline');

if (hcShadows.find(s => s.spread === 1)?.alpha == null)
    throw new Error('[gen-style] Assertion failed: HC block missing outline layer');
if (hcShadows.find(s => s.spread === 1)?.alpha < 0.5)
    throw new Error('[gen-style] Assertion failed: HC outline should be >= 80%, got ' + hcShadows.find(s => s.spread === 1)?.alpha);
if (durationMs <= 0 || durationMs > 2000)
    throw new Error(`[gen-style] Assertion failed: unexpected transition duration ${durationMs}ms`);
if (shadowPad < 1 || shadowPad > 64)
    throw new Error(`[gen-style] Assertion failed: unexpected shadow bake padding ${shadowPad}px`);

// ---------- Serialization ----------

function fmtShadows(list) {
    return list.map(s => {
        const parts = [`blur: ${s.blur}`, `spread: ${s.spread}`];
        if (s.colorVar) {
            parts.push(`colorVar: '${s.colorVar}'`);
        } else {
            parts.push(`alpha: ${s.alpha}`);
        }
        return `{${parts.join(', ')}}`;
    }).join(', ');
}

function fmtColor(c) {
    return `{color: [${c.color.join(', ')}], alpha: ${c.alpha}}`;
}

const commit = read('COMMIT').trim();
const js = `/**
 * GNOME native window decoration style (**Generated file, do not edit directly**).
 *
 * Source: upstream libadwaita (vendor/libadwaita/COMMIT = ${commit})
 * Generated by: node tools/gen-style.mjs
 * State coverage = full libadwaita window.csd state machine:
 *   focused / backdrop, maximized / fullscreen, tiled, high contrast
 *
 * transition: libadwaita \`_common.scss\` \`$backdrop_transition\` = "${backdropTransition}"
 *   (the \`&:backdrop\` box-shadow fade in \`_window.scss\`); the CSS easing keyword is
 *   resolved to its cubic-bezier control points.
 * shadowPad: derived, not upstream - the farthest layer Gaussian reach over every
 *   shadow set below (\`3 * 0.5 * blur + spread\`) plus the Cogl offscreen offset.
 */

export const ADWAITA_STYLE = {
    window: {
        radius: ${radius},
        shadows: [${fmtShadows(shadows)}],
        backdrop: {
            radius: ${radius},
            shadows: [${fmtShadows(backdropShadows)}],
        },
        highContrast: {
            shadows: [${fmtShadows(hcShadows)}],
            backdropShadows: [${fmtShadows(hcBackdropShadows)}],
        },
        tiled: {
            radius: 0,
            shadows: [{blur: 0, spread: 1, alpha: ${borderOpacity}}],
        },
        maximized: {radius: 0, shadows: []},
        fullscreen: {radius: 0, shadows: []},
        outline: {
            normal: ${fmtColor(outlineColor)},
            highContrast: ${fmtColor(outlineColorHc)},
        },
    },
    shadowPad: ${shadowPad},
    transition: {durationMs: ${durationMs}, easing: [${easing.join(', ')}]},
};
`;

// ---------- Output ----------

if (CHECK) {
    const old = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (old !== js) {
        console.error('[gen-style] --check failed: adwaitaStyle.generated.js does not match upstream, please run node tools/gen-style.mjs');
        process.exit(1);
    }
    console.log(`[gen-style] OK: adwaitaStyle.generated.js matches upstream (commit ${commit})`);
} else {
    writeFileSync(OUT, js);
    console.log(`[gen-style] Generated ${OUT} (radius=${radius}px, shadows=${shadows.length} layers, commit ${commit})`);
}
