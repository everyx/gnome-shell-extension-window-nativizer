#!/usr/bin/env node
/**
 * check-upstream-mirrors.mjs - Fails when the pinned upstream arithmetic that a hand-written
 * JavaScript mirror reproduces has changed shape.
 *
 * Three review rounds found three separate divergences in one such mirror
 * (`getWindowSubpixelOffset` in src/platform/windowPhase.js: a wrong monitor rule, a wrong coordinate
 * space, and `Math.round` where C uses `roundf`), each a visible one-physical-pixel artifact.
 * The repo already pins upstream sources under vendor/ and re-derives constants from them with
 * `tools/gen-*.mjs`; the arithmetic that cannot be generated - only transliterated - had no
 * reader at all, so it drifted silently.
 *
 * This check asserts the essential expressions, not the file. The vendored C is normalised
 * (comments dropped, all whitespace removed) before matching, so a reformat or a comment edit
 * upstream is not a failure, but a changed operator, operand, or rounding call is. Each
 * expression is also scoped to the function that holds it, so the same string surviving
 * elsewhere in the file cannot produce a false pass.
 *
 * What this proves, and what it does not: it proves the pinned upstream still says what we
 * mirror, where we read it from. It does NOT prove our JavaScript equals it - the translation
 * (sign handling, epsilon placement, rounding call) is hand-written and can diverge while both
 * texts stay put. The behavioural contract lives in the specs, which are the reader of the JS
 * mirror: tests/platform.test.js pins the subpixel phase, and tests/snap.test.js pins the GSK
 * snap directions, including `snapDirection`'s deliberate origin-odd ROUND deviation from GSK.
 *
 * The single unguarded arithmetic left is UNGUARDED_RULE below: it lives in
 * meta-monitor-manager.c, which is not vendored, so the guard cannot assert it. The call site
 * that reaches it is asserted; the selection loop itself is not, so re-read it by hand when
 * bumping Mutter - UNGUARDED_RULE.recheck names where, and the note is printed on success too so
 * the duty does not live only in a doc.
 *
 * One assumption lives outside the phase arithmetic: the shadow's phase read is only fresh
 * because Mutter invalidates the surface container's cached transform on the window actor's
 * allocation, before our ShadowActor connects its own handler. That wiring is asserted here too,
 * scoped to meta_window_actor_wayland_init, so a Mutter bump that moves it fails loudly instead
 * of the shadow silently holding a stale matrix.
 *
 * Usage: node tools/check-upstream-mirrors.mjs [--check]
 *   --check: the only mode, accepted so the tool reads like the rest of the check-style chain.
 */

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MUTTER_ACTOR = 'vendor/mutter/meta-window-actor-wayland.c';
const MUTTER_BOX = 'vendor/mutter/clutter-actor-box.c';
const MUTTER_STEX = 'vendor/mutter/meta-shaped-texture.c';
const GSK_RECT = 'vendor/gtk/gskrectprivate.h';

/**
 * The one mirrored rule the vendored sources cannot assert, kept in a single place so the header
 * above and the success output below cannot name different rules. `name` is the upstream symbol,
 * `mirror` is our approximation, and `recheck` is where the by-hand re-check is documented.
 */
const UNGUARDED_RULE = {
    name: 'meta_monitor_manager_get_highest_scale_monitor_from_rect',
    mirror: 'resolveHighestScaleMonitorIndex (src/platform/monitor.js)',
    recheck: 'docs/shell-compatibility.md',
};

/**
 * The C functions the expression checks are scoped to, keyed by scope name. The signature is
 * matched against the normalised source; a missing signature is reported, not silently skipped.
 */
const SCOPES = {
    surface_container_apply_transform:
        'surface_container_apply_transform(ClutterActor*actor,graphene_matrix_t*matrix)',
    gsk_rect_snap_direction: 'gsk_rect_snap_direction(float',
    meta_window_actor_wayland_init: 'meta_window_actor_wayland_init(MetaWindowActorWayland*self)',
    _clutter_actor_box_enlarge_for_effects:
        '_clutter_actor_box_enlarge_for_effects(ClutterActorBox*box)',
    do_paint_content:
        'do_paint_content(MetaShapedTexture*stex,ClutterPaintNode*root_node,'
        + 'ClutterPaintContext*paint_context,ClutterActorBox*alloc,uint8_topacity)',
};

/** Drop C comments, then all whitespace: matching is insensitive to formatting, not to tokens. */
function normalise(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\s+/g, '');
}

function read(relPath) {
    try {
        return readFileSync(path.join(ROOT, relPath), 'utf8');
    } catch (e) {
        throw new Error(`[check-upstream-mirrors] cannot read ${relPath}: ${e.message}`);
    }
}

function commit(relDir) {
    return read(`${relDir}/COMMIT`).trim();
}

/**
 * The brace-matched body of the single function whose signature starts at `signature`, or null
 * when the signature is absent or the braces never balance. Scoping the expression checks to
 * this body is what stops a string parked in a neighbouring function from passing as a mirror.
 */
function functionBody(source, signature) {
    const signatureAt = source.indexOf(signature);
    if (signatureAt === -1)
        return null;
    const open = source.indexOf('{', signatureAt + signature.length);
    if (open === -1)
        return null;
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{')
            depth += 1;
        else if (source[i] === '}' && --depth === 0)
            return source.slice(open, i + 1);
    }
    return null;
}

const MUTTER = normalise(read(MUTTER_ACTOR));
const MUTTER_BOXED = normalise(read(MUTTER_BOX));
const MUTTER_TEXTURE = normalise(read(MUTTER_STEX));
const GSK = normalise(read(GSK_RECT));

const CHECKS = [
    {
        label: 'surface_container_apply_transform',
        haystack: MUTTER,
        needle: SCOPES.surface_container_apply_transform,
        mirror: 'getWindowSubpixelOffset (src/platform/windowPhase.js)',
        recheck: 're-read the upstream phase function and update the mirror term for term',
    },
    {
        label: 'highest-scale monitor getter',
        haystack: MUTTER,
        scope: 'surface_container_apply_transform',
        needle: 'meta_window_get_highest_scale_monitor(window)',
        mirror: 'resolveHighestScaleMonitorIndex / getWindowSubpixelOffset (src/platform/windowPhase.js)',
        recheck: 're-check which monitor the phase is measured against',
    },
    {
        label: 'monitor scale',
        haystack: MUTTER,
        scope: 'surface_container_apply_transform',
        needle: 'meta_logical_monitor_get_scale(logical_monitor)',
        mirror: 'getMonitorScale (src/platform/display.js)',
        recheck: 're-check the scale the phase is multiplied by',
    },
    {
        label: 'monitor layout',
        haystack: MUTTER,
        scope: 'surface_container_apply_transform',
        needle: 'meta_logical_monitor_get_layout(logical_monitor)',
        mirror: 'getMonitorGeometry (src/platform/display.js)',
        recheck: 're-check the monitor origin the phase is measured from',
    },
    {
        label: 'absolute x',
        haystack: MUTTER,
        scope: 'surface_container_apply_transform',
        needle: 'abs_x=clutter_actor_get_x(parent)+clutter_actor_get_x(actor)',
        mirror: 'getWindowSubpixelOffset (src/platform/windowPhase.js)',
        recheck: 're-check which actor the phase is read from (window actor vs surface container)',
    },
    {
        label: 'relative x',
        haystack: MUTTER,
        scope: 'surface_container_apply_transform',
        needle: 'rel_x=abs_x-monitor_rect.x',
        mirror: 'getWindowSubpixelOffset (src/platform/windowPhase.js)',
        recheck: 're-check the coordinate space the phase is measured in',
    },
    {
        label: 'roundf snap x',
        haystack: MUTTER,
        scope: 'surface_container_apply_transform',
        needle: 'roundf(rel_x*scale)/scale',
        mirror: 'roundHalfAwayFromZero (src/platform/numeric.js), used by getWindowSubpixelOffset',
        recheck: 're-check that a negative exact half still rounds away from zero, not up',
    },
    {
        label: 'x offset',
        haystack: MUTTER,
        scope: 'surface_container_apply_transform',
        needle: 'x_off=adj_rel_x-rel_x',
        mirror: 'getWindowSubpixelOffset (src/platform/windowPhase.js)',
        recheck: 're-check the sign of the translation folded into the shadow',
    },
    {
        label: 'window-actor allocation invalidates the surface transform',
        haystack: MUTTER,
        scope: 'meta_window_actor_wayland_init',
        needle: 'g_signal_connect_swapped(self,"notify::allocation",G_CALLBACK(clutter_actor_notify_transform_invalid),self->surface_container);',
        mirror: 'ShadowActor syncs on notify::allocation (src/effects/shadowActor.js)',
        recheck: 're-check that the window actor allocation still invalidates the surface container transform before our own handler runs; if it moves, the shadow reads a stale matrix',
    },
    {
        label: 'enlarge rounding pad',
        haystack: MUTTER_BOXED,
        scope: '_clutter_actor_box_enlarge_for_effects',
        needle: 'box->x2=ceilf(box->x2+0.75f);',
        mirror: 'enlargeAxis (src/lib/offscreenBox.js), ENLARGE_ROUNDING_PAD',
        recheck: 're-check the margin the far edge is padded by before its ceil',
    },
    {
        label: 'enlarge total pad',
        haystack: MUTTER_BOXED,
        scope: '_clutter_actor_box_enlarge_for_effects',
        needle: 'box->x1=box->x2-width-3;',
        mirror: 'enlargeAxis (src/lib/offscreenBox.js), ENLARGE_TOTAL_PAD',
        recheck: 're-check the total the near edge is re-anchored by; the 2/1 split is derived, not copied',
    },
    {
        label: 'the mask is only consulted on the blended path',
        haystack: MUTTER_TEXTURE,
        scope: 'do_paint_content',
        needle: 'use_opaque_region=stex->opaque_region&&opacity==255;',
        mirror: 'OverviewDecoration\'s opacity bypass (src/lib/overviewDecoration.js)',
        recheck: 're-check how a fully opaque actor is made to take the masked pipeline; if this '
            + 'condition moves, the overview mask silently stops applying',
    },
    {
        label: 'gsk_rect_snap_direction',
        haystack: GSK,
        needle: SCOPES.gsk_rect_snap_direction,
        mirror: 'snapDirection (src/platform/numeric.js), re-exported by src/lib/snap.js',
        recheck: 're-read the snap rule and update the mirror direction by direction',
    },
    {
        label: 'GSK_SNAP_EPSILON',
        haystack: GSK,
        needle: '#defineGSK_SNAP_EPSILON0.001',
        mirror: 'SNAP_EPSILON (src/platform/numeric.js)',
        recheck: 're-check the epsilon every snap direction adds or subtracts',
    },
    {
        label: 'snap floor',
        haystack: GSK,
        scope: 'gsk_rect_snap_direction',
        needle: 'returnfloorf(value+GSK_SNAP_EPSILON);',
        mirror: 'SnapDirection.FLOOR (src/platform/numeric.js)',
        recheck: 're-check the floor branch of snapDirection',
    },
    {
        label: 'snap ceil',
        haystack: GSK,
        scope: 'gsk_rect_snap_direction',
        needle: 'returnceilf(value-GSK_SNAP_EPSILON);',
        mirror: 'SnapDirection.CEIL (src/platform/numeric.js)',
        recheck: 're-check the ceil branch of snapDirection',
    },
    {
        label: 'snap round',
        haystack: GSK,
        scope: 'gsk_rect_snap_direction',
        needle: 'returnroundf(value+GSK_SNAP_EPSILON);',
        mirror: 'SnapDirection.ROUND (src/platform/numeric.js)',
        recheck: 're-check the round branch of snapDirection (deliberately origin-odd, not GSK-raw)',
    },
];

const scopeBodies = new Map();
const failures = [];

for (const check of CHECKS) {
    let haystack = check.haystack;
    if (check.scope) {
        if (!scopeBodies.has(check.scope))
            scopeBodies.set(check.scope, functionBody(check.haystack, SCOPES[check.scope]));
        const body = scopeBodies.get(check.scope);
        if (body === null) {
            failures.push({check, where: `function ${check.scope} (signature missing or unclosed)`});
            continue;
        }
        haystack = body;
    }
    if (!haystack.includes(check.needle))
        failures.push({check, where: check.scope ? `function ${check.scope}` : 'file'});
}

if (failures.length) {
    console.error('[check-upstream-mirrors] FAIL: the pinned upstream no longer contains:');
    for (const {check, where} of failures) {
        console.error(`  ${check.label}: "${check.needle}" not in ${where}`);
        console.error(`    mirror: ${check.mirror}`);
        console.error(`    ${check.recheck}`);
    }
    console.error(`[check-upstream-mirrors] Sources: ${MUTTER_ACTOR}, ${MUTTER_BOX}, `
        + `${MUTTER_STEX} (mutter ${commit('vendor/mutter').slice(0, 8)}), `
        + `${GSK_RECT} (gtk ${commit('vendor/gtk').slice(0, 8)})`);
    process.exit(1);
}

console.log(`[check-upstream-mirrors] --check passed: ${CHECKS.length} mirror assertions hold across `
    + `mutter ${commit('vendor/mutter').slice(0, 8)} and gtk ${commit('vendor/gtk').slice(0, 8)}`);
console.log(`[check-upstream-mirrors] coverage gap: ${UNGUARDED_RULE.name} `
    + `(mirrored by ${UNGUARDED_RULE.mirror}) is not guarded - re-check it on a Mutter bump, `
    + `see ${UNGUARDED_RULE.recheck}`);
