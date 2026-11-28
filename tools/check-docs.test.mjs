#!/usr/bin/env node
/** Tests for tools/check-docs.mjs: the two claims a document can be held to. */

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {documents, missingPaths, unknownScripts} from './check-docs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = path.join(ROOT, 'tools', 'check-docs.mjs');

test('reports a path in this tree that is not there', () => {
    const text = 'See `src/lib/nowhere.js` and `tools/also-nowhere.mjs`.';
    assert.deepEqual(missingPaths(text, {exists: () => false}).sort(),
        ['src/lib/nowhere.js', 'tools/also-nowhere.mjs']);
});

test('leaves a path alone when it names a directory this tree does not have', () => {
    // `src/x11/window-x11.c` is Mutter's tree written the way Mutter writes it: a claim about
    // upstream, whose evidence is the pointer, not a file here.
    assert.deepEqual(missingPaths('`src/x11/window-x11.c`', {exists: () => false}), []);
    // The same absence one level down *is* ours, and is reported.
    assert.deepEqual(missingPaths('`src/lib/nowhere.js`', {exists: () => false}), ['src/lib/nowhere.js']);
});

test('reports a script the package does not define', () => {
    const scripts = new Set(['lint', 'test:e2e']);
    assert.deepEqual(unknownScripts('run `pnpm run lint` then `pnpm run lint:ego`', scripts),
        ['lint:ego']);
});

test('the documents in this repository pass their own check', () => {
    const result = spawnSync(process.execPath, [CHECK], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    assert.ok(documents().length > 5, 'it should find the documents to check');
});
