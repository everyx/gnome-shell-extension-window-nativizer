#!/usr/bin/env node
/**
 * Two claims a document makes about this repository that a machine can settle: a path it names
 * exists, and a script it tells you to run is a script.
 *
 * The pair came out of the pre-release audit, where both were checked by hand for one release. A
 * second hand-check is the signal to make it mechanical, so this is that: the audit keeps the
 * sentences a machine cannot read, and this keeps the references honest.
 */

import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Paths the documents may name: the two trees this repository ships and reads, plus the mirror.
 *
 * `src/` is also how the prose writes a path inside Mutter's own tree (`src/x11/window-x11.c`), and
 * that one is a claim about upstream, not about this repository. The first segment decides: if
 * `src/<dir>` is not a directory here, the document is naming someone else's tree.
 */
const EXTENSIONS = 'js|mjs|sh|py|json|xml|c|h|md';
const FILE_PATTERN = new RegExp(
    `\`((?:src|tools|vendor)\\/[A-Za-z0-9_./-]+\\.(?:${EXTENSIONS}))\``, 'g');

/** Directories under `src/`: a bare `lib/x.js` in prose is a path in this tree, unprefixed. */
function srcDirectories(root) {
    const src = path.join(root, 'src');
    if (!existsSync(src))
        return [];
    return readdirSync(src).filter(entry => statSync(path.join(src, entry)).isDirectory());
}

const OUR_TREES = ['tools', 'vendor'];

function isOurs(relative, root) {
    const [first] = relative.split('/');
    if (OUR_TREES.includes(first))
        return true;
    const [top, second] = relative.split('/');
    return statSync(path.join(root, top, second), {throwIfNoEntry: false}) !== undefined;
}
const SCRIPT_PATTERN = /pnpm run ([a-z0-9:-]+)/g;

function* markdownFiles(dir) {
    for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory())
            yield* markdownFiles(full);
        else if (entry.endsWith('.md'))
            yield full;
    }
}

/** Every document this repository ships or works by, skipping anything vendored. */
export function documents(root = ROOT) {
    const found = [];
    for (const entry of readdirSync(root)) {
        if (entry.endsWith('.md'))
            found.push(path.join(root, entry));
    }
    for (const dir of ['docs', '.agents']) {
        const full = path.join(root, dir);
        if (existsSync(full))
            found.push(...markdownFiles(full));
    }
    return found;
}

/** Paths a text names that are not there; `exists` is injected so a test can answer for it. */
export function missingPaths(text, {root = ROOT, exists} = {}) {
    const probe = exists ?? (relative => existsSync(path.join(root, relative)));
    const source = String(text ?? '');

    const named = [...source.matchAll(FILE_PATTERN)].map(match => match[1]);
    // A table row writes `lib/cornerProbe.js`, not `src/lib/cornerProbe.js`.
    const bare = new RegExp(`\`((?:${srcDirectories(root).join('|')})/[A-Za-z0-9_./-]+\\.(?:${EXTENSIONS}))\``, 'g');
    for (const match of source.matchAll(bare))
        named.push(`src/${match[1]}`);

    const missing = new Set();
    for (const relative of named) {
        if (!isOurs(relative, root))
            continue;
        if (!probe(relative))
            missing.add(relative);
    }
    return [...missing];
}

/** Scripts a text tells you to run that `package.json` does not define. */
export function unknownScripts(text, scripts) {
    const unknown = new Set();
    for (const match of String(text ?? '').matchAll(SCRIPT_PATTERN)) {
        if (!scripts.has(match[1]))
            unknown.add(match[1]);
    }
    return [...unknown];
}

function main() {
    const scripts = new Set(Object.keys(JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts));
    const problems = [];
    for (const file of documents()) {
        const text = readFileSync(file, 'utf8');
        const where = path.relative(ROOT, file);
        for (const missing of missingPaths(text))
            problems.push(`${where}: names ${missing}, which does not exist`);
        for (const unknown of unknownScripts(text, scripts))
            problems.push(`${where}: says "pnpm run ${unknown}", which is not a script`);
    }
    for (const problem of problems)
        console.error(`[check-docs] ${problem}`);
    process.exitCode = problems.length > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    main();
