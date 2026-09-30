#!/usr/bin/env node
/**
 * check-shell-version.mjs - Fails when src/metadata.json claims a Shell version the API record has
 * not audited.
 *
 * `shell-version` is the one fact in the manifest a user acts on: it decides whether
 * extensions.gnome.org offers the extension at all, and a stale or optimistic claim is not a quiet
 * bug - it either tells people on a supported Shell that the extension is incompatible, or it
 * claims a version whose APIs nobody has read. The claim itself is a product decision, so nothing
 * here derives it. What can be mechanised is the other half: a major may only be claimed once
 * tools/shell-api.json has recorded it, with the tag and commit the audit read. Before this check
 * existed the claim had no reader at all.
 *
 * The lower bound stays a judgement and is not checked: the record covers 45-51, the manifest claims
 * a subset of it, and choosing that subset is the human act described in docs/development.md
 * § Upstream API audit.
 *
 * Usage: node tools/check-shell-version.mjs [--check]
 *   --check: the only mode, accepted so the tool reads like the rest of the check-style chain.
 */

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'src', 'metadata.json');
const RECORD = path.join(ROOT, 'tools', 'shell-api.json');

function read(file) {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
        throw new Error(`[check-shell-version] cannot read ${path.relative(ROOT, file)}: ${e.message}`);
    }
}

function fail(message) {
    console.error(`[check-shell-version] FAIL: ${message}`);
    process.exit(1);
}

const manifest = read(MANIFEST);
const record = read(RECORD);
const claimed = manifest['shell-version'];
const covered = record.majors ?? [];
const audited = record.audited ?? {};

if (!covered.length)
    fail('tools/shell-api.json has no "majors": the record itself is missing');
if (!Array.isArray(claimed) || claimed.length === 0)
    fail(`${path.relative(ROOT, MANIFEST)} needs a non-empty "shell-version" array`);

const majors = claimed.map(v => (/^\d+$/.test(String(v)) ? Number(v) : NaN));
const malformed = claimed.filter((_, i) => Number.isNaN(majors[i]));
if (malformed.length)
    fail(`"shell-version" entries must be plain major numbers: ${malformed.join(', ')}`);

const repeated = majors.filter((m, i) => majors.indexOf(m) !== i);
if (repeated.length)
    fail(`"shell-version" repeats ${[...new Set(repeated)].join(', ')}`);

const coverage = `${Math.min(...covered)}-${Math.max(...covered)}`;
const unknown = majors.filter(m => !covered.includes(m));
if (unknown.length) {
    fail(`claims ${unknown.join(', ')}, which tools/shell-api.json has not audited (it covers ` +
        `${coverage}). Fetch the tag, read the migration notes, then run ` +
        '`node tools/audit-shell-api.mjs --update`; or drop the claim.');
}

const untagged = majors.filter(m => !audited[String(m)]?.mutter?.tag || !audited[String(m)]?.['gnome-shell']?.tag);
if (untagged.length)
    fail(`no mutter/gnome-shell tag in "audited" for ${untagged.join(', ')}`);

const inOrder = [...majors].sort((a, b) => a - b).join(', ');
console.log(`[check-shell-version] --check passed: claims ${inOrder} of the audited ${coverage}, ` +
    'each with a mutter/gnome-shell tag');
