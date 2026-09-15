#!/usr/bin/env node
/**
 * gen-mutter.mjs - Reads vendor/mutter/meta-shadow-factory.c and vendor/mutter/window.h
 * and generates src/lib/mutterRules.generated.js (the MetaWindowType and
 * MetaWindowClientType enums).
 *
 * Design: narrow parser + assertions. The enums are generated to eliminate enum drift;
 * default_shadow_classes is parsed too but only validated - the tuple shape is asserted so a
 * format change in Mutter fails the build, and nothing is emitted from it (the radius the
 * decoration threshold once used has no reader left).
 *
 * Usage: node tools/gen-mutter.mjs [--check]
 *   --check: Verifies generated results match existing files (used by CI / check-style), exits with 1 if mismatch.
 */

import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor', 'mutter');
const OUT = path.join(ROOT, 'src', 'lib', 'mutterRules.generated.js');

const CHECK = process.argv.includes('--check');

function read(name) {
    const p = path.join(VENDOR, name);
    if (!existsSync(p))
        throw new Error(`[gen-mutter] Missing vendor file: ${name}`);
    return readFileSync(p, 'utf8');
}

function parseParams(tupleStr) {
    // Format: { 10, -1, 0, 3, 128 }
    const nums = tupleStr.replace(/[{}]/g, '').split(',').map(s => parseInt(s.trim(), 10));
    if (nums.length !== 5 || nums.some(n => Number.isNaN(n)))
        throw new Error(`[gen-mutter] Cannot parse MetaShadowParams: "${tupleStr}"`);
    const [radius, top_fade, x_offset, y_offset, opacity] = nums;
    // Nothing is generated from this tuple: it is parsed to pin Mutter's five-field shape
    // (and per-field type), so a format change fails the build instead of silently passing.
    return {
        radius,
        topFade: top_fade,
        xOffset: x_offset,
        yOffset: y_offset,
        opacity,
    };
}

function parseShadowClasses(cCode) {
    const startIdx = cCode.indexOf('MetaShadowClassInfo default_shadow_classes[]');
    if (startIdx === -1)
        throw new Error('[gen-mutter] Assertion failed: default_shadow_classes definition not found');
    const braceStart = cCode.indexOf('{', startIdx);
    const braceEnd = cCode.indexOf('};', braceStart);
    if (braceStart === -1 || braceEnd === -1)
        throw new Error('[gen-mutter] Assertion failed: default_shadow_classes block not found');

    const body = cCode.slice(braceStart + 1, braceEnd);
    const itemRegex = /\{\s*"([^"]+)"\s*,\s*(\{[^}]+\})\s*,\s*(\{[^}]+\})\s*\}/g;
    const classes = {};
    let match;
    while ((match = itemRegex.exec(body)) !== null) {
        const [, name, focusedStr, unfocusedStr] = match;
        classes[name] = {
            focused: parseParams(focusedStr),
            unfocused: parseParams(unfocusedStr),
        };
    }

    if (!classes.normal || !classes.dialog)
        throw new Error('[gen-mutter] Assertion failed: classes missing normal or dialog');

    return classes;
}

function parseWindowTypes(headerCode) {
    const enumMatch = /typedef\s+enum\s*\{([^}]+)\}\s*MetaWindowType;/m.exec(headerCode);
    if (!enumMatch)
        throw new Error('[gen-mutter] Assertion failed: MetaWindowType enum not found in window.h');

    const lines = enumMatch[1].split('\n');
    const types = {};
    let currentIndex = 0;

    for (const rawLine of lines) {
        const line = rawLine.replace(/\/\*.*?\*\//g, '').trim();
        if (!line)
            continue;

        const match = /^META_WINDOW_([A-Z0-9_]+)(?:\s*=\s*(\d+))?,?$/.exec(line);
        if (match) {
            const name = match[1];
            if (match[2] !== undefined)
                currentIndex = parseInt(match[2], 10);
            types[name] = currentIndex;
            currentIndex++;
        }
    }

    if (types.NORMAL === undefined || types.DIALOG === undefined || types.MODAL_DIALOG === undefined)
        throw new Error('[gen-mutter] Assertion failed: Expected WindowType values missing');

    return types;
}

function parseClientTypes(headerCode) {
    const enumMatch = /typedef\s+enum\s*\{([^}]+)\}\s*MetaWindowClientType;/m.exec(headerCode);
    if (!enumMatch)
        throw new Error('[gen-mutter] Assertion failed: MetaWindowClientType enum not found in window.h');

    const types = {};
    let currentIndex = 0;

    for (const rawLine of enumMatch[1].split('\n')) {
        const line = rawLine.replace(/\/\*.*?\*\//g, '').trim();
        if (!line)
            continue;

        const match = /^META_WINDOW_CLIENT_TYPE_([A-Z0-9_]+)(?:\s*=\s*(\d+))?,?$/.exec(line);
        if (match) {
            const name = match[1];
            if (match[2] !== undefined)
                currentIndex = parseInt(match[2], 10);
            types[name] = currentIndex;
            currentIndex++;
        }
    }

    if (types.WAYLAND === undefined || types.X11 === undefined)
        throw new Error('[gen-mutter] Assertion failed: Expected WindowClientType values missing');

    return types;
}

function main() {
    const cCode = read('meta-shadow-factory.c');
    const headerCode = read('window.h');
    // Parsed for validation only: a format change in Mutter's shadow factory fails the build.
    parseShadowClasses(cCode);
    const windowTypes = parseWindowTypes(headerCode);
    const clientTypes = parseClientTypes(headerCode);

    const banner = `/**
 * mutterRules.generated.js - Automatically parsed and generated from:
 *   - vendor/mutter/meta-shadow-factory.c
 *   - vendor/mutter/window.h
 *
 * Do not edit this file directly! To regenerate run:
 *   node tools/gen-mutter.mjs
 */`;

    const code = `${banner}

/**
 * Mutter Window Type enum (MetaWindowType from vendor/mutter/window.h)
 */
export const WindowType = Object.freeze(${JSON.stringify(windowTypes, null, 4)});

/**
 * Mutter Window Client Type enum (MetaWindowClientType from vendor/mutter/window.h)
 */
export const WindowClientType = Object.freeze(${JSON.stringify(clientTypes, null, 4)});

`;

    if (CHECK) {
        if (!existsSync(OUT)) {
            console.error(`[gen-mutter] --check failed: ${OUT} does not exist`);
            process.exit(1);
        }
        const existing = readFileSync(OUT, 'utf8');
        if (existing !== code) {
            console.error(`[gen-mutter] --check failed: ${OUT} does not match vendor/mutter sources`);
            process.exit(1);
        }
        console.log('[gen-mutter] --check passed: generated file matches vendor source code');
        return;
    }

    writeFileSync(OUT, code, 'utf8');
    console.log(`[gen-mutter] Successfully parsed and generated: ${path.relative(ROOT, OUT)}`);
}

main();
