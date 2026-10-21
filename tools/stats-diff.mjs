#!/usr/bin/env node
/**
 * Renders a base→head code-size comment for a pull request.
 *
 * Inputs are `tools/stats.mjs --json` reports. CI runs the head version against both trees, so a
 * counting-rule change appears as one visible delta instead of silently rebasing the number.
 *
 * Usage: node tools/stats-diff.mjs <base.json> <head.json> [--base-sha <sha>] [--head-sha <sha>]
 */

import {readFileSync} from 'node:fs';

const MARKER = '<!-- window-nativizer-code-stats -->';
const USAGE = 'usage: node tools/stats-diff.mjs <base.json> <head.json> [--base-sha <sha>] [--head-sha <sha>]';

function fail(message) {
    console.error(`[stats-diff] ${message}`);
    process.exit(2);
}

function readReport(file) {
    let report;
    try {
        report = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
        fail(`cannot read ${file}: ${error.message}`);
    }
    if (!report?.ego || !report?.authored || !report?.files)
        fail(`${file} is not a stats.mjs report`);
    return report;
}

const argv = process.argv.slice(2);
const positional = [];
let baseSha = '';
let headSha = '';
for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base-sha') {
        baseSha = argv[++i] ?? '';
    } else if (argv[i] === '--head-sha') {
        headSha = argv[++i] ?? '';
    } else {
        positional.push(argv[i]);
    }
}
if (positional.length !== 2)
    fail(USAGE);

const base = readReport(positional[0]);
const head = readReport(positional[1]);
const fmt = value => new Intl.NumberFormat('en-US').format(value);
const signed = value => value === 0 ? '0' : value > 0 ? `+${fmt(value)}` : `-${fmt(Math.abs(value))}`;
const shortSha = sha => sha ? sha.slice(0, 7) : '';

const rows = [
    ['**EGO non-blank**', base.ego.nonBlank, head.ego.nonBlank],
    ['Authored code', base.authored.code, head.authored.code],
    ['Comment-only (heuristic)', base.authored.commentOnly, head.authored.commentOnly],
    ['Blank', base.authored.blank, head.authored.blank],
    ['Authored files', base.files.authored, head.files.authored],
];

const budget = head.ego.nonBlank <= head.ego.limit
    ? `within the ${fmt(head.ego.limit)} budget`
    : `**${fmt(head.ego.nonBlank - head.ego.limit)} over** the ${fmt(head.ego.limit)} budget (warning only; CI does not fail)`;

function fileMap(report) {
    const files = report.authoredFiles ?? report.largest ?? [];
    return new Map(files.map(file => [file.path, file]));
}

const baseFiles = fileMap(base);
const headFiles = fileMap(head);
const changes = [...new Set([...baseFiles.keys(), ...headFiles.keys()])]
    .map(file => ({
        path: file,
        base: baseFiles.get(file)?.nonBlank ?? 0,
        head: headFiles.get(file)?.nonBlank ?? 0,
    }))
    .map(change => ({...change, delta: change.head - change.base}))
    .filter(change => change.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.path.localeCompare(b.path))
    .slice(0, 5);

const out = [MARKER, '### 📏 Code stats', ''];
if (baseSha || headSha) {
    const from = baseSha ? `base \`${shortSha(baseSha)}\`` : 'base';
    const to = headSha ? `head \`${shortSha(headSha)}\`` : 'head';
    out.push(`${from} → ${to}`, '');
}
out.push('| Metric | Base | Head | Δ |');
out.push('| :--- | ---: | ---: | ---: |');
for (const [label, from, to] of rows)
    out.push(`| ${label} | ${fmt(from)} | ${fmt(to)} | ${signed(to - from)} |`);
out.push('', `**EGO budget:** ${fmt(head.ego.nonBlank)} / ${fmt(head.ego.limit)} — ${budget}.`);

if (changes.length > 0) {
    out.push('', '**Largest file changes (non-blank lines):**', '');
    out.push('| File | Base | Head | Δ |');
    out.push('| :--- | ---: | ---: | ---: |');
    for (const change of changes) {
        const file = change.path.replaceAll('`', '\\`');
        out.push(`| \`${file}\` | ${fmt(change.base)} | ${fmt(change.head)} | ${signed(change.delta)} |`);
    }
}

out.push('', '<sub>Authored counts exclude `*.generated.js`; EGO includes them. Comment-only lines use a line-prefix heuristic (template content can count as a comment); EGO non-blank is exact.</sub>');
out.push('', '*This comment updates on every push to the PR.*');

process.stdout.write(`${out.join('\n')}\n`);
