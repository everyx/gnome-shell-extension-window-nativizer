#!/usr/bin/env node
/**
 * gen-shader.mjs - Extracts GTK4 native 2D analytic Gaussian box shadow
 * GLSL algorithms from vendor/gtk/gskgpuboxshadow.glsl to generate
 * src/effects/shadowShader.generated.js.
 *
 * Design: Narrow parser with assertions. Matches exact function signatures
 * and blocks, failing fast if upstream changes break expectations.
 *
 * Usage: node tools/gen-shader.mjs [--check]
 *   --check: Verifies generated file matches upstream (for CI), exits 1 if mismatch.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { EFFECT_PADDING_ORIGIN, EFFECT_PADDING_EXTRA } from '../src/lib/clutterEffectPadding.generated.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GTK_VENDOR = path.join(ROOT, 'vendor', 'gtk');
const SHADER_SRC = path.join(GTK_VENDOR, 'gskgpuboxshadow.glsl');
const COMMIT_FILE = path.join(GTK_VENDOR, 'COMMIT');
const OUT_FILE = path.join(ROOT, 'src', 'effects', 'shadowShader.generated.js');

const CHECK = process.argv.includes('--check');

if (!existsSync(SHADER_SRC)) {
    throw new Error(`[gen-shader] Missing vendor file: ${SHADER_SRC}`);
}
const commit = existsSync(COMMIT_FILE) ? readFileSync(COMMIT_FILE, 'utf8').trim() : 'unknown';
const rawGlsl = readFileSync(SHADER_SRC, 'utf8');

// Extracts a C/GLSL function block from signature to balanced closing brace.
function extractFunction(source, signature) {
    const idx = source.indexOf(signature);
    if (idx < 0) {
        throw new Error(`[gen-shader] Assertion failed: cannot find function ${signature}`);
    }
    const open = source.indexOf('{', idx);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) {
                return source.slice(idx, i + 1).trim();
            }
        }
    }
    throw new Error(`[gen-shader] Assertion failed: unclosed brace in ${signature}`);
}

// 1. Extract GTK core Gaussian math functions
const gaussFn = extractFunction(rawGlsl, 'float\ngauss');
const erfFn = extractFunction(rawGlsl, 'vec2\nerf');
const erfRangeFn = extractFunction(rawGlsl, 'float\nerf_range');
const ellipseXFn = extractFunction(rawGlsl, 'float\nellipse_x');
let blurCornerFn = extractFunction(rawGlsl, 'float\nblur_corner');

// Adaptation: GTK uses global uniform `_sigma`, while multi-layer blending requires layer-specific sigma.
blurCornerFn = blurCornerFn
    .replace('float\nblur_corner (vec2 p,\n             vec2 r)', 'float\nblur_corner (vec2 p,\n             vec2 r,\n             float sigma)')
    .replaceAll('_sigma', 'sigma');

// Validate extracted contents
if (!gaussFn.includes('exp') || !erfFn.includes('0.278393') || !blurCornerFn.includes('for (int i = 0; i < 8; i++)')) {
    throw new Error('[gen-shader] Assertion failed: extracted Gaussian functions do not match expectations');
}

// 2. Assemble Cogl Fragment Shader snippets
const header = `/**
 * GTK4 GSK native 2D analytic Gaussian box shadow shader (**Generated file, do not edit**).
 *
 * Source: GTK4 upstream (vendor/gtk/COMMIT = ${commit})
 * Original: gsk/gpu/shaders/gskgpuboxshadow.glsl
 * Generator: node tools/gen-shader.mjs
 */
`;

const declarations = `
uniform vec2 uWinSize;      // Window size (px)
uniform float uRadius;       // Window corner radius (px)
uniform vec4 uShadow1;      // (blur, spread, alpha, 0)
uniform vec4 uShadow2;
uniform vec4 uShadow3;      // Outline layer (blur=0)
uniform vec2 uPad;          // Shadow actor padding per side (px)

const float PI = 3.141592653589793;
const float SQRT1_2 = 0.7071067811865475;

// ClutterOffscreenEffect (_clutter_actor_box_enlarge_for_effects, gen-clutter.mjs)
// Offsets 2px top-left to avoid subpixel jitter, adds 3px in total size
const vec2 FBO_OFFSET = vec2(${EFFECT_PADDING_ORIGIN.toFixed(1)}, ${EFFECT_PADDING_ORIGIN.toFixed(1)});
const vec2 FBO_EXTRA  = vec2(${EFFECT_PADDING_EXTRA.toFixed(1)}, ${EFFECT_PADDING_EXTRA.toFixed(1)});

// --- GTK4 native 2D analytic Gaussian convolution kernel ---

${gaussFn}

${erfFn}

${erfRangeFn}

${ellipseXFn}

float blur_rect(vec4 r, vec2 pos, float sigma) {
    return erf_range(r.xz - pos.x, sigma) * erf_range(r.yw - pos.y, sigma);
}

${blurCornerFn}

float blur_rounded_rect(vec4 r, float radius, vec2 p, float sigma) {
    float result = blur_rect(r, p, sigma);
    if (radius <= 0.0)
        return max(result, 0.0);

    vec2 cr = vec2(radius);
    result -= blur_corner(p - r.xy, cr, sigma);
    result -= blur_corner(vec2(r.z - p.x, p.y - r.y), cr, sigma);
    result -= blur_corner(r.zw - p, cr, sigma);
    result -= blur_corner(vec2(p.x - r.x, r.w - p.y), cr, sigma);

    return max(result, 0.0);
}

// SDF rounded box distance (for unblurred outline layer where blur < 0.5)
float sdRoundedBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float evalShadowLayer(vec4 s, vec2 p, vec2 winOrigin, vec2 winSize, float radius, float d) {
    if (s.z <= 0.0)
        return 0.0;
    float blur = s.x;
    float spread = s.y;
    float alpha = s.z;

    if (blur < 0.5) {
        // 1px crisp hollow outset border band between window boundary (d=0) and spread
        float inner = clamp(d + 0.5, 0.0, 1.0);
        float outer = clamp(d - spread + 0.5, 0.0, 1.0);
        return alpha * max(inner - outer, 0.0);
    }

    vec4 bounds = vec4(winOrigin - vec2(spread), winOrigin + winSize + vec2(spread));
    float effRadius = max(radius + spread, 0.0);
    float sigma = 0.5 * blur;
    return alpha * blur_rounded_rect(bounds, effRadius, p, sigma);
}
`;

/**
 * Subpixel conservative overlap margin aligned with GTK4 GSK_RECT_SNAP_GROW (in logical px).
 *
 * Physical rationale:
 * Under fractional scaling (e.g. 1.25x / 1.5x / 1.75x), window actor and shadow actor
 * undergo independent matrix transformations, creating up to 1 physical pixel phase difference
 * between GPU rasterization tests and Shader UV interpolation.
 * Injecting a 0.8px overlap ensures shadow cutout extends inward beneath the window frame,
 * absorbing subpixel rounding jitter and eliminating 1px bright gaps during window drag.
 */
const SNAP_BLEED = 0.8;

const code = `
    // Early discard if actor is fully transparent (e.g. at open/close animation bounds)
    if (cogl_color_in.a <= 0.0) {
        cogl_color_out = vec4(0.0);
        return;
    }

    vec2 halfSize = uWinSize * 0.5;
    vec2 quadSize = uWinSize + uPad * 2.0 + FBO_EXTRA;
    vec2 winOrigin = uPad + FBO_OFFSET;
    vec2 c = winOrigin + halfSize;
    vec2 p = cogl_tex_coord0_in.xy * quadSize;
    float d = sdRoundedBox(p - c, halfSize, uRadius);

    // Aligned with GTK4 GSK_RECT_SNAP_GROW philosophy: conservative overlap (SNAP_BLEED = ${SNAP_BLEED.toFixed(1)})
    // Extends shadow under window base to eliminate 1px bright gaps under fractional scaling.
    float clipAlpha = clamp(d + 0.5 + ${SNAP_BLEED.toFixed(1)}, 0.0, 1.0);
    if (clipAlpha <= 0.0) {
        cogl_color_out = vec4(0.0);
        return;
    }

    // Alpha-over compositing across layers prevents linear arithmetic saturation
    float a1 = evalShadowLayer(uShadow1, p, winOrigin, uWinSize, uRadius, d);
    float a2 = evalShadowLayer(uShadow2, p, winOrigin, uWinSize, uRadius, d);
    float a3 = evalShadowLayer(uShadow3, p, winOrigin, uWinSize, uRadius, d);
    float a = (1.0 - (1.0 - a1) * (1.0 - a2) * (1.0 - a3)) * clipAlpha;

    // Multiply shadow alpha by vertex alpha (cogl_color_in.a) to smoothly follow fade animations
    cogl_color_out = vec4(vec3(0.0), min(a, 1.0) * cogl_color_in.a);
`;

function toTemplateLiteral(str) {
    const escaped = str.replace(/[`]|\$\{/g, match => (match === '`' ? '\\`' : '\\${'));
    return `\`${escaped}\``;
}

const outputContent = `${header}
export const DECLARATIONS = ${toTemplateLiteral(declarations)};

export const CODE = ${toTemplateLiteral(code)};
`;

if (CHECK) {
    if (!existsSync(OUT_FILE)) {
        console.error(`[gen-shader] Missing target file: ${OUT_FILE}`);
        process.exit(1);
    }
    const current = readFileSync(OUT_FILE, 'utf8');
    if (current !== outputContent) {
        console.error('[gen-shader] Generated file mismatch with vendor/gtk, run: node tools/gen-shader.mjs');
        process.exit(1);
    }
    console.log(`[gen-shader] OK: shadowShader.generated.js matches GTK upstream (commit ${commit.slice(0, 8)})`);
    process.exit(0);
}

writeFileSync(OUT_FILE, outputContent, 'utf8');
console.log(`[gen-shader] Generated ${path.relative(ROOT, OUT_FILE)} (commit ${commit.slice(0, 8)})`);
