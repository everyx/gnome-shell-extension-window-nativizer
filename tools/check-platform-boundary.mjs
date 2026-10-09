#!/usr/bin/env node
/**
 * check-platform-boundary.mjs - Enforces architectural boundaries between business logic
 * (src/lib/, src/effects/) and host platform integrations (src/platform/).
 *
 * Checks:
 *   1. Platform Boundary Enforcement:
 *      - Business directories (src/lib/, src/effects/) MUST NOT import raw host namespaces
 *        (gi://Meta, gi://Shell).
 *      - Business directories MUST NOT directly access global compositor state
 *        (global.display, global.stage, global.workspace_manager, globalThis.global).
 *      - Business directories MUST NOT make direct raw calls to Meta.Window methods or properties
 *        (is_maximized, get_tile_match, get_frame_rect, decorated, appears_focused, etc.);
 *        all window queries and operations must go through src/platform/window.js.
 *   2. Seam Ownership:
 *      - Members whose declarations vary across GNOME lines (from tools/shell-api.json)
 *        must be owned by src/platform/, or protected by a call-site probe.
 *   3. Dependency Direction:
 *      - src/platform/ must not import higher-level business modules (src/lib/manager.js,
 *        src/lib/windowDecoration.js, src/effects/*).
 *
 * Usage: node tools/check-platform-boundary.mjs [--check]
 */

import {readFileSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECORD = path.join(ROOT, 'tools', 'shell-api.json');
const SRC = path.join(ROOT, 'src');
const PLATFORM = path.join(SRC, 'platform');
const LIB = path.join(SRC, 'lib');
const EFFECTS = path.join(SRC, 'effects');

function fail(message) {
    console.error(`[check-platform-boundary] FAIL: ${message}`);
    process.exit(1);
}

function readRecord() {
    try {
        return JSON.parse(readFileSync(RECORD, 'utf8'));
    } catch (e) {
        fail(`cannot read ${path.relative(ROOT, RECORD)}: ${e.message}`);
    }
}

/** Parameter types of a C prototype, dropping parameter names. */
function parameterTypes(declaration) {
    const open = declaration.indexOf('(');
    if (open < 0)
        return '';
    let depth = 0;
    let close = -1;
    for (let i = open; i < declaration.length; i++) {
        if (declaration[i] === '(')
            depth++;
        else if (declaration[i] === ')' && --depth === 0) {
            close = i;
            break;
        }
    }
    if (close < 0)
        return '';
    return declaration.slice(open + 1, close)
        .split(',')
        .map(param => param.trim().replace(/\s*[A-Za-z_]\w*\s*$/, '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(', ');
}

function shapeFor(entry, major) {
    const declaration = entry.decl?.[String(major)];
    if (declaration === null || declaration === undefined)
        return 'absent';
    switch (entry.kind) {
    case 'fn':
    case 'vfunc':
        return `(${parameterTypes(declaration)})`;
    case 'const':
        return declaration;
    default:
        return 'present';
    }
}

function versionDependent(record) {
    const entries = [];
    for (const entry of record.surface) {
        const shapes = new Set(record.majors.map(major => shapeFor(entry, major)));
        if (shapes.size > 1)
            entries.push(entry);
    }
    return entries;
}

function tokenFor(entry) {
    const member = entry.member.split(' [')[0].trim();
    if (entry.kind === 'const')
        return null;
    if (entry.kind === 'prop') {
        const property = member.includes(':') ? member.split(':').pop() : member.split('.').pop();
        return {text: property, pattern: new RegExp(`\\.${property}\\b`), probe: new RegExp(`\\?\\.${property}\\b`)};
    }
    const head = member.split('(')[0];
    const name = head.split('.').pop();
    const qualified = /^[A-Z][\w]*\.[A-Z]/.test(head) || entry.kind === 'file' || entry.kind === 'enum';
    if (qualified)
        return {text: head, pattern: new RegExp(`\\b${head.replace('.', '\\.')}\\b`), probe: null};
    return {
        text: name,
        pattern: new RegExp(`\\.${name}\\b`),
        probe: new RegExp(`(\\?\\.${name}\\b|typeof[^\\n;]*\\.${name}\\b)`),
    };
}

/** Strips comment lines so prose mentions do not count as code. */
function codeLines(text) {
    return text.split('\n').filter(line => {
        const trimmed = line.trimStart();
        return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    });
}

/** Source files in a specific directory. */
function jsFilesIn(dir) {
    try {
        return readdirSync(dir, {recursive: true, withFileTypes: true})
            .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
            .map(entry => path.join(entry.parentPath, entry.name))
            .map(file => ({file, text: readFileSync(file, 'utf8')}));
    } catch {
        return [];
    }
}

const violations = [];

// =========================================================================
// 1. Platform Boundary Enforcement
// =========================================================================

const businessFiles = [...jsFilesIn(LIB), ...jsFilesIn(EFFECTS)];

const FORBIDDEN_IMPORTS = [
    {pattern: /from\s+['"]gi:\/\/Meta['"]/, desc: 'direct gi://Meta import (must use src/platform/)'},
    {pattern: /from\s+['"]gi:\/\/Shell['"]/, desc: 'direct gi://Shell import (must use src/platform/)'},
];

const FORBIDDEN_GLOBALS = [
    {pattern: /\bglobal\.display\b/, desc: 'raw global.display access (use platform/display.js: getDisplay())'},
    {pattern: /\bglobal\.stage\b/, desc: 'raw global.stage access (use platform/display.js: getStage())'},
    {pattern: /\bglobal\.workspace_manager\b/, desc: 'raw global.workspace_manager access'},
    {pattern: /\bglobalThis\.global\b/, desc: 'raw globalThis.global access (use platform/display.js)'},
];

const RAW_WINDOW_OPERATIONS = [
    'is_maximized',
    'is_fullscreen',
    'get_tile_match',
    'get_frame_rect',
    'get_buffer_rect',
    'get_client_type',
    'get_window_type',
    'get_pid',
    'get_transient_for',
    'is_attached_dialog',
    'allows_resize',
    'is_hidden',
    'is_on_all_workspaces',
    'located_on_workspace',
    'get_title',
    'get_compositor_private',
    'decorated',
    'maximized_horizontally',
    'maximized_vertically',
    'appears_focused',
];

const RAW_WINDOW_PATTERNS = RAW_WINDOW_OPERATIONS.map(op => ({
    pattern: new RegExp(`\\bwin\\??\\.${op}\\b`),
    desc: `raw Meta.Window.${op} access (must use src/platform/window.js)`,
}));

for (const {file, text} of businessFiles) {
    const relFile = path.relative(ROOT, file);
    const lines = text.split('\n');
    lines.forEach((line, idx) => {
        const trimmed = line.trimStart();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
            return;

        for (const {pattern, desc} of FORBIDDEN_IMPORTS) {
            if (pattern.test(line))
                violations.push(`${relFile}:${idx + 1}: ${desc}`);
        }

        for (const {pattern, desc} of FORBIDDEN_GLOBALS) {
            if (pattern.test(line))
                violations.push(`${relFile}:${idx + 1}: ${desc}`);
        }

        for (const {pattern, desc} of RAW_WINDOW_PATTERNS) {
            if (pattern.test(line))
                violations.push(`${relFile}:${idx + 1}: ${desc}`);
        }
    });
}

// =========================================================================
// 2. Seam Ownership for Version-Dependent Members
// =========================================================================

const platformFiles = jsFilesIn(PLATFORM);
const platformText = platformFiles
    .map(({text}) => codeLines(text).join('\n'))
    .join('\n');

const allSourceFiles = readdirSync(SRC, {recursive: true, withFileTypes: true})
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => path.join(entry.parentPath, entry.name))
    .filter(file => !file.startsWith(`${PLATFORM}${path.sep}`))
    .map(file => ({file, text: readFileSync(file, 'utf8')}));

const record = readRecord();
const dependent = versionDependent(record);
const seamOwned = [];
const checked = [];

for (const entry of dependent) {
    const token = tokenFor(entry);
    if (!token)
        continue;
    if (new RegExp(`\\b${token.text.replace('.', '\\.')}\\b`).test(platformText)) {
        seamOwned.push(entry.id);
        continue;
    }
    checked.push(entry.id);
    for (const {file, text} of allSourceFiles) {
        const probePresent = token.probe ? token.probe.test(text) : false;
        text.split('\n').forEach((line, index) => {
            const trimmed = line.trimStart();
            if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
                return;
            if (!token.pattern.test(line))
                return;
            if (probePresent)
                return;
            violations.push(`${path.relative(ROOT, file)}:${index + 1}: version-dependent member ${entry.member} without platform seam or probe`);
        });
    }
}

// =========================================================================
// 3. Directional Dependency Check (platform must not import lib / effects)
// =========================================================================

const FORBIDDEN_PLATFORM_IMPORTS = [
    {pattern: /from\s+['"]\.\.\/lib\/(?!mutterRules\.generated\.js)[^'"]+['"]/, desc: 'platform must not depend on business modules in src/lib/'},
    {pattern: /from\s+['"]\.\.\/effects\/[^'"]+['"]/, desc: 'platform must not depend on src/effects/'},
];

for (const {file, text} of platformFiles) {
    const relFile = path.relative(ROOT, file);
    text.split('\n').forEach((line, idx) => {
        const trimmed = line.trimStart();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
            return;
        for (const {pattern, desc} of FORBIDDEN_PLATFORM_IMPORTS) {
            if (pattern.test(line))
                violations.push(`${relFile}:${idx + 1}: ${desc}`);
        }
    });
}

// =========================================================================
// Reporting
// =========================================================================

if (violations.length) {
    console.error('[check-platform-boundary] FAIL: platform boundary violations detected:');
    for (const violation of violations)
        console.error(`  ${violation}`);
    process.exit(1);
}

console.log(`[check-platform-boundary] OK: verified platform boundary across ${businessFiles.length} business files.`);
console.log(`[check-platform-boundary] ${dependent.length} version-dependent members, `
    + `${seamOwned.length} owned by src/platform (${seamOwned.join(', ')}), `
    + `${checked.length} checked for call-site probe (${checked.join(', ') || 'none'}).`);
