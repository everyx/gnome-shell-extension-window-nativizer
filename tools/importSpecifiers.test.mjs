/**
 * Unit tests for the import scanner: every form that loads a module is read, and a form it cannot
 * resolve is reported rather than skipped.
 *
 * Run: pnpm run test:tools
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {importSpecifiers} from './importSpecifiers.mjs';

const specifiersOf = text => importSpecifiers(text).map(entry => entry.specifier);

test('sees a named import and its line', () => {
    const found = importSpecifiers("import {getDisplay} from '../platform/display.js';\n");
    assert.deepEqual(found, [{specifier: '../platform/display.js', line: 1}]);
});

test('sees a side-effect import, which carries no from clause', () => {
    assert.deepEqual(specifiersOf("import '../platform/display.js';\n"), ['../platform/display.js']);
});

test('sees a dynamic import', () => {
    assert.deepEqual(specifiersOf("await import('../platform/display.js');\n"), ['../platform/display.js']);
});

test('sees a dynamic import whose specifier is on the next line', () => {
    assert.deepEqual(specifiersOf("await import(\n    '../platform/display.js'\n);\n"), ['../platform/display.js']);
});

test('sees an import whose clause spans several lines', () => {
    const text = "import {\n    getDisplay,\n} from '../platform/display.js';\n";
    assert.deepEqual(importSpecifiers(text), [{specifier: '../platform/display.js', line: 1}]);
});

test('sees a re-export, which loads the module it names', () => {
    assert.deepEqual(specifiersOf("export {getDisplay} from '../platform/display.js';\n"), ['../platform/display.js']);
});

test('reports a specifier it cannot resolve instead of skipping it', () => {
    assert.deepEqual(specifiersOf("await import(`../platform/${name}.js`);\n"), [null]);
    assert.deepEqual(specifiersOf('const where = 1;\nimport(where);\n'), [null]);
});

test('ignores comments and ordinary strings', () => {
    assert.deepEqual(specifiersOf("// import '../platform/display.js'\n/* import 'gi://Meta' */\n"), []);
    assert.deepEqual(specifiersOf("const hint = 'import ../platform/display.js';\n"), []);
    assert.deepEqual(specifiersOf("const url = 'https://example.com/import';\n"), []);
});

test('reports every import with the line it is on', () => {
    const text = "import 'gi://Gtk';\n\nimport Gio from 'gi://Gio';\n";
    assert.deepEqual(importSpecifiers(text), [
        {specifier: 'gi://Gtk', line: 1},
        {specifier: 'gi://Gio', line: 3},
    ]);
});
