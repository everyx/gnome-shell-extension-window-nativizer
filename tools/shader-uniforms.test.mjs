#!/usr/bin/env node
/**
 * Tests for tools/shader-uniforms.mjs — the guard that keeps the extension's uniform upload from
 * naming or sizing a uniform the shader does not declare.
 *
 * Usage: node --test tools/shader-uniforms.test.mjs
 */

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {uniformManifest} from './shader-uniforms.mjs';

test('reads a name and an arity off every declaration', () => {
    const manifest = uniformManifest(`
uniform vec2 uWinSize;      // Window size (px)
uniform float uRadius;
uniform vec4 uShadow1;
`);

    assert.deepEqual(manifest, [
        ['winSize', {name: 'uWinSize', components: 2}],
        ['radius', {name: 'uRadius', components: 1}],
        ['shadow1', {name: 'uShadow1', components: 4}],
    ]);
});

test('keys an indexed name so a layer loop can address it', () => {
    // shadow1..shadow3 is what the upload loop indexes; a base name would have to be re-split.
    const keys = uniformManifest('uniform vec4 uShadow7;\n').map(([key]) => key);
    assert.deepEqual(keys, ['shadow7']);
});

test('refuses a type whose width it does not know', () => {
    assert.throws(
        () => uniformManifest('uniform mat4 uTransform;\n'),
        /Unsupported uniform type: mat4 uTransform/);
});

test('refuses a declaration the pattern cannot parse', () => {
    // An array would match no entry and vanish from the manifest in silence, which is the exact
    // failure this manifest exists to prevent - so the count is checked, not assumed.
    assert.throws(
        () => uniformManifest('uniform vec2 uWinSize;\nuniform vec4 uLayers[3];\n'),
        /Parsed 1 of 2 uniform declarations/);
});

test('ignores text that is not a declaration', () => {
    const manifest = uniformManifest(`
const float PI = 3.14159;
// uniform vec2 uCommentedOut;
float f() { return PI; }
`);
    assert.deepEqual(manifest, []);
});
