#!/usr/bin/env node
/**
 * Tests for tools/stats.mjs and the base→head formatter.
 *
 * Usage: node --test tools/stats.test.mjs
 */

import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATS = path.join(ROOT, 'tools', 'stats.mjs');
const DIFF = path.join(ROOT, 'tools', 'stats-diff.mjs');

let dir;

before(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'stats-'));
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src', 'authored.js'), [
        '// one',
        'const a = 1;',
        '',
        '/* block',
        ' * more',
        ' */',
        'function f() {}',
    ].join('\n') + '\n');
    writeFileSync(path.join(dir, 'src', 'shader.generated.js'), [
        'const g = 1;',
        '// generated',
    ].join('\n') + '\n');
});

after(() => rmSync(dir, {recursive: true, force: true}));

function run(script, ...args) {
    return spawnSync(process.execPath, [script, ...args], {encoding: 'utf8'});
}

test('separates authored code from comments, blanks, and generated files', () => {
    const result = run(STATS, '--root', dir, '--json');
    assert.equal(result.status, 0, result.stderr);
    const stats = JSON.parse(result.stdout);
    assert.deepEqual(stats.authored, {total: 7, nonBlank: 6, code: 2, commentOnly: 4, blank: 1});
    assert.deepEqual(stats.generated, {total: 2, nonBlank: 2, code: 1, commentOnly: 1, blank: 0});
    assert.deepEqual(stats.files, {total: 2, authored: 1, generated: 1});
    assert.equal(stats.ego.nonBlank, 8);
    assert.equal(stats.ego.over, 0);
    assert.equal(stats.largest[0].path, 'src/authored.js');
});

test('ignores non-JavaScript files under src/', () => {
    const mixed = mkdtempSync(path.join(tmpdir(), 'stats-mixed-'));
    mkdirSync(path.join(mixed, 'src'));
    writeFileSync(path.join(mixed, 'src', 'a.js'), 'const a = 1;\n');
    writeFileSync(path.join(mixed, 'src', 'notes.md'), '# notes\n');
    writeFileSync(path.join(mixed, 'src', 'style.css'), '* {}\n');
    const result = run(STATS, '--root', mixed, '--json');
    rmSync(mixed, {recursive: true, force: true});
    assert.equal(result.status, 0, result.stderr);
    const stats = JSON.parse(result.stdout);
    assert.equal(stats.files.total, 1);
    assert.equal(stats.authored.code, 1);
});

test('--check fails only when EGO non-blank exceeds the budget', () => {
    const big = mkdtempSync(path.join(tmpdir(), 'stats-big-'));
    mkdirSync(path.join(big, 'src'));
    writeFileSync(path.join(big, 'src', 'big.js'), 'const x = 1;\n'.repeat(8001));
    const result = run(STATS, '--root', big, '--check');
    rmSync(big, {recursive: true, force: true});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /exceeds/);
});

test('fails clearly when src/ is missing', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'stats-empty-'));
    const result = run(STATS, '--root', empty, '--json');
    rmSync(empty, {recursive: true, force: true});
    assert.equal(result.status, 2);
    assert.match(result.stderr, /no src\//);
});

test('renders a base to head comment with deltas and the budget line', () => {
    const baseFile = path.join(dir, 'base.json');
    const headFile = path.join(dir, 'head.json');
    const base = {
        ego: {nonBlank: 100, limit: 8000, over: 0, status: 'pass'},
        authored: {total: 90, nonBlank: 80, code: 60, commentOnly: 20, blank: 10},
        generated: {total: 10, nonBlank: 10, code: 10, commentOnly: 0, blank: 0},
        files: {total: 3, authored: 2, generated: 1},
        largest: [],
        authoredFiles: [
            {path: 'src/authored.js', total: 60, nonBlank: 50, code: 40, commentOnly: 10, blank: 10},
            {path: 'src/other.js', total: 30, nonBlank: 30, code: 20, commentOnly: 10, blank: 0},
        ],
    };
    const head = JSON.parse(JSON.stringify(base));
    head.ego.nonBlank = 90;
    head.authored.code = 54;
    head.authored.commentOnly = 16;
    head.authoredFiles[0].nonBlank = 44;
    head.authoredFiles[0].code = 34;
    head.authoredFiles[0].commentOnly = 6;
    writeFileSync(baseFile, JSON.stringify(base));
    writeFileSync(headFile, JSON.stringify(head));

    const result = run(DIFF, baseFile, headFile, '--base-sha', 'aaaaaaaaaaaa', '--head-sha', 'bbbbbbbbbbbb');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /window-nativizer-code-stats/);
    assert.match(result.stdout, /base `aaaaaaa` → head `bbbbbbb`/);
    assert.match(result.stdout, /\| \*\*EGO non-blank\*\* \| 100 \| 90 \| -10 \|/);
    assert.match(result.stdout, /within the 8,000 budget/);
    assert.match(result.stdout, /src\/authored\.js/);
});
