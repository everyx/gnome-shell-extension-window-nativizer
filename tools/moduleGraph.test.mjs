/**
 * Unit tests for the relative-import graph the boundary checker walks: the point of the walk is that
 * a forbidden module is found even when the importing file never names it.
 *
 * Run: pnpm run test:tools
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {buildGraph, chainTo, reachableFrom, resolveRelative} from './moduleGraph.mjs';

const TREE = path.join(path.sep, 'tree');
const at = (...parts) => path.join(TREE, ...parts);

const moduleOf = (relative, ...specifiers) => ({
    file: at(relative),
    specifiers: specifiers.map(specifier => ({specifier, line: 1})),
});

test('resolves a relative specifier and ignores a namespace or a package', () => {
    assert.equal(resolveRelative(at('src/prefs/page.js'), '../lib/x.js'), at('src/lib/x.js'));
    assert.equal(resolveRelative(at('src/prefs/page.js'), './y.js'), at('src/prefs/y.js'));
    assert.equal(resolveRelative(at('src/prefs/page.js'), 'gi://Gtk'), null);
    assert.equal(resolveRelative(at('src/prefs/page.js'), 'some-package'), null);
});

test('keeps only edges whose target is a module of this tree', () => {
    const graph = buildGraph([
        moduleOf('src/prefs/page.js', '../lib/x.js', 'gi://Adw'),
        moduleOf('src/lib/x.js', '../platform/display.js'),
    ]);
    assert.deepEqual(graph.get(at('src/prefs/page.js')), [at('src/lib/x.js')]);
    assert.deepEqual(graph.get(at('src/lib/x.js')), []);
});

test('finds a module two edges away, which no file in the chain names directly', () => {
    const graph = buildGraph([
        moduleOf('src/prefs/page.js', '../lib/x.js'),
        moduleOf('src/lib/x.js', '../lib/manager.js'),
        moduleOf('src/lib/manager.js', 'gi://Shell'),
    ]);
    const reached = reachableFrom(at('src/prefs/page.js'), graph);
    assert.ok(reached.has(at('src/lib/manager.js')));
    assert.deepEqual(chainTo(reached, at('src/lib/manager.js')), [
        at('src/prefs/page.js'),
        at('src/lib/x.js'),
        at('src/lib/manager.js'),
    ]);
});

test('survives a cycle without revisiting', () => {
    const graph = buildGraph([
        moduleOf('src/lib/a.js', './b.js'),
        moduleOf('src/lib/b.js', './a.js'),
    ]);
    assert.equal(reachableFrom(at('src/lib/a.js'), graph).size, 2);
});

test('skips a specifier the parser could not resolve', () => {
    const graph = buildGraph([{file: at('src/lib/a.js'), specifiers: [{specifier: null, line: 1}]}]);
    assert.deepEqual(graph.get(at('src/lib/a.js')), []);
});
