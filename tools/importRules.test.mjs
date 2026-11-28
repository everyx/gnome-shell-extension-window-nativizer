/**
 * Unit tests for the dependency-direction rules the boundary checker applies, and for the spec
 * coverage scan: both take specifiers, so both must judge a side-effect or dynamic import the same
 * way they judge a named one.
 *
 * Run: pnpm run test:tools
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {modulesImportedBy} from './check-spec-coverage.mjs';
import {businessViolation, namesShellProcess, platformViolation, prefsViolation} from './importRules.mjs';

test('business code may not name Meta or Shell, in any import form', () => {
    assert.match(businessViolation('gi://Meta'), /must use src\/platform/);
    assert.match(businessViolation('gi://Shell'), /must use src\/platform/);
    assert.equal(businessViolation('gi://GLib'), null);
    assert.equal(businessViolation('../platform/window.js'), null);
});

test('prefs may not reach the shell side, by module or by directory', () => {
    for (const specifier of ['gi://Meta', '../platform/display.js', '../effects/clipEffect.js',
        '../lib/manager.js', '../lib/inspector.js']) {
        assert.match(prefsViolation(specifier), /prefs must not/, specifier);
    }
    assert.equal(prefsViolation('gi://Gtk'), null);
    assert.equal(prefsViolation('../lib/rules.js'), null);
    assert.equal(prefsViolation('../lib/settings.js'), null);
});

test('platform may read the generated table and nothing else under lib, and no effects', () => {
    assert.equal(platformViolation('../lib/mutterRules.generated.js'), null);
    assert.match(platformViolation('../lib/manager.js'), /src\/lib/);
    assert.match(platformViolation('../lib/window.js'), /src\/lib/);
    assert.match(platformViolation('../effects/clipEffect.js'), /src\/effects/);
    assert.equal(platformViolation('gi://Meta'), null);
});

test('a versioned GI URI names the namespace it starts with', () => {
    assert.match(businessViolation('gi://Meta?version=51'), /must use src\/platform/);
    assert.match(prefsViolation('gi://Shell?version=18'), /shell side/);
    assert.equal(businessViolation('gi://Gtk?version=4.0'), null);
});

test('a shell-process namespace is recognised with or without a version', () => {
    for (const specifier of ['gi://Meta', 'gi://Shell', 'gi://St', 'gi://Clutter',
        'gi://St?version=18', 'gi://Clutter?version=18', 'resource:///org/gnome/shell/ui/main.js']) {
        assert.equal(namesShellProcess(specifier), true, specifier);
    }
    for (const specifier of ['gi://Gtk?version=4.0', 'gi://GLib', '../platform/numeric.js', null])
        assert.equal(namesShellProcess(specifier), false, String(specifier));
});

test('a spec covers a module however it imports it', () => {
    assert.deepEqual([...modulesImportedBy("import {x} from '../src/lib/rules.js';\n")], ['lib/rules.js']);
    assert.deepEqual([...modulesImportedBy("import '../src/lib/rules.js';\n")], ['lib/rules.js']);
    assert.deepEqual([...modulesImportedBy("await import('../src/platform/window.js');\n")], ['platform/window.js']);
});

test('a spec that imports something outside src/ covers nothing', () => {
    assert.deepEqual([...modulesImportedBy("import GLib from 'gi://GLib';\nimport './helper.mjs';\n")], []);
});
