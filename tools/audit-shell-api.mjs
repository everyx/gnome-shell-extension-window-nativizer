#!/usr/bin/env node
/**
 * audit-shell-api.mjs - Extracts the Shell / Mutter / Clutter API surface this extension
 * consumes from the local research/ clones, one declaration per audited GNOME version, and
 * records it in tools/shell-api.json.
 *
 * Design: the extension's version claims are only as good as the upstream facts behind them,
 * and hand-written facts rot (four rows of docs/shell-compatibility.md were wrong). So the
 * facts are extracted from a clone at a pinned tag instead of typed, and tools/shell-api.json
 * is the record a reviewer and a checker can both read.
 *
 * What counts as "exists" is the *public header*, not the implementation: GJS only reaches
 * symbols the introspection scanner sees. meta_window_is_maximized is defined in
 * src/core/window.c from 48 on but only declared in src/meta/window.h from 49, so it is not
 * callable from JS until 49 - the distinction is the whole reason this file reads headers.
 *
 * research/ is an uncommitted clone (see .gitignore) kept for exactly this kind of reading.
 * A missing tag is reported with the git fetch command that would fix it.
 *
 * Usage:
 *   node tools/audit-shell-api.mjs --update          Rewrite tools/shell-api.json
 *   node tools/audit-shell-api.mjs --check           Verify the record matches the clones
 *   node tools/audit-shell-api.mjs --diff A B        Print the surface diff between two tags
 */

import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tools', 'shell-api.json');
const RESEARCH = path.join(ROOT, 'research');

const MAJORS = [45, 46, 47, 48, 49, 50, 51];
const SOURCES = {
    mutter: 'https://gitlab.gnome.org/GNOME/mutter',
    'gnome-shell': 'https://gitlab.gnome.org/GNOME/gnome-shell',
};

/**
 * The surface we consume. `member` is how the extension spells it in JS; `kind` decides how
 * the declaration is cut out of the upstream file:
 *   fn     - a C function prototype, cut from its return type to the closing ';'
 *   prop   - a GObject property, cut from g_param_spec_* to its closing ');'
 *   vfunc  - a class-struct slot, cut from '(* name)' to the closing ';'
 *   file   - the file itself, recorded as present/absent
 *   getter - a JS accessor, cut from 'get name()' to the end of the line
 *   const  - a literal in a build file, cut as 'name = value'
 *   enum   - the first value of a C enum, cut as the line that names it
 *   export - a module-level export in a shell JS file, cut as 'export let name = ...'
 * `expectAbsent: true` records an audited negative - a symbol we looked for and did not find. It
 * fails the audit if upstream ever declares it, because the prose says it does not exist.
 */
const SURFACE = [
    // Meta.Window - the window itself
    {id: 'is_client_decorated', member: 'win.is_client_decorated()', repo: 'mutter', kind: 'fn', file: 'src/meta/window.h', sym: 'meta_window_is_client_decorated'},
    {id: 'display_set_cursor', member: 'global.display.set_cursor()', repo: 'mutter', kind: 'fn', file: 'src/meta/display.h', sym: 'meta_display_set_cursor'},
    {id: 'get_client_type', member: 'win.get_client_type()', repo: 'mutter', kind: 'fn', file: 'src/meta/window.h', sym: 'meta_window_get_client_type'},
    {id: 'get_window_type', member: 'win.get_window_type()', repo: 'mutter', kind: 'fn', file: 'src/meta/window.h', sym: 'meta_window_get_window_type'},
    {id: 'is_maximized', member: 'win.is_maximized()', repo: 'mutter', kind: 'fn', file: 'src/meta/window.h', sym: 'meta_window_is_maximized'},
    {id: 'get_maximized', member: 'win.get_maximized()', repo: 'mutter', kind: 'fn', file: 'src/meta/window.h', sym: 'meta_window_get_maximized'},
    {id: 'is_fullscreen', member: 'win.is_fullscreen()', repo: 'mutter', kind: 'fn', file: 'src/meta/window.h', sym: 'meta_window_is_fullscreen'},
    {id: 'get_tile_match', member: 'win.get_tile_match()', repo: 'mutter', kind: 'fn', file: 'src/meta/window.h', sym: 'meta_window_get_tile_match'},
    {id: 'get_pid', member: 'win.get_pid()', repo: 'mutter', kind: 'fn', file: 'src/meta/window.h', sym: 'meta_window_get_pid'},
    {id: 'get_frame_rect', member: 'win.get_frame_rect()', repo: 'mutter', kind: 'fn', file: 'src/meta/window.h', sym: 'meta_window_get_frame_rect'},
    {id: 'get_buffer_rect', member: 'win.get_buffer_rect()', repo: 'mutter', kind: 'fn', file: 'src/meta/window.h', sym: 'meta_window_get_buffer_rect'},
    {id: 'allows_resize', member: 'win.allows_resize()', repo: 'mutter', kind: 'fn', file: 'src/meta/window.h', sym: 'meta_window_allows_resize'},
    {id: 'get_monitor', member: 'win.get_monitor()', repo: 'mutter', kind: 'fn', file: 'src/meta/window.h', sym: 'meta_window_get_monitor'},
    {id: 'begin_grab_op', member: 'win.begin_grab_op()', repo: 'mutter', kind: 'fn', file: 'src/meta/window.h', sym: 'meta_window_begin_grab_op'},
    {id: 'get_compositor_private', member: 'win.get_compositor_private()', repo: 'mutter', kind: 'fn', file: 'src/meta/window.h', sym: 'meta_window_get_compositor_private'},
    {id: 'is_hidden', member: 'win.is_hidden()', repo: 'mutter', kind: 'fn', file: 'src/meta/window.h', sym: 'meta_window_is_hidden'},
    {id: 'is_attached_dialog', member: 'win.is_attached_dialog()', repo: 'mutter', kind: 'fn', file: 'src/meta/window.h', sym: 'meta_window_is_attached_dialog'},
    {id: 'get_transient_for', member: 'win.get_transient_for()', repo: 'mutter', kind: 'fn', file: 'src/meta/window.h', sym: 'meta_window_get_transient_for'},
    {id: 'located_on_workspace', member: 'win.located_on_workspace()', repo: 'mutter', kind: 'fn', file: 'src/meta/window.h', sym: 'meta_window_located_on_workspace'},
    {id: 'is_on_all_workspaces', member: 'win.is_on_all_workspaces()', repo: 'mutter', kind: 'fn', file: 'src/meta/window.h', sym: 'meta_window_is_on_all_workspaces'},
    // Meta.Window - properties (installed from the implementation, not the header)
    {id: 'decorated', member: 'win.decorated', repo: 'mutter', kind: 'prop', file: 'src/core/window.c', sym: 'decorated'},
    {id: 'maximized_vertically', member: 'win.maximized_vertically', repo: 'mutter', kind: 'prop', file: 'src/core/window.c', sym: 'maximized-vertically'},
    {id: 'maximized_horizontally', member: 'win.maximized_horizontally', repo: 'mutter', kind: 'prop', file: 'src/core/window.c', sym: 'maximized-horizontally'},
    {id: 'minimized', member: 'win.minimized', repo: 'mutter', kind: 'prop', file: 'src/core/window.c', sym: 'minimized'},
    // Meta.Display and Meta.Backend
    {id: 'get_monitor_geometry', member: 'global.display.get_monitor_geometry(i)', repo: 'mutter', kind: 'fn', file: 'src/meta/display.h', sym: 'meta_display_get_monitor_geometry'},
    {id: 'get_monitor_scale', member: 'global.display.get_monitor_scale(i)', repo: 'mutter', kind: 'fn', file: 'src/meta/display.h', sym: 'meta_display_get_monitor_scale'},
    {id: 'get_n_monitors', member: 'global.display.get_n_monitors()', repo: 'mutter', kind: 'fn', file: 'src/meta/display.h', sym: 'meta_display_get_n_monitors'},
    {id: 'get_tab_list', member: 'global.display.get_tab_list()', repo: 'mutter', kind: 'fn', file: 'src/meta/display.h', sym: 'meta_display_get_tab_list'},
    {id: 'get_monitor_manager', member: 'global.backend.get_monitor_manager()', repo: 'mutter', kind: 'fn', file: 'src/meta/meta-backend.h', sym: 'meta_backend_get_monitor_manager'},
    // Clutter
    {id: 'set_cursor_type', member: 'actor.set_cursor_type()', repo: 'mutter', kind: 'fn', file: 'clutter/clutter/clutter-actor.h', sym: 'clutter_actor_set_cursor_type'},
    {id: 'set_child_above_sibling', member: 'global.window_group.set_child_above_sibling()', repo: 'mutter', kind: 'fn', file: 'clutter/clutter/clutter-actor.h', sym: 'clutter_actor_set_child_above_sibling'},
    {id: 'set_child_below_sibling', member: 'global.window_group.set_child_below_sibling()', repo: 'mutter', kind: 'fn', file: 'clutter/clutter/clutter-actor.h', sym: 'clutter_actor_set_child_below_sibling'},
    {id: 'bind_constraint_new', member: 'new Clutter.BindConstraint()', repo: 'mutter', kind: 'fn', file: 'clutter/clutter/clutter-bind-constraint.h', sym: 'clutter_bind_constraint_new'},
    {id: 'actor_meta_set_enabled', member: 'effect.set_enabled()', repo: 'mutter', kind: 'fn', file: 'clutter/clutter/clutter-actor-meta.h', sym: 'clutter_actor_meta_set_enabled'},
    {id: 'actor_meta_enabled', member: 'Clutter.ActorMeta:enabled', repo: 'mutter', kind: 'prop', file: 'clutter/clutter/clutter-actor-meta.c', sym: 'enabled'},
    {id: 'actor_meta_get_actor', member: 'effect.get_actor()', repo: 'mutter', kind: 'fn', file: 'clutter/clutter/clutter-actor-meta.h', sym: 'clutter_actor_meta_get_actor'},
    {id: 'offscreen_effect_paint_target', member: 'Clutter.OffscreenEffect:vfunc_paint_target()', repo: 'mutter', kind: 'vfunc', file: 'clutter/clutter/clutter-offscreen-effect.h', sym: 'paint_target'},
    {id: 'clutter_set_uniform_float', member: 'effect.set_uniform_float()', repo: 'mutter', kind: 'fn', file: 'clutter/clutter/clutter-shader-effect.h', sym: 'clutter_shader_effect_set_uniform_float'},
    {id: 'cogl_pipeline_set_uniform_float', member: 'pipeline.set_uniform_float()', repo: 'mutter', kind: 'fn', file: 'cogl/cogl/cogl-pipeline-state.h', sym: 'cogl_pipeline_set_uniform_float'},
    {id: 'offscreen_effect_get_pipeline', member: 'effect.get_pipeline()', repo: 'mutter', kind: 'fn', file: 'clutter/clutter/clutter-offscreen-effect.h', sym: 'clutter_offscreen_effect_get_pipeline'},
    {id: 'cogl_pipeline_set_layer_filters', member: 'pipeline.set_layer_filters()', repo: 'mutter', kind: 'fn', file: 'cogl/cogl/cogl-pipeline-layer-state.h', sym: 'cogl_pipeline_set_layer_filters'},
    {id: 'cogl_pipeline_get_layer_filters', member: 'pipeline.get_layer_filters()', repo: 'mutter', kind: 'fn', file: 'cogl/cogl/cogl-pipeline-layer-state.h', sym: 'cogl_pipeline_get_layer_filters'},
    {id: 'cogl_pipeline_filter', member: 'Cogl.PipelineFilter', repo: 'mutter', kind: 'enum', file: 'cogl/cogl/cogl-pipeline-layer-state.h', sym: 'COGL_PIPELINE_FILTER_NEAREST'},
    // The cursor enum the resize band's directions resolve to. It arrives in 50 with
    // set_cursor_type, and it is recorded because of how it is read: a module-level table of its
    // members is what kept the extension from loading on 45-49 (see platform/actorCursor.js).
    {id: 'clutter_cursor_type', member: 'Clutter.CursorType', repo: 'mutter', kind: 'enum', file: 'clutter/clutter/clutter-enums.h', sym: 'CLUTTER_CURSOR_DEFAULT'},
    {id: 'shell_glsl_set_uniform_float', member: 'effect.set_uniform_float() [Shell.GLSLEffect]', repo: 'gnome-shell', kind: 'fn', file: 'src/shell-glsl-effect.h', sym: 'shell_glsl_effect_set_uniform_float'},
    {id: 'backend_get_sprite', member: 'backend.get_sprite()', repo: 'mutter', kind: 'fn', file: 'clutter/clutter/clutter-backend.h', sym: 'clutter_backend_get_sprite'},
    {id: 'backend_get_pointer_sprite', member: 'backend.get_pointer_sprite()', repo: 'mutter', kind: 'fn', file: 'clutter/clutter/clutter-backend.h', sym: 'clutter_backend_get_pointer_sprite'},
    {id: 'seat_get_pointer', member: 'seat.get_pointer()', repo: 'mutter', kind: 'fn', file: 'clutter/clutter/clutter-seat.h', sym: 'clutter_seat_get_pointer'},
    {id: 'backend_get_default_seat', member: 'backend.get_default_seat()', repo: 'mutter', kind: 'fn', file: 'clutter/clutter/clutter-backend.h', sym: 'clutter_backend_get_default_seat'},
    // Build-time facts the typelib naming depends on
    {id: 'mutter_api_version', member: 'Meta-<api> / Shell-<api> typelibs', repo: 'mutter', kind: 'const', file: 'meson.build', sym: 'libmutter_api_version'},
    // gnome-shell
    {id: 'shell_glsl_effect_h', member: 'Shell.GLSLEffect', repo: 'gnome-shell', kind: 'file', file: 'src/shell-glsl-effect.h'},
    {id: 'window_tracker_get_default', member: 'Shell.WindowTracker.get_default()', repo: 'gnome-shell', kind: 'fn', file: 'src/shell-window-tracker.h', sym: 'shell_window_tracker_get_default'},
    {id: 'st_box_layout_vertical', member: 'St.BoxLayout:vertical', repo: 'gnome-shell', kind: 'prop', file: 'src/st/st-box-layout.c', sym: 'vertical'},
    {id: 'st_system_color_scheme', member: 'St.SystemColorScheme', repo: 'gnome-shell', kind: 'enum', file: 'src/st/st-settings.h', sym: 'ST_SYSTEM_COLOR_SCHEME'},
    {id: 'st_settings_enable_animations', member: 'St.Settings:enable-animations', repo: 'gnome-shell', kind: 'prop', file: 'src/st/st-settings.c', sym: 'enable-animations'},
    {id: 'st_settings_color_scheme', member: 'St.Settings:color-scheme', repo: 'gnome-shell', kind: 'prop', file: 'src/st/st-settings.c', sym: 'color-scheme'},
    {id: 'st_settings_get', member: 'St.Settings.get()', repo: 'gnome-shell', kind: 'fn', file: 'src/st/st-settings.h', sym: 'st_settings_get'},
    {id: 'main_overview', member: 'Main.overview', repo: 'gnome-shell', kind: 'export', file: 'js/ui/main.js', sym: 'overview'},
    {id: 'main_ui_group', member: 'Main.uiGroup', repo: 'gnome-shell', kind: 'export', file: 'js/ui/main.js', sym: 'uiGroup'},
    {id: 'overview_visible', member: 'Main.overview.visible', repo: 'gnome-shell', kind: 'getter', file: 'js/ui/overview.js', sym: 'visible'},
];

const MODE = process.argv.includes('--update') ? 'update'
    : process.argv.includes('--check') ? 'check'
        : process.argv.includes('--diff') ? 'diff' : null;

if (!MODE) {
    console.error('usage: audit-shell-api.mjs --update | --check | --diff <tagA> <tagB>');
    process.exit(2);
}

function git(repo, args) {
    return execFileSync('git', ['-C', path.join(RESEARCH, repo), ...args],
        {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore']});
}

/** The newest patch release of each major line - what a user on that line actually runs. */
function auditedTags(repo) {
    const best = new Map();
    for (const t of git(repo, ['tag', '--list']).split('\n')) {
        const m = /^(\d+)\.(\d+)$/.exec(t.trim());
        if (!m)
            continue;
        const [major, patch] = [Number(m[1]), Number(m[2])];
        if (!MAJORS.includes(major))
            continue;
        if (!best.has(major) || patch > best.get(major).patch)
            best.set(major, {tag: t.trim(), patch});
    }
    return best;
}

function fileAt(repo, ref, file) {
    try {
        return git(repo, ['show', `${ref}:${file}`]);
    } catch {
        return null;
    }
}

function cut(text, re, tail) {
    const m = re.exec(text);
    if (!m)
        return null;
    const end = text.indexOf(tail, m.index);
    if (end < 0)
        throw new Error(`[audit-shell-api] unterminated declaration at "${m[0].slice(0, 60)}"`);
    return text.slice(m.index, end + tail.length).replace(/\s+/g, ' ').trim();
}

function cutFunction(text, sym) {
    // A prototype can be spread over three lines: the export macro, the return type, then the
    // name ("COGL_EXPORT void" / "cogl_pipeline_set_uniform_float (...)"). Walk back over those
    // so the recorded declaration carries the return type a change would show up in.
    const m = new RegExp(`^(?![ \\t]*[*/])[^\\n]*\\b${sym}\\s*\\(`, 'm').exec(text);
    if (!m)
        return null;
    let start = m.index;
    for (let i = 0; i < 2; i++) {
        const prevStart = text.lastIndexOf('\n', start - 2) + 1;
        if (prevStart >= start)
            break;
        const prev = text.slice(prevStart, start).trim();
        if (!/^[A-Z_]+$/.test(prev) && !/^\w+[\w *]*\*?$/.test(prev))
            break;
        start = prevStart;
    }
    const end = text.indexOf(';', start);
    if (end < 0)
        throw new Error(`[audit-shell-api] unterminated prototype for ${sym}`);
    return text.slice(start, end + 1).replace(/\s+/g, ' ').trim();
}

function declaration(text, kind, sym) {
    if (text === null)
        return null;
    switch (kind) {
    case 'fn':
        return cutFunction(text, sym);
    case 'prop':
        return cut(text, new RegExp(`g_param_spec_\\w+ \\(\\s*"${sym}"`), ');');
    case 'vfunc':
        return cut(text, new RegExp(`\\(\\*\\s*${sym}\\s*\\)`), ';');
    case 'getter':
        return cut(text, new RegExp(`^\\s*get ${sym}\\(\\)`, 'm'), '\n').trim();
    case 'file':
        return text === null ? null : 'present';
    case 'export': {
        const m = new RegExp(`^export let ${sym}\\b.*$`, 'm').exec(text ?? '');
        return m ? m[0].trim() : null;
    }
    case 'enum': {
        // An enumerator, with or without an explicit value: which one is recorded does not matter,
        // only that the member is declared, and ClutterCursorType numbers its members implicitly.
        const m = new RegExp(`^\\s*${sym}\\w*\\s*(?:=[^,]*)?,?\\s*$`, 'm').exec(text ?? '');
        return m ? m[0].trim() : null;
    }
    case 'const': {
        const m = new RegExp(`^\\s*${sym}\\s*=\\s*(.+?)\\s*$`, 'm').exec(text ?? '');
        return m ? `${sym} = ${m[1]}` : null;
    }
    default:
        throw new Error(`[audit-shell-api] unknown kind: ${kind}`);
    }
}

function collect(repo, entry, ref) {
    return declaration(fileAt(repo, ref, entry.file), entry.kind, entry.sym);
}

function build() {
    const tags = {mutter: auditedTags('mutter'), 'gnome-shell': auditedTags('gnome-shell')};
    const audited = {};
    for (const major of MAJORS) {
        audited[major] = {};
        for (const repo of Object.keys(SOURCES)) {
            const pin = tags[repo].get(major);
            if (!pin)
                throw new Error(`[audit-shell-api] no tag for GNOME ${major} in research/${repo}`);
            audited[major][repo] = {tag: pin.tag, commit: git(repo, ['rev-parse', `${pin.tag}^{commit}`]).trim()};
        }
    }
    const surface = SURFACE.map(entry => {
        const decl = {};
        for (const major of MAJORS)
            decl[major] = collect(entry.repo, entry, audited[major][entry.repo].tag);
        const present = Object.entries(decl).filter(([, v]) => v !== null).map(([m]) => m);
        if (present.length === 0 && !entry.expectAbsent)
            throw new Error(`[audit-shell-api] ${entry.id}: ${entry.sym} not found in ${entry.repo}:${entry.file} at any audited tag`);
        if (present.length > 0 && entry.expectAbsent)
            throw new Error(`[audit-shell-api] ${entry.id}: expected ${entry.sym} to be absent everywhere, but it is declared in ${present.join(', ')}`);
        return {
            id: entry.id,
            member: entry.member,
            repo: entry.repo,
            kind: entry.kind,
            file: entry.file,
            sym: entry.sym ?? null,
            decl,
        };
    });
    return {
        _comment: 'Generated by tools/audit-shell-api.mjs --update. Facts come from the local research/ clones; see docs/development.md. Do not edit by hand.',
        sources: SOURCES,
        majors: MAJORS,
        audited,
        surface,
    };
}

function report(data) {
    let changed = 0;
    for (const entry of data.surface) {
        const byDecl = new Map();
        for (const major of data.majors) {
            const key = entry.decl[major] ?? '(absent)';
            if (!byDecl.has(key))
                byDecl.set(key, []);
            byDecl.get(key).push(major);
        }
        if (byDecl.size === 1 && !byDecl.has('(absent)'))
            continue;
        changed++;
        console.log(`${entry.member}  [${entry.file}]`);
        for (const [decl, majors] of byDecl)
            console.log(`    ${majors.join(',')}: ${decl}`);
    }
    console.log(`\n${data.surface.length} entries in the surface, ${changed} of them changed between ${data.majors[0]} and ${data.majors.at(-1)}`);
}

if (MODE === 'diff') {
    const [a, b] = process.argv.slice(process.argv.indexOf('--diff') + 1, process.argv.indexOf('--diff') + 3);
    if (!a || !b) {
        console.error('usage: audit-shell-api.mjs --diff <tagA> <tagB>');
        process.exit(2);
    }
    let differing = 0;
    for (const entry of SURFACE) {
        const before = collect(entry.repo, entry, a);
        const after = collect(entry.repo, entry, b);
        if (before === after)
            continue;
        differing++;
        console.log(`${entry.member}  [${entry.repo}:${entry.file}]`);
        console.log(`    ${a}: ${before ?? '(absent)'}`);
        console.log(`    ${b}: ${after ?? '(absent)'}`);
    }
    console.log(`\n${differing} of ${SURFACE.length} entries differ between ${a} and ${b}`);
} else if (MODE === 'check') {
    if (!existsSync(OUT)) {
        console.error(`[audit-shell-api] --check failed: ${path.relative(ROOT, OUT)} does not exist`);
        process.exit(1);
    }
    const existing = readFileSync(OUT, 'utf8');
    const fresh = `${JSON.stringify(build(), null, 4)}\n`;
    if (existing !== fresh) {
        console.error(`[audit-shell-api] --check failed: ${path.relative(ROOT, OUT)} does not match research/ (re-run --update)`);
        process.exit(1);
    }
    console.log('[audit-shell-api] --check passed: the recorded surface matches the research/ clones');
} else {
    const data = build();
    writeFileSync(OUT, `${JSON.stringify(data, null, 4)}\n`, 'utf8');
    console.log(`[audit-shell-api] wrote ${path.relative(ROOT, OUT)}`);
    report(data);
}
