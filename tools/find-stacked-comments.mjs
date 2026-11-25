#!/usr/bin/env node
/** Prints every doc comment that sits immediately on top of another one, with its file and line. */

import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function* walk(dir) {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory())
            yield* walk(full);
        else if (entry.name.endsWith('.js') && !entry.name.endsWith('.generated.js'))
            yield full;
    }
}

let found = 0;
for (const file of walk(path.join(ROOT, 'src'))) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length - 1; i++) {
        if (lines[i].trimEnd().endsWith('*/') && lines[i + 1].trimStart().startsWith('/**')) {
            console.log(`${path.relative(ROOT, file)}:${i + 1}: ${lines[i].trim()}`);
            found++;
        }
    }
}
process.exit(found > 0 ? 1 : 0);
