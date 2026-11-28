/**
 * Unit tests for the import scanner the boundary checker reads with: the forms that load a module
 * must all be seen, or the checker's verdict is about syntax rather than about dependencies.
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

test('sees a re-export, which loads the module it names', () => {
    assert.deepEqual(specifiersOf("export {getDisplay} from '../platform/display.js';\n"), ['../platform/display.js']);
});

test('ignores an ordinary string that happens to mention an import', () => {
    assert.deepEqual(specifiersOf("const hint = 'import ../platform/display.js';\n"), []);
});

test('ignores a commented import', () => {
    assert.deepEqual(specifiersOf("// import '../platform/display.js'\n"), []);
});

test('reports every specifier with the line it is on', () => {
    const text = "import 'gi://Gtk';\n\nimport Gio from 'gi://Gio';\n";
    assert.deepEqual(importSpecifiers(text), [
        {specifier: 'gi://Gtk', line: 1},
        {specifier: 'gi://Gio', line: 3},
    ]);
});
