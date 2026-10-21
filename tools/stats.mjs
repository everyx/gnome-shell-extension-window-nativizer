#!/usr/bin/env node
/**
 * Code-size statistics for src/.
 *
 * EGO's quality/code-volume check counts every non-blank JS line in the extension, generated files
 * included, and warns above 8,000. The authored split below excludes *.generated.js and separates
 * code from comment-only and blank lines, so a PR can tell whether it removed code or prose.
 *
 * Comment-only is a line-prefix heuristic, not a JS lexer: a template literal line that starts with
 * `*` or `//` is counted as a comment. EGO non-blank does not depend on that split.
 *
 * CI runs the head version against both trees: a counting change then shows up as one visible
 * delta instead of silently rebasing the number.
 *
 * Usage: node tools/stats.mjs [--root <path>] [--json] [--top <n>] [--check]
 */

import {existsSync, readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EGO_LIMIT = 8000;
const USAGE = 'usage: node tools/stats.mjs [--root <path>] [--json] [--top <n>] [--check]';

function fail(message) {
    console.error(`[stats] ${message}`);
    process.exit(2);
}

function parseArgs(argv) {
    const options = {root: DEFAULT_ROOT, json: false, top: 10, check: false};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--json') {
            options.json = true;
        } else if (arg === '--check') {
            options.check = true;
        } else if (arg === '--root') {
            const value = argv[++i];
            if (!value)
                fail(`${arg} needs a path`);
            options.root = path.resolve(value);
        } else if (arg === '--top') {
            const value = Number.parseInt(argv[++i], 10);
            if (!Number.isInteger(value) || value <= 0)
                fail(`${arg} needs a positive integer`);
            options.top = value;
        } else if (arg === '--help' || arg === '-h') {
            console.log(USAGE);
            process.exit(0);
        } else {
            fail(`unknown argument: ${arg}\n${USAGE}`);
        }
    }
    return options;
}

function listJsFiles(dir) {
    const files = [];
    const visit = current => {
        for (const entry of readdirSync(current, {withFileTypes: true})) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory())
                visit(full);
            else if (entry.isFile() && entry.name.endsWith('.js'))
                files.push(full);
        }
    };
    visit(dir);
    return files.sort();
}

/**
 * A line is comment-only when its first non-space characters start a comment. Lines with code and a
 * trailing comment count as code. This is deliberately a line-prefix heuristic, not a lexer: it
 * keeps the metric stable across refactors and costs no parser dependency. The limitations are that
 * comment-like lines inside template literals are counted as comments, and a generator method line
 * (`*items() {`) is counted as comment-only. EGO's non-blank total is the authoritative number, and
 * this split is only for reading a diff.
 */
function classify(content) {
    const lines = content.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === '')
        lines.pop();

    let blank = 0;
    let commentOnly = 0;
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') {
            blank++;
        } else if (trimmed.startsWith('//') || trimmed.startsWith('/*') ||
                   trimmed.startsWith('*') || trimmed.startsWith('*/')) {
            commentOnly++;
        }
    }

    const total = lines.length;
    const nonBlank = total - blank;
    return {total, nonBlank, code: nonBlank - commentOnly, commentOnly, blank};
}

function add(target, stats) {
    for (const key of ['total', 'nonBlank', 'code', 'commentOnly', 'blank'])
        target[key] += stats[key];
}

const options = parseArgs(process.argv.slice(2));
const src = path.join(options.root, 'src');
if (!existsSync(src))
    fail(`no src/ under ${options.root}`);

const files = listJsFiles(src);
if (files.length === 0)
    fail(`no .js files under ${src}`);

const authoredFiles = [];
const authored = {total: 0, nonBlank: 0, code: 0, commentOnly: 0, blank: 0};
const generated = {total: 0, nonBlank: 0, code: 0, commentOnly: 0, blank: 0};
let egoNonBlank = 0;

for (const file of files) {
    const stats = classify(readFileSync(file, 'utf8'));
    egoNonBlank += stats.nonBlank;
    if (file.endsWith('.generated.js')) {
        add(generated, stats);
    } else {
        add(authored, stats);
        authoredFiles.push({
            path: path.relative(options.root, file).split(path.sep).join('/'),
            ...stats,
        });
    }
}

const largest = [...authoredFiles]
    .sort((a, b) => b.nonBlank - a.nonBlank || a.path.localeCompare(b.path))
    .slice(0, options.top);

const result = {
    ego: {
        nonBlank: egoNonBlank,
        limit: EGO_LIMIT,
        over: Math.max(0, egoNonBlank - EGO_LIMIT),
        status: egoNonBlank > EGO_LIMIT ? 'warn' : 'pass',
    },
    authored,
    generated,
    files: {
        total: files.length,
        authored: authoredFiles.length,
        generated: files.length - authoredFiles.length,
    },
    largest,
    authoredFiles,
};

const fmt = value => new Intl.NumberFormat('en-US').format(value);

if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
    console.log(`src stats — ${options.root}`);
    console.log(`  files          ${fmt(result.files.total)} (${fmt(result.files.authored)} authored, ${fmt(result.files.generated)} generated)`);
    console.log(`  EGO non-blank  ${fmt(result.ego.nonBlank)} / ${fmt(EGO_LIMIT)}${result.ego.over ? ` (${fmt(result.ego.over)} over)` : ' (within budget)'}`);
    console.log(`  authored       ${fmt(authored.total)} lines = ${fmt(authored.code)} code + ${fmt(authored.commentOnly)} comment-only + ${fmt(authored.blank)} blank`);
    console.log(`  generated      ${fmt(generated.total)} lines (${fmt(generated.nonBlank)} non-blank)`);
    console.log('  note           comment-only is a line-prefix heuristic; EGO non-blank is exact');
    console.log('  largest authored files (non-blank):');
    for (const file of largest)
        console.log(`    ${String(file.nonBlank).padStart(5)}  ${file.path}`);
}

if (options.check && result.ego.nonBlank > EGO_LIMIT) {
    console.error(`[stats] EGO non-blank ${fmt(result.ego.nonBlank)} exceeds ${fmt(EGO_LIMIT)}`);
    process.exitCode = 1;
}
