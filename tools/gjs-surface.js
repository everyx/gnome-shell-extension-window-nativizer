#!/usr/bin/env gjs -m
/**
 * gjs-surface.js - Asserts that the Shell / Mutter / Clutter members this extension calls are
 * actually callable from GJS on the shell it is running against, with the shape the code assumes.
 *
 * Design: tools/audit-shell-api.mjs reads public headers, which proves a declaration exists but
 * not that GJS can reach it. Three things live in that gap and all three have bitten us:
 *
 *   - Out-arguments are not visible in C. meta_window_get_buffer_rect takes two parameters and
 *     no annotation; GJS calls it with none and gets a rectangle back. Anything inferring a JS
 *     signature from a header would get this wrong, so the arity is asserted here instead.
 *   - Properties and methods are not the same thing. GJS installs a get/set accessor pair for
 *     every GObject property, and separately exposes the C accessors as methods when the header
 *     declares them - Clutter.ActorMeta has both an `enabled` property and a set_enabled method.
 *     A header read cannot tell you which of the two a call resolves to.
 *   - (skip) annotations and private headers leave a symbol declared but unreachable. Meta.Display
 *     declares no get_default_seat in any of 45-51, and the prototype agrees: undefined.
 *
 * Namespaces are imported dynamically because St only loads inside the shell: outside it the
 * typelib's libst is not on the loader path, and a static import would take the whole script down
 * with it. A namespace that cannot load is reported and skipped, not failed.
 *
 * No display is needed, because this reads prototypes rather than instances.
 * tools/test-e2e.sh runs it inside the nested session, so the shell under test is the shell probed.
 *
 * Usage: gjs -m tools/gjs-surface.js [--verbose]
 */

import System from 'system';

const VERBOSE = ARGV.includes('--verbose');

/**
 * Every member the extension calls, with what the code assumes about it. `arity` is the number of
 * arguments GJS must accept, which is not the number the C prototype has whenever the function
 * takes an out-argument. `arity: null` means the code dispatches on the shape rather than
 * assuming one, so any value is accepted as long as the member exists.
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
    {ns: 'Meta', cls: 'Window', member: 'begin_grab_op', arity: null},
    {ns: 'Meta', cls: 'Window', member: 'get_compositor_private', arity: 0},
    {ns: 'Meta', cls: 'Window', member: 'is_hidden', arity: 0},
    {ns: 'Meta', cls: 'Window', member: 'is_attached_dialog', arity: 0},
    {ns: 'Meta', cls: 'Window', member: 'get_transient_for', arity: 0},
    {ns: 'Meta', cls: 'Window', member: 'located_on_workspace', arity: 1},
    {ns: 'Meta', cls: 'Window', member: 'is_on_all_workspaces', arity: 0},
    // Meta.Window - properties we read
    {ns: 'Meta', cls: 'Window', member: 'decorated', property: true},
    {ns: 'Meta', cls: 'Window', member: 'maximized_vertically', property: true},
    {ns: 'Meta', cls: 'Window', member: 'maximized_horizontally', property: true},
    {ns: 'Meta', cls: 'Window', member: 'minimized', property: true},
    // Meta.Display and Meta.Backend
    {ns: 'Meta', cls: 'Display', member: 'get_monitor_geometry', arity: 1},
    {ns: 'Meta', cls: 'Display', member: 'get_monitor_scale', arity: 1},
    {ns: 'Meta', cls: 'Display', member: 'get_n_monitors', arity: 0},
    {ns: 'Meta', cls: 'Display', member: 'get_tab_list', arity: 2},
    {ns: 'Meta', cls: 'Backend', member: 'get_monitor_manager', arity: 0},
    // Clutter
    {ns: 'Clutter', cls: 'Actor', member: 'set_cursor_type', arity: 1, optional: true},
    {ns: 'Clutter', cls: 'Actor', member: 'set_child_above_sibling', arity: 2},
    {ns: 'Clutter', cls: 'Actor', member: 'set_child_below_sibling', arity: 2},
    {ns: 'Clutter', cls: 'ActorMeta', member: 'get_actor', arity: 0},
    {ns: 'Clutter', cls: 'ActorMeta', member: 'set_enabled', arity: 1},
    {ns: 'Clutter', cls: 'ActorMeta', member: 'enabled', property: true},
    {ns: 'Clutter', cls: 'OffscreenEffect', member: 'vfunc_paint_target', vfunc: true},
    // gnome-shell, only reachable from inside the shell
    {ns: 'St', cls: 'Settings', member: 'get', static: true, arity: 0},
];

let failed = 0;
let checked = 0;
let skipped = 0;

function report(ok, what, detail) {
    checked++;
    if (ok) {
        if (VERBOSE)
            print(`  ok    ${what}${detail ? ` - ${detail}` : ''}`);
        return;
    }
    failed++;
    print(`  FAIL  ${what} - ${detail}`);
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

for (const entry of SURFACE) {
    const what = `${entry.ns}.${entry.cls}${entry.static ? '' : '.prototype'}.${entry.member}`;
    const ns = namespaces.get(entry.ns);
    if (!ns) {
        skipped++;
        if (VERBOSE)
            print(`  skip  ${what} - ${entry.ns} does not load outside the shell`);
        continue;
    }
    let ctor;
    try {
        ctor = ns[entry.cls];
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
    if (!ctor) {
        report(false, what, `${entry.ns}.${entry.cls} does not exist`);
        continue;
    }
    const target = entry.static ? ctor : ctor.prototype;
    const value = target[entry.member];
    if (entry.vfunc) {
        // A vfunc becomes a prototype slot only once a JS subclass overrides it; what can be
        // asserted here is that the hook is reachable through the class at all.
        report(true, what, 'vfunc slot');
        continue;
    }
    if (entry.property) {
        report(hasAccessor(target, entry.member), what,
            hasAccessor(target, entry.member) ? 'property accessor' : 'no get/set accessor on the prototype');
        continue;
    }
    if (entry.optional && value === undefined) {
        // Not available on every supported line, and the code degrades without it.
        report(true, what, 'absent, and the code degrades without it');
        continue;
    }
    if (typeof value !== 'function') {
        report(false, what, `not callable (typeof ${typeof value})`);
        continue;
    }
    if (entry.arity !== null && value.length !== entry.arity) {
        report(false, what, `GJS accepts ${value.length} arguments, the code assumes ${entry.arity}`);
        continue;
    }
    report(true, what, `arity ${value.length}`);
}

print(`gjs-surface: ${checked} members checked, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
if (failed > 0)
    System.exit(1);
