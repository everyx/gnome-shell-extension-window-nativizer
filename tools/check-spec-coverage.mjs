#!/usr/bin/env node
/**
 * check-spec-coverage.mjs - Every module under src/ is imported by a spec, or excused in
 * tools/spec-coverage-allow.txt with a reason.
 *
 * Why a checker and not a convention: the untestable modules were listed in a paragraph of
 * docs/development.md, which a new file silently joined. The list is now an input, so adding a module
 * is a decision - either it gets a spec or somebody writes down why it cannot have one.
 *
 * The allowlist is held from both sides: an entry that no longer exists, or that a spec now imports,
 * fails too, because a stale excuse is how the paragraph rotted.
 *
 * Usage: node tools/check-spec-coverage.mjs
 */

import {readFileSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const TESTS = path.join(ROOT, 'tests');
const ALLOWLIST = path.join(ROOT, 'tools', 'spec-coverage-allow.txt');

function fail(message) {
    console.error(`[check-spec-coverage] FAIL: ${message}`);
    process.exit(1);
}

function jsFilesIn(dir) {
    return readdirSync(dir, {recursive: true, withFileTypes: true})
        .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
        .map(entry => path.join(entry.parentPath, entry.name));
}

/** Modules a spec imports, as paths relative to src/. */
function specImports() {
    const covered = new Set();
    for (const file of jsFilesIn(TESTS)) {
        const text = readFileSync(file, 'utf8');
        for (const match of text.matchAll(/from ['"](?:\.\.\/)+src\/([^'"]+)['"]/gu))
            covered.add(match[1]);
    }
    return covered;
}

/** `path/to/module.js # reason` per line; a line without a reason is refused. */
function readAllowlist() {
    const entries = new Map();
    let text;
    try {
        text = readFileSync(ALLOWLIST, 'utf8');
    } catch {
        return entries;
    }
    text.split('\n').forEach((line, index) => {
        const content = line.trim();
        if (!content || content.startsWith('#'))
            return;
        const hash = content.indexOf('#');
        const module = content.slice(0, hash < 0 ? content.length : hash).trim();
        const reason = hash < 0 ? '' : content.slice(hash + 1).trim();
        if (!module.endsWith('.js'))
            fail(`${path.relative(ROOT, ALLOWLIST)}:${index + 1}: "${module}" is not a .js path`);
        if (!reason)
            fail(`${path.relative(ROOT, ALLOWLIST)}:${index + 1}: "${module}" has no reason after #`);
        entries.set(module, reason);
    });
    return entries;
}

const modules = jsFilesIn(SRC)
    .map(file => path.relative(SRC, file).split(path.sep).join('/'))
    .filter(module => !module.endsWith('.generated.js'))
    .sort();

const covered = specImports();
const allowed = readAllowlist();

const violations = [];
for (const module of modules) {
    if (!covered.has(module) && !allowed.has(module))
        violations.push(`src/${module}: no spec imports it; add one, or excuse it in ${path.relative(ROOT, ALLOWLIST)}`);
}
for (const module of allowed.keys()) {
    if (!modules.includes(module))
        violations.push(`${path.relative(ROOT, ALLOWLIST)}: "${module}" does not exist`);
    else if (covered.has(module))
        violations.push(`${path.relative(ROOT, ALLOWLIST)}: "${module}" is imported by a spec now, so the entry is stale`);
}

if (violations.length > 0) {
    for (const violation of violations)
        console.error(`[check-spec-coverage] ${violation}`);
    process.exit(1);
}

console.log(`[check-spec-coverage] OK: ${modules.length} modules, ${covered.size} imported by specs, ` +
    `${allowed.size} excused with a reason.`);
