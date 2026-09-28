#!/usr/bin/env node
/**
 * gen-shell-api.mjs - Generates the API table in docs/shell-compatibility.md from
 * tools/shell-api.json, linking every row to its prose in docs/shell-api.md.
 *
 * Design: the table's facts are derived, never typed. The hand-written version of this table had
 * four wrong rows - the grab-op row gave 45 the signature 46 introduced, two rows named
 * Clutter.Effect for slots that live on Clutter.ActorMeta and Clutter.OffscreenEffect, and
 * St.BoxLayout:vertical was attributed to St.Widget - and nothing could notice, because a fact
 * typed into prose has no reader that can disagree with it. Here the status column is computed
 * from the declarations in tools/shell-api.json, so a claim that disagrees with upstream cannot be
 * written down in the first place.
 *
 * The prose stays hand-written, in docs/shell-api.md, and the table links to it by anchor. That is
 * the split: what a machine can extract is extracted, what it cannot is one link away. --check
 * also fails on a link to a section that does not exist, so the two files cannot drift apart.
 *
 * Usage: node tools/gen-shell-api.mjs [--check]
 *   --check: Verifies the generated table matches docs/shell-compatibility.md (used by
 *            check-style), exits with 1 on any difference or dangling link.
 */

import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECORD = path.join(ROOT, 'tools', 'shell-api.json');
const NOTES = path.join(ROOT, 'docs', 'shell-api.md');
const DOC = path.join(ROOT, 'docs', 'shell-compatibility.md');
const NOTES_FILE = 'shell-api.md';

const START = '<!-- shell-api-table:start -->';
const END = '<!-- shell-api-table:end -->';

const CHECK = process.argv.includes('--check');

function read(file) {
    if (!existsSync(file))
        throw new Error(`[gen-shell-api] missing file: ${path.relative(ROOT, file)}`);
    return readFileSync(file, 'utf8');
}

/** The ids docs/shell-api.md has prose for, taken from its level-two headings. */
function noteIds() {
    const ids = new Set();
    for (const line of read(NOTES).split('\n')) {
        const m = /^##\s+(\S+)\s*$/.exec(line);
        if (m)
            ids.add(m[1]);
    }
    return ids;
}

function rangeText(range) {
    const runs = [];
    let [start, prev] = [range[0], range[0]];
    for (const m of range.slice(1)) {
        if (m === prev + 1) {
            prev = m;
            continue;
        }
        runs.push([start, prev]);
        [start, prev] = [m, m];
    }
    runs.push([start, prev]);
    return runs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
}

/**
 * The status is read straight off the recorded declarations: which GNOME lines share a shape, and
 * which have none. Nothing here knows what any of it means - that is what the prose is for.
 */
function statusOf(entry, majors) {
    const groups = [];
    for (const major of majors) {
        const key = entry.decl[major] ?? null;
        const last = groups.at(-1);
        if (last && last.key === key)
            last.range.push(major);
        else
            groups.push({key, range: [major]});
    }
    if (groups.length === 1)
        return groups[0].key === null ? '**does not exist**' : `${rangeText(groups[0].range)} stable`;
    return groups
        .map(g => `${rangeText(g.range)}${g.key === null ? ' absent' : ''}`)
        .join(' / ');
}

function renderTable(record, ids) {
    const rows = ['| Used | Status | Notes |', '|---|---|---|'];
    const dangling = [];
    for (const entry of record.surface) {
        const hasNote = ids.has(entry.id);
        if (!hasNote)
            dangling.push(entry.id);
        const notes = hasNote ? `[why](${NOTES_FILE}#${entry.id})` : '—';
        rows.push(`| \`${entry.member}\` | ${statusOf(entry, record.majors)} | ${notes} |`);
    }
    return {table: rows.join('\n'), missing: dangling};
}

function splice(document, table) {
    const start = document.indexOf(START);
    const end = document.indexOf(END);
    if (start < 0 || end < 0 || end < start)
        throw new Error(`[gen-shell-api] ${path.relative(ROOT, DOC)} is missing the ${START} / ${END} markers`);
    return `${document.slice(0, start + START.length)}\n${table}\n${document.slice(end)}`;
}

const record = JSON.parse(read(RECORD));
const ids = noteIds();
const {table, missing} = renderTable(record, ids);
const document = read(DOC);
const generated = splice(document, table);

// Every row links to prose, and prose that no row links to is dead weight a reader will find and
// trust. Both directions are checked, because both are ways for the two files to disagree.
const linked = new Set(record.surface.filter(e => ids.has(e.id)).map(e => e.id));
const orphans = [...ids].filter(id => !linked.has(id));

if (CHECK) {
    if (missing.length > 0)
        console.error(`[gen-shell-api] --check failed: no prose in ${NOTES_FILE} for ${missing.join(', ')}`);
    if (orphans.length > 0)
        console.error(`[gen-shell-api] --check failed: ${NOTES_FILE} has sections no row links to: ${orphans.join(', ')}`);
    if (generated !== document)
        console.error(`[gen-shell-api] --check failed: the table in ${path.relative(ROOT, DOC)} does not match tools/shell-api.json (re-run gen-shell-api.mjs)`);
    if (missing.length > 0 || orphans.length > 0 || generated !== document)
        process.exit(1);
    console.log(`[gen-shell-api] --check passed: ${record.surface.length} rows match the record, every row has prose`);
} else {
    writeFileSync(DOC, generated, 'utf8');
    console.log(`[gen-shell-api] wrote the table into ${path.relative(ROOT, DOC)} (${record.surface.length} rows)`);
    if (missing.length > 0)
        console.error(`[gen-shell-api] no prose in ${NOTES_FILE} for: ${missing.join(', ')}`);
    if (orphans.length > 0)
        console.error(`[gen-shell-api] ${NOTES_FILE} has sections no row links to: ${orphans.join(', ')}`);
}
