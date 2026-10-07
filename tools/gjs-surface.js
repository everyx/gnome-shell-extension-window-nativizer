#!/usr/bin/env gjs -m
/**
 * gjs-surface.js - Asserts that the Shell / Mutter / Clutter members this extension calls are
 * actually callable from GJS on the shell it is running against, with the shape the code assumes,
 * and prints the signature of every one of them.
 *
 * Design: tools/audit-shell-api.mjs reads public headers, which proves a declaration exists but
 * not that GJS can reach it. Three things live in that gap and all three have bitten us:
 *
 *   - Out-arguments are not visible in C. meta_window_get_buffer_rect takes two parameters and
 *     carries no annotation; GJS calls it with none and gets a rectangle back.
 *   - Properties and methods are not the same thing. GJS installs a get/set accessor pair for
 *     every GObject property and separately exposes the C accessors as methods when the header
 *     declares them - Clutter.ActorMeta has both an `enabled` property and a set_enabled method.
 *   - (skip) annotations and private headers leave a symbol declared but unreachable. Meta.Display
 *     declares no get_default_seat in any of 45-51, and the prototype agrees: undefined.
 *
 * The assertion boundary is the boundary of what the code assumes. Existence is asserted for
 * everything the extension calls, because it is the cheapest check with the widest reach; arity
 * and parameter names are asserted only where the code depends on them - a parameter that changed
 * from `device` to `sprite` keeps its arity, and arity is exactly what the grab-op dispatch reads.
 * Everything else is printed, not asserted: an assertion needs a hand-written expectation, and a
 * hand-written expectation is what this whole audit exists to stop trusting.
 *
 * The GJS wrapper's source text is where the parameter names come from. That is an implementation
 * detail of GJS, which is why it lives in a test rather than in the extension.
 *
 * Namespaces are imported dynamically because St only loads inside the shell: outside it the
 * typelib's libst is not on the loader path, and a static import would take the whole script down
 * with it. A namespace that cannot load is reported and skipped, not failed.
 *
 * Usage: gjs -m tools/gjs-surface.js [--verbose]
 */

import GLib from 'gi://GLib';
import System from 'system';

const VERBOSE = ARGV.includes('--verbose');
const SCRIPT = GLib.filename_from_uri(import.meta.url)[0];
const ROOT = GLib.path_get_dirname(GLib.path_get_dirname(SCRIPT));
const RECORD = GLib.build_filenamev([ROOT, 'tools', 'shell-api.json']);

/**
 * Every member the extension calls. `params` is the parameter list the call site assumes, checked
 * against the GJS wrapper; `arity` is the count, for members whose shape the code reads but whose
 * parameter names carry no meaning to it. `optional` means the code degrades when it is missing.
 */
const SURFACE = [
    // Meta.Window - methods
    {ns: 'Meta', cls: 'Window', member: 'get_client_type', arity: 0},
    {ns: 'Meta', cls: 'Window', member: 'get_window_type', arity: 0},
    {ns: 'Meta', cls: 'Window', member: 'is_maximized', arity: 0, optional: true},
    {ns: 'Meta', cls: 'Window', member: 'get_maximized', arity: 0, optional: true},
    {ns: 'Meta', cls: 'Window', member: 'is_fullscreen', arity: 0},
    {ns: 'Meta', cls: 'Window', member: 'get_tile_match', arity: 0},
    {ns: 'Meta', cls: 'Window', member: 'get_pid', arity: 0},
    {ns: 'Meta', cls: 'Window', member: 'get_frame_rect', arity: 0},
    {ns: 'Meta', cls: 'Window', member: 'get_buffer_rect', arity: 0},
    {ns: 'Meta', cls: 'Window', member: 'allows_resize', arity: 0},
    {ns: 'Meta', cls: 'Window', member: 'get_monitor', arity: 0},
    {ns: 'Meta', cls: 'Window', member: 'begin_grab_op', params: ['op', 'sprite', 'timestamp', 'pos_hint']},
    {ns: 'Meta', cls: 'Window', member: 'get_compositor_private', arity: 0},
    {ns: 'Meta', cls: 'Window', member: 'is_hidden', arity: 0},
    {ns: 'Meta', cls: 'Window', member: 'is_attached_dialog', arity: 0},
    {ns: 'Meta', cls: 'Window', member: 'get_transient_for', arity: 0},
    {ns: 'Meta', cls: 'Window', member: 'located_on_workspace', params: ['workspace']},
    {ns: 'Meta', cls: 'Window', member: 'is_on_all_workspaces', arity: 0},
    // Meta.Window - properties we read
    {ns: 'Meta', cls: 'Window', member: 'decorated', property: true},
    {ns: 'Meta', cls: 'Window', member: 'maximized_vertically', property: true},
    {ns: 'Meta', cls: 'Window', member: 'maximized_horizontally', property: true},
    {ns: 'Meta', cls: 'Window', member: 'minimized', property: true},
    // Meta.Display and Meta.Backend
    {ns: 'Meta', cls: 'Display', member: 'get_monitor_geometry', params: ['monitor']},
    {ns: 'Meta', cls: 'Display', member: 'get_monitor_scale', params: ['monitor']},
    {ns: 'Meta', cls: 'Display', member: 'get_n_monitors', arity: 0},
    {ns: 'Meta', cls: 'Display', member: 'get_tab_list', params: ['type', 'workspace']},
    {ns: 'Meta', cls: 'Backend', member: 'get_monitor_manager', arity: 0},
    // Clutter
    {ns: 'Clutter', cls: 'Actor', member: 'set_cursor_type', params: ['cursor_type'], optional: true},
    {ns: 'Clutter', cls: 'Actor', member: 'set_child_above_sibling', params: ['child', 'sibling']},
    {ns: 'Clutter', cls: 'Actor', member: 'set_child_below_sibling', params: ['child', 'sibling']},
    {ns: 'Clutter', cls: 'ActorMeta', member: 'get_actor', arity: 0},
    {ns: 'Clutter', cls: 'OffscreenEffect', member: 'vfunc_paint_target', vfunc: true},
    // The shadow actor's paint path: the vfunc it overrides, the node type it emits, and the two
    // calls that build the tree under it.
    {ns: 'Clutter', cls: 'Actor', member: 'vfunc_paint_node', vfunc: true},
    {ns: 'Clutter', cls: 'PipelineNode', class: true},
    {ns: 'Clutter', cls: 'PaintNode', member: 'add_child', params: ['child']},
    {ns: 'Clutter', cls: 'PaintNode', member: 'add_texture_rectangle', params: ['rect', 'x_1', 'y_1', 'x_2', 'y_2']},
    {ns: 'Clutter', cls: 'OffscreenEffect', member: 'get_pipeline', arity: 0},
    {ns: 'Clutter', cls: 'BindConstraint', class: true},
    {ns: 'Clutter', cls: 'ShaderEffect', member: 'set_uniform_float', arity: 4, optional: true},
    {ns: 'Clutter', cls: 'Backend', member: 'get_default_seat', arity: 0, optional: true},
    {ns: 'Clutter', cls: 'Seat', member: 'get_pointer', arity: 0, optional: true},
    // What compat/grabOp.js dispatches on: 45 and 49-51 both declare four parameters, and this
    // pair is what tells them apart. The code reads these two, not a version number.
    {ns: 'Clutter', cls: 'Backend', member: 'get_sprite', arity: 2, optional: true},
    {ns: 'Clutter', cls: 'Backend', member: 'get_pointer_sprite', arity: 1, optional: true},
    // Cogl - the shadow pipeline, whose uniform call the code probes for two signatures
    {ns: 'Cogl', cls: 'Pipeline', class: true},
    {ns: 'Cogl', cls: 'Pipeline', member: 'set_uniform_float', arity: [3, 4]},
    {ns: 'Cogl', cls: 'Pipeline', member: 'set_layer_filters', params: ['layer_index', 'min_filter', 'mag_filter']},
    // The C prototype takes two out-pointers (min_filter, mag_filter); GJS folds them into an
    // out-argument return array [min_filter, mag_filter], matching get_buffer_rect's out-arg pattern.
    {ns: 'Cogl', cls: 'Pipeline', member: 'get_layer_filters', params: ['layer_index']},
    {ns: 'Cogl', cls: 'PipelineFilter', enum: true, members: ['LINEAR_MIPMAP_LINEAR', 'LINEAR', 'NEAREST']},
    // gnome-shell, only reachable from inside the shell
    {ns: 'Shell', cls: 'GLSLEffect', class: true, optional: true},
    // The C prototype has five parameters; GJS shows three, because g-ir-scanner folds the
    // array-length parameter into the array. Same class of surprise as get_buffer_rect's out-arg.
    {ns: 'Shell', cls: 'GLSLEffect', member: 'set_uniform_float', params: ['uniform', 'n_components', 'value'], optional: true},
    {ns: 'Shell', cls: 'WindowTracker', member: 'get_default', static: true, arity: 0},
    {ns: 'St', cls: 'Settings', member: 'get', static: true, arity: 0},
    {ns: 'St', cls: 'Settings', member: 'enable_animations', property: true},
    {ns: 'St', cls: 'Settings', member: 'color_scheme', property: true},
    // The ring's colour is currentColor, so the code reads this one member by name; an enum that
    // still exists but lost the member would otherwise pass unnoticed.
    {ns: 'St', cls: 'SystemColorScheme', enum: true, members: ['PREFER_DARK']},
    {ns: 'St', cls: 'BoxLayout', class: true},
];

/**
 * Pairs of members that are mutually exclusive across supported lines, where the shell has to
 * offer at least one. The shader base class moved from Shell to Clutter in 51, so exactly one of
 * these carries the uniform upload - and the absence of both would be a break nothing else here
 * would notice.
 */
const GROUPS = [
    {name: 'a uniform upload path', members: [['Shell', 'GLSLEffect', 'set_uniform_float'], ['Clutter', 'ShaderEffect', 'set_uniform_float']]},
    // 45-48 reach the pointer through the seat, 49-51 through a sprite. The grab dispatch needs one
    // of the three, and a shell with none of them could not start a resize at all.
    {name: 'a pointer source for the grab', members: [['Clutter', 'Backend', 'get_sprite'], ['Clutter', 'Backend', 'get_pointer_sprite'], ['Clutter', 'Backend', 'get_default_seat']]},
];

let failed = 0;
let checked = 0;
let skipped = 0;

function fail(what, detail) {
    failed++;
    print(`  FAIL  ${what} - ${detail}`);
}

function report(what, detail) {
    checked++;
    if (VERBOSE)
        print(`  ok    ${what}${detail ? ` - ${detail}` : ''}`);
}

/** GJS installs a get/set accessor pair on the prototype for every GObject property. */
function hasAccessor(proto, name) {
    for (let o = proto; o; o = Object.getPrototypeOf(o)) {
        const d = Object.getOwnPropertyDescriptor(o, name);
        if (d)
            return typeof d.get === 'function' && typeof d.set === 'function';
    }
    return false;
}

/** The parameter list GJS shows for a wrapper, or null when it cannot be read. */
function parameterNames(fn) {
    const m = /^[^(]*\(([^)]*)\)/.exec(String(fn));
    if (!m)
        return null;
    return m[1].trim() === '' ? [] : m[1].split(',').map(s => s.trim());
}

async function loadNamespace(name) {
    try {
        // A dynamic import resolves to the module object; the GI namespace hangs off its default.
        const mod = await import(`gi://${name}`);
        return mod.default ?? mod;
    } catch {
        return null;
    }
}

const namespaces = new Map();
for (const name of new Set(SURFACE.map(e => e.ns)))
    namespaces.set(name, await loadNamespace(name));

// A namespace can import and still be unusable: St's typelib references libst, which only the
// shell puts on the loader path, and touching one of its classes throws. That is the environment,
// not the surface, so the first throw retires the whole namespace as skipped - but only while
// nothing from it has been checked yet, because a throw after that would be a real anomaly.
const retired = new Set();

function resolve(entry) {
    const ns = namespaces.get(entry.ns);
    if (!ns)
        return null;
    return entry.cls ? ns[entry.cls] : ns;
}

/** How a member is spelled in a report line. */
function label(entry) {
    if (entry.class || entry.enum)
        return `${entry.ns}.${entry.cls}`;
    if (entry.namespace)
        return `${entry.ns}.${entry.member}`;
    if (entry.static)
        return `${entry.ns}.${entry.cls}.${entry.member}`;
    return `${entry.ns}.${entry.cls}.prototype.${entry.member}`;
}

for (const entry of SURFACE) {
    const what = label(entry);
    let ns;
    let target;
    try {
        ns = namespaces.get(entry.ns);
        target = entry.namespace ? ns : resolve(entry);
    } catch (e) {
        if (retired.has(entry.ns)) {
            skipped++;
            continue;
        }
        retired.add(entry.ns);
        skipped++;
        if (VERBOSE)
            print(`  skip  ${what} - ${entry.ns} is not usable here: ${e.message}`);
        continue;
    }
    if (!ns) {
        skipped++;
        if (VERBOSE)
            print(`  skip  ${what} - ${entry.ns} does not load outside the shell`);
        continue;
    }
    if (entry.enum) {
        // GJS exposes an enum as a plain object of its values, not as a class, so being an object
        // is not enough: the members the code reads by name have to be there.
        const missing = (entry.members ?? []).filter(m => target?.[m] === undefined);
        if (target === null || typeof target !== 'object')
            fail(what, `not an enum object (typeof ${typeof target})`);
        else if (missing.length)
            fail(what, `missing ${missing.join(', ')}`);
        else
            report(what, 'enum');
        continue;
    }
    if (entry.class) {
        if (typeof target !== 'function') {
            if (entry.optional)
                report(what, 'absent, and the code degrades without it');
            else
                fail(what, `the class is missing (typeof ${typeof target})`);
            continue;
        }
        report(what, 'class');
        continue;
    }
    if (!target) {
        fail(what, `${entry.ns}.${entry.cls} does not exist`);
        continue;
    }
    const holder = entry.static || entry.namespace ? target : target.prototype;

    if (entry.vfunc) {
        // A vfunc becomes a JS prototype slot only once a subclass overrides it, so reading the slot
        // is not the assertion. GJS installs a getter that throws "Virtual function not implemented:
        // ... <name>" for a hook the class does not implement itself - which is the knowledge being
        // checked - while a property that is simply absent is a hook that is gone.
        let known;
        try {
            known = holder[entry.member];
        } catch (e) {
            known = /Virtual function not implemented/.test(e.message) ? 'declared' : null;
        }
        if (known === undefined || known === null)
            fail(what, 'the hook is not on the class at all');
        else
            report(what, typeof known === 'function' ? 'vfunc slot' : 'vfunc declared');
        continue;
    }

    const value = holder[entry.member];
    if (entry.property) {
        if (hasAccessor(holder, entry.member))
            report(what, 'property accessor');
        else
            fail(what, 'no get/set accessor on the prototype');
        continue;
    }
    if (typeof value !== 'function') {
        if (entry.optional) {
            report(what, 'absent, and the code degrades without it');
            continue;
        }
        fail(what, `not callable (typeof ${typeof value})`);
        continue;
    }
    const names = parameterNames(value);
    const signature = names === null ? 'signature unreadable' : `(${names.join(', ')})`;
    print(`  ${what}${signature}`);
    if (entry.params) {
        if (names === null) {
            fail(what, 'the wrapper source could not be read for its parameter names');
            continue;
        }
        if (names.join(',') !== entry.params.join(',')) {
            fail(what, `GJS shows (${names.join(', ')}), the code assumes (${entry.params.join(', ')})`);
            continue;
        }
        report(what, `params ${signature}`);
        continue;
    }
    if (Array.isArray(entry.arity)) {
        if (value.length < entry.arity[0] || value.length > entry.arity[1]) {
            fail(what, `GJS accepts ${value.length} arguments, the code probes for ${entry.arity.join(' or ')}`);
            continue;
        }
        report(what, `arity ${value.length}`);
        continue;
    }
    if (entry.arity !== undefined && value.length !== entry.arity) {
        fail(what, `GJS accepts ${value.length} arguments, the code assumes ${entry.arity}`);
        continue;
    }
    report(what, `arity ${value.length}`);
}

for (const group of GROUPS) {
    const present = group.members.filter(([ns, cls, member]) => {
        const namespace = namespaces.get(ns);
        return typeof namespace?.[cls]?.prototype?.[member] === 'function';
    });
    if (present.length === 0)
        fail(group.name, `none of ${group.members.map(m => m.join('.')).join(' / ')} is callable`);
    else
        report(group.name, present.map(m => m.join('.')).join(' / '));
}

// The typelibs are found by version-numbered directory, and a GNOME line whose typelibs we never
// audited is worth naming - the shape assertions above would only catch it if the shape moved.
function typelibApiVersion() {
    const dirs = (GLib.getenv('GI_TYPELIB_PATH') ?? '').split(':');
    for (const dir of dirs) {
        const m = /mutter-(\d+)$/.exec(dir.replace(/\/+$/, ''));
        if (m)
            return m[1];
    }
    return null;
}

function auditedApiVersions() {
    try {
        const [ok, bytes] = GLib.file_get_contents(RECORD);
        if (!ok)
            return null;
        const record = JSON.parse(new TextDecoder().decode(bytes));
        const entry = record.surface.find(e => e.id === 'mutter_api_version');
        if (!entry)
            return null;
        return new Set(Object.values(entry.decl)
            .filter(Boolean)
            .map(d => /'(\d+)'/.exec(d)?.[1])
            .filter(Boolean));
    } catch {
        return null;
    }
}

const apiVersion = typelibApiVersion();
const audited = auditedApiVersions();
if (apiVersion === null) {
    if (VERBOSE)
        print('  note  the typelib api version is not discoverable here (GI_TYPELIB_PATH is unset)');
} else if (audited && !audited.has(apiVersion)) {
    fail('typelib api version', `Meta-${apiVersion} is not one of the audited versions (${[...audited].join(', ')})`);
} else {
    report('typelib api version', `Meta-${apiVersion}`);
}

print(`gjs-surface: ${checked} members checked, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
if (failed > 0)
    System.exit(1);
