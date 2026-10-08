#!/usr/bin/env node
/**
 * check-compat-ownership.mjs - Fails when a member whose declaration varies across the audited
 * GNOME lines is referenced outside src/compat/ without the ownership that variation requires.
 *
 * tools/shell-api.json records one declaration per member per audited line, and the record already
 * knows which members are not the same on every line: Shell.GLSLEffect exists through 50 and is
 * gone in 51, win.is_maximized appears in 49, win.begin_grab_op takes a device on 45-48 and a
 * sprite on 49-51. Those are exactly the members whose shape one line's code cannot state.
 *
 * The runtime gate (tools/gjs-surface.js) already asserts what the seams select on the shell under
 * test. What it cannot see is a member the code reaches *around* a seam: a new call site added in
 * src/lib/ compiles and runs on the maintainer's line and breaks on a line whose declaration moved.
 * This check reads the record instead of a shell, so it sees that.
 *
 * Two things make a reference acceptable:
 *
 *   - src/compat/ owns the member. The spelling appearing there means the seam is the code's one
 *     place for it, and any reference elsewhere goes through what the seam exposes (a method on a
 *     class the seam chose, e.g. `this.set_uniform_float`). The shape is the seam's to pick.
 *   - Otherwise the reference must be a capability probe (`win?.is_maximized`, `typeof x.f ===
 *     'function'`). That is the documented pattern for a member whose absence the code tolerates
 *     (docs/development.md, "Where the mechanical part stops"), and it is what keeps such a member
 *     safe without moving its dispatch into src/compat/.
 *
 * Everything else is a failure: a bare `win.is_client_decorated()` outside both is a call the code
 * makes on a line that may not declare it.
 *
 * Usage: node tools/check-compat-ownership.mjs [--check]
 *   --check: the only mode, accepted so the tool reads like the rest of the check-style chain.
 */

import {readFileSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECORD = path.join(ROOT, 'tools', 'shell-api.json');
const SRC = path.join(ROOT, 'src');
const COMPAT = path.join(SRC, 'compat');

function fail(message) {
    console.error(`[check-compat-ownership] FAIL: ${message}`);
    process.exit(1);
}

function readRecord() {
    try {
        return JSON.parse(readFileSync(RECORD, 'utf8'));
    } catch (e) {
        fail(`cannot read ${path.relative(ROOT, RECORD)}: ${e.message}`);
    }
}

/** The parameter types of a C prototype, parameter names dropped. */
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

/**
 * How one line spells a member. Only the parts a caller can see go in: the parameters a C function
 * takes, or mere presence for anything else. A description string or a GParamFlags bit that gained
 * G_PARAM_STATIC_STRINGS is not a shape the code can call.
 */
function shapeFor(entry, major) {
    const declaration = entry.decl?.[String(major)];
    if (declaration === null || declaration === undefined)
        return 'absent';
    switch (entry.kind) {
    case 'fn':
    case 'vfunc':
        return `(${parameterTypes(declaration)})`;
    case 'const':
        // A constant that differs by line (the typelib API version) is version-dependent by value.
        return declaration;
    default:
        return 'present';
    }
}

/** Members whose declaration is not identical on every audited line. */
function versionDependent(record) {
    const entries = [];
    for (const entry of record.surface) {
        const shapes = new Set(record.majors.map(major => shapeFor(entry, major)));
        if (shapes.size > 1)
            entries.push(entry);
    }
    return entries;
}

/**
 * The token the code would write to reach a member. Namespace and enum members (`Shell.GLSLEffect`,
 * `Clutter.CursorType`) keep their qualified spelling; a method keeps its bare name; a property is
 * looked up by its name after a dot.
 */
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

/** Every .js file under src/ except the compat layer, with its text. */
function sourceFiles() {
    return readdirSync(SRC, {recursive: true, withFileTypes: true})
        .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
        .map(entry => path.join(entry.parentPath, entry.name))
        .filter(file => !file.startsWith(`${COMPAT}${path.sep}`))
        .map(file => ({file, text: readFileSync(file, 'utf8')}));
}

const record = readRecord();
const dependent = versionDependent(record);

// A member the compat layer spells in code is the seam's: references elsewhere reach it through
// whatever the seam exposes, so the shape is chosen in one place. Only the members with no compat
// home are checked for a probe at the call site. Comment lines are dropped: a seam that only
// mentions a member in prose has not taken ownership of it.
function codeLines(text) {
    return text.split('\n').filter(line => {
        const trimmed = line.trimStart();
        return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    });
}

const compatText = readdirSync(COMPAT)
    .filter(name => name.endsWith('.js'))
    .map(name => codeLines(readFileSync(path.join(COMPAT, name), 'utf8')).join('\n'))
    .join('\n');

const files = sourceFiles();
const seamOwned = [];
const checked = [];
const violations = [];

for (const entry of dependent) {
    const token = tokenFor(entry);
    if (!token)
        continue;
    if (new RegExp(`\\b${token.text.replace('.', '\\.')}\\b`).test(compatText)) {
        seamOwned.push(entry.id);
        continue;
    }
    checked.push(entry.id);
    for (const {file, text} of files) {
        const probePresent = token.probe ? token.probe.test(text) : false;
        text.split('\n').forEach((line, index) => {
            const trimmed = line.trimStart();
            if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
                return;
            if (!token.pattern.test(line))
                return;
            if (probePresent)
                return;
            violations.push(`${path.relative(ROOT, file)}:${index + 1}: ${entry.member}`);
        });
    }
}

if (violations.length) {
    console.error('[check-compat-ownership] FAIL: version-dependent members referenced without a seam or a probe:');
    for (const violation of violations)
        console.error(`  ${violation}`);
    console.error('  Move the reference into src/compat/, or probe the member before calling it.');
    process.exit(1);
}

console.log(`[check-compat-ownership] ${dependent.length} version-dependent members, `
    + `${seamOwned.length} owned by src/compat (${seamOwned.join(', ')}), `
    + `${checked.length} checked for a call-site probe (${checked.join(', ') || 'none'})`);
