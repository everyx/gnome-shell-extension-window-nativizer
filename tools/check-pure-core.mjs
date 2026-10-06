#!/usr/bin/env node
/**
 * check-pure-core.mjs - Asserts the decision core reaches no GI module, transitively.
 *
 * The extension's version story rests on one property: what a window's decoration *is* does not
 * depend on the Shell it runs on. That holds only while the modules that make the decision import
 * nothing from `gi://` - everything version-shaped lives in `src/compat/` and the effects, and a
 * decision module that reached one would make a version question out of a policy question.
 *
 * So the check walks the import graph of the decision entry points and fails on any `gi://` or
 * `resource://` specifier anywhere in the closure. Reading `globalThis.imports` lazily is not an
 * import and does not count; only a module-level import does. The closure is printed, so what the
 * guarantee covers is visible rather than asserted.
 *
 * Usage: node tools/check-pure-core.mjs
 */

import {readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The decision entry points. Each is a module whose answer is a policy, not a mechanism: detector
 * (what to draw), rules (which axes the user reversed), frame/snap (the geometry both the clip and
 * the shadow are placed with), style (which parameters a state gets), resizeBand (the grab
 * geometry), pick (the properties a rule is keyed on), and the two pure effect modules (the slice
 * layout and the fade curve).
 */
const ROOTS = [
    'src/lib/detector.js',
    'src/lib/rules.js',
    'src/lib/frame.js',
    'src/lib/snap.js',
    'src/lib/style.js',
    'src/lib/resizeBand.js',
    'src/lib/pick.js',
    'src/effects/shadowGeometry.js',
    'src/effects/shadowFade.js',
];

/** Anything that is not a relative path is a host module; these are the ones that carry a version. */
const VERSIONED = /^(?:gi|resource):/;

function read(rel) {
    const abs = path.join(ROOT, rel);
    if (!existsSync(abs))
        throw new Error(`[check-pure-core] missing module: ${rel}`);
    return readFileSync(abs, 'utf8');
}

/** @param {string} source @returns {string[]} Every specifier the file imports or re-exports */
function specifiers(source) {
    const specs = [];
    for (const re of [/from\s*['"]([^'"]+)['"]/g, /import\s*['"]([^'"]+)['"]/g]) {
        let match;
        while ((match = re.exec(source)) !== null)
            specs.push(match[1]);
    }
    return specs;
}

function main() {
    const closure = new Map();
    const queue = [...ROOTS];

    while (queue.length > 0) {
        const rel = queue.shift();
        if (closure.has(rel))
            continue;
        const specs = specifiers(read(rel));
        closure.set(rel, specs);
        for (const spec of specs) {
            if (spec.startsWith('.'))
                queue.push(path.normalize(path.join(path.dirname(rel), spec)));
        }
    }

    const violations = [];
    for (const [rel, specs] of closure) {
        for (const spec of specs) {
            if (VERSIONED.test(spec))
                violations.push(`${rel} imports ${spec}`);
        }
    }

    for (const rel of [...closure.keys()].sort())
        console.log(`  ${rel}`);

    if (violations.length > 0) {
        console.error('\n[check-pure-core] FAIL: the decision core reaches a versioned module:');
        for (const v of violations)
            console.error(`  ${v}`);
        console.error('Move the call behind src/compat/ and keep the decision on plain values.');
        process.exit(1);
    }

    console.log(`\n[check-pure-core] passed: ${closure.size} modules in the decision closure, no gi:// or resource:// import`);
}

main();
