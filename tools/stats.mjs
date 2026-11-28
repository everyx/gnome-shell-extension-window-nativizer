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
 * `--check` fails above 8,000 lines, or above the overage the repository has declared in
 * `tools/ego-lint-baseline.txt` (`# accepted-overage: N`). The declaration is the same decision as
 * the accepted `quality/code-volume` finding, so the gate and the baseline cannot disagree.
 *
 * It also fails when the tree is *below* the declared ceiling: a budget whose declared number drifts
 * away from the real one leaves slack that nobody remembers granting, and that slack is what the next
 * feature spends. The same `--check` reads `tools/comment-budget.txt` for the comment-only share.
 *
 * Usage: node tools/stats.mjs [--root <path>] [--json] [--top <n>] [--check]
 */

import {existsSync, readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EGO_LIMIT = 8000;
// How far under a declared comment ceiling counts as "the declaration is stale". A ratio moves with
// every edit, so holding it to exact equality would fail on arithmetic rather than on a decision.
const RATCHET_SLACK = 2;
const USAGE = 'usage: node tools/stats.mjs [--root <path>] [--json] [--top <n>] [--check]';

/** The overage the repository has declared, or 0 when it declares none. */
export function acceptedOverage(baselineText) {
    const match = /^#\s*accepted-overage:\s*(\d+)/m.exec(String(baselineText ?? ''));
    return match ? Number(match[1]) : 0;
}

/**
 * The declared comment ceilings, and every reason the file cannot be read as one. A budget that
 * answers nulls instead of errors is a budget that can be typed away: `totals 11` used to drop the
 * whole-tree check without a word.
 */
/** What each field may declare; a number outside its range is a broken file, not a stricter one. */
const BUDGET_RANGES = {total: [0, 100], file: [0, 100], 'min-lines': [0, Number.POSITIVE_INFINITY]};

export function commentBudget(text) {
    const source = String(text ?? '');
    const errors = [];
    const read = (key, fallback) => {
        const found = [...source.matchAll(new RegExp(`^${key}\\s+(\\S+)\\s*$`, 'gm'))];
        if (found.length === 0) {
            if (fallback !== undefined)
                return fallback;
            errors.push(`"${key}" is not declared`);
            return null;
        }
        if (found.length > 1) {
            errors.push(`"${key}" is declared ${found.length} times`);
            return null;
        }
        const value = Number(found[0][1]);
        if (!Number.isInteger(value)) {
            errors.push(`"${key}" is not a whole number: ${found[0][1]}`);
            return null;
        }
        const [low, high] = BUDGET_RANGES[key];
        if (value < low || value > high) {
            errors.push(`"${key}" is out of range: ${value}`);
            return null;
        }
        return value;
    };

    const total = read('total');
    const file = read('file');
    const minLines = read('min-lines');
    return {total, file, minLines, errors};
}

function declaredCommentBudget(root) {
    let text = null;
    try {
        text = readFileSync(path.join(root, 'tools', 'comment-budget.txt'), 'utf8');
    } catch {
        return {budget: null, errors: ['tools/comment-budget.txt is missing, so no comment ceiling is declared']};
    }
    const budget = commentBudget(text);
    return {budget, errors: budget.errors.map(error => `tools/comment-budget.txt: ${error}`)};
}

function declaredOverage(root) {
    try {
        return acceptedOverage(readFileSync(path.join(root, 'tools', 'ego-lint-baseline.txt'), 'utf8'));
    } catch {
        return 0;
    }
}

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

const acceptedOverageHere = declaredOverage(options.root);
const limit = EGO_LIMIT + acceptedOverageHere;
const result = {
    ego: {
        nonBlank: egoNonBlank,
        limit,
        accepted: acceptedOverageHere,
        over: Math.max(0, egoNonBlank - limit),
        status: egoNonBlank > limit ? 'fail' : egoNonBlank > EGO_LIMIT ? 'warn' : 'pass',
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
    const budget = result.ego.accepted
        ? `${fmt(EGO_LIMIT)} + ${fmt(result.ego.accepted)} accepted`
        : fmt(EGO_LIMIT);
    console.log(`  EGO non-blank  ${fmt(result.ego.nonBlank)} / ${budget}${result.ego.over ? ` (${fmt(result.ego.over)} over)` : ''}`);
    console.log(`  authored       ${fmt(authored.total)} lines = ${fmt(authored.code)} code + ${fmt(authored.commentOnly)} comment-only + ${fmt(authored.blank)} blank`);
    console.log(`  generated      ${fmt(generated.total)} lines (${fmt(generated.nonBlank)} non-blank)`);
    console.log('  note           comment-only is a line-prefix heuristic; EGO non-blank is exact');
    console.log('  largest authored files (non-blank):');
    for (const file of largest)
        console.log(`    ${String(file.nonBlank).padStart(5)}  ${file.path}`);
}

if (options.check) {
    const failures = [];
    const share = (commentOnly, nonBlank) => (nonBlank > 0 ? (commentOnly / nonBlank) * 100 : 0);

    // Two-sided: a tree that grew past the declaration fails, and so does one that shrank below it,
    // because the difference between "declared" and "actual" is a licence nobody remembers granting.
    if (result.ego.nonBlank > limit) {
        failures.push(`EGO non-blank ${fmt(result.ego.nonBlank)} exceeds ${fmt(limit)} ` +
            `(${fmt(EGO_LIMIT)} + ${fmt(acceptedOverageHere)} accepted)`);
    } else if (acceptedOverageHere > 0 && result.ego.nonBlank < limit) {
        // Only a declared overage can be stale: with none, being under 8,000 is the goal, not a drift.
        const declared = Math.max(0, result.ego.nonBlank - EGO_LIMIT);
        failures.push(`EGO non-blank ${fmt(result.ego.nonBlank)} is below the declared ceiling ` +
            `${fmt(limit)}: write "# accepted-overage: ${declared}" in tools/ego-lint-baseline.txt`);
    }

    const {budget, errors} = declaredCommentBudget(options.root);
    failures.push(...errors);
    if (budget && errors.length === 0) {
        const overall = share(authored.commentOnly, authored.nonBlank);
        if (overall > budget.total) {
            failures.push(`comment-only is ${overall.toFixed(1)}% of authored non-blank lines, above ` +
                `the declared ${budget.total}%`);
        } else if (overall < budget.total - RATCHET_SLACK) {
            // Rounded up: a floor would suggest a number below the measurement, and the next run
            // would fail the check above instead of passing.
            failures.push(`comment-only is ${overall.toFixed(1)}%, more than ${RATCHET_SLACK} points ` +
                `under the declared ${budget.total}%: write "total ${Math.ceil(overall)}" in ` +
                'tools/comment-budget.txt');
        }
        for (const file of authoredFiles) {
            if (file.nonBlank < budget.minLines)
                continue;
            const ratio = share(file.commentOnly, file.nonBlank);
            if (ratio > budget.file)
                failures.push(`${file.path}: comment-only is ${ratio.toFixed(1)}% of its ` +
                    `${file.nonBlank} non-blank lines, above the declared ${budget.file}%`);
        }
    }

    if (failures.length > 0) {
        for (const failure of failures)
            console.error(`[stats] ${failure}`);
        process.exitCode = 1;
    } else if (result.ego.nonBlank > EGO_LIMIT) {
        console.log(`[stats] EGO non-blank ${fmt(result.ego.nonBlank)} is within the accepted ` +
            `ceiling of ${fmt(limit)} (${fmt(EGO_LIMIT)} + ${fmt(acceptedOverageHere)})`);
    }
}
