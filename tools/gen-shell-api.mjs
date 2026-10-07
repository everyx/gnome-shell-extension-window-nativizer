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
const SUPPORT_START = '<!-- shell-support-table:start -->';
const SUPPORT_END = '<!-- shell-support-table:end -->';

/**
 * What the extension offers, and the declarations each offer stands on. A feature is available on a
 * line when every requirement of it is met there; a requirement naming several ids is met by any one
 * of them, which is the shape the two moved APIs have (the shader base class from Shell to Clutter,
 * the pointer source from a seat to a sprite).
 *
 * This is the answer to "what would a line lose?", computed from the same record the table above
 * comes from, so it cannot drift from it - and it is what lets a claim be widened one line at a time
 * rather than all at once. A requirement that a declaration merely *exists* is the common case;
 * `contains` is for the one where the shape matters.
 */
const FEATURES = [
    {
        // The clip effect subclasses whichever shader base the line ships.
        name: 'Rounded corners (the clip)',
        needs: [{any: ['shell_glsl_effect_h', 'shader_effect_header']}],
    },
    {
        // The vfunc to paint through, and a Cogl context to paint with: the paint pass hands one
        // over from 47, and on 45-46 the backend answers for it instead (see compat/coglContext.js).
        name: 'Window shadow',
        needs: [{any: ['actor_paint_node', 'pipeline_node_new']},
            {any: ['backend_get_cogl_context']},
            {id: 'cogl_texture_2d_new_with_size', notContains: '(skip)'}],
    },
    {
        name: 'Resize band (the grab)',
        needs: [{any: ['begin_grab_op']},
            {any: ['backend_get_sprite', 'backend_get_pointer_sprite', 'backend_get_default_seat']}],
    },
    {
        // Without per-actor cursors the band still grabs; the pointer keeps the default shape.
        name: 'Resize cursor',
        needs: [{any: ['set_cursor_type']}],
    },
    {
        name: 'Tiled ring colour',
        needs: [{any: ['st_settings_color_scheme', 'st_system_color_scheme']}],
    },
    {
        name: 'Focus / backdrop fade',
        needs: [{any: ['st_settings_enable_animations']}],
    },
    {
        // /proc/<pid>/maps is kernel and GIO API, so nothing here is versioned at all.
        name: 'Native-app detection',
        needs: [],
    },
];

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

function splice(document, block, start, end) {
    const from = document.indexOf(start);
    const to = document.indexOf(end);
    if (from < 0 || to < 0 || to < from)
        throw new Error(`[gen-shell-api] ${path.relative(ROOT, DOC)} is missing the ${start} / ${end} markers`);
    return `${document.slice(0, from + start.length)}\n${block}\n${document.slice(to)}`;
}

/**
 * @param {Map<string, object>} entryById
 * @param {{id?: string, any?: string[], contains?: string}} requirement
 * @param {string} major
 * @returns {boolean}
 */
function requirementMet(entryById, requirement, major) {
    if (requirement.any)
        return requirement.any.some(id => entryById.get(id)?.decl[major] != null);
    const decl = entryById.get(requirement.id)?.decl[major];
    if (decl == null)
        return false;
    if (requirement.contains && !decl.includes(requirement.contains))
        return false;
    // `notContains` is how a GIR skip is expressed: the declaration is there and introspection does
    // not carry it, which no table of declarations can say on its own.
    if (requirement.notContains && decl.includes(requirement.notContains))
        return false;
    return true;
}

/**
 * The support matrix: one row per feature, one column per audited line. A cell reads `degraded`
 * where the feature is missing, which is the difference between "this line loses something" and
 * "nothing ships this anywhere yet".
 * @param {object} record
 * @returns {string}
 */
function renderSupportTable(record) {
    const entryById = new Map(record.surface.map(e => [e.id, e]));
    const majors = record.majors;
    const rows = [`| Feature | ${majors.join(' | ')} |`, `|${'---|'.repeat(majors.length + 1)}`];

    for (const feature of FEATURES) {
        const cells = majors.map(major =>
            (feature.needs.every(req => requirementMet(entryById, req, major)) ? 'yes' : '**degraded**'));
        rows.push(`| ${feature.name} | ${cells.join(' | ')} |`);
    }
    return rows.join('\n');
}

const record = JSON.parse(read(RECORD));
const ids = noteIds();
const {table, missing} = renderTable(record, ids);
const supportTable = renderSupportTable(record);
const document = read(DOC);
const generated = splice(splice(document, table, START, END), supportTable, SUPPORT_START, SUPPORT_END);

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
