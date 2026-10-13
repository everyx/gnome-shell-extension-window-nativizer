import {WindowClientType} from './mutterRules.generated.js';

import {
    buildRuleKeyFromProperties,
    boolString,
} from './rules.js';
import {
    readWindowString,
    readDeclaredIdentity,
    getWindowFromActor,
    readWindow,
    isWindowReading,
} from './window.js';
import {
    getWindowSubpixelOffset,
    getAppliedSubpixelPhase,
    getWindowClientType,
    getWindowFrameRect,
    getWindowBufferRect,
    getWindowActor,
} from '../platform/window.js';

export {WindowClientType};

// Re-exported window inspection utilities for backward compatibility.
export {
    buildRuleKeyFromProperties,
    readWindowString,
    readDeclaredIdentity,
    getWindowFromActor
};

export const INSPECTOR_DBUS_NAME = 'org.gnome.Shell.Extensions.WindowNativizer';
export const INSPECTOR_DBUS_PATH = '/org/gnome/Shell/Extensions/WindowNativizer';

/**
 * The inspector's D-Bus interface. One method, one boolean: `debug = false` is the quiet
 * interactive pick, `debug = true` is the same interactive pick with the read-only diagnostics
 * added to the reply. Kept as data here (not in `inspector.js`) so the signature can be asserted
 * without loading the Shell's St/Main modules.
 */
export const INSPECTOR_DBUS_IFACE_XML = `
<node>
  <interface name="${INSPECTOR_DBUS_NAME}">
    <method name="PickWindow">
      <arg type="b" direction="in" name="debug"/>
      <arg type="a{ss}" direction="out" name="properties"/>
    </method>
  </interface>
</node>`;

/**
 * @param {object} winOrReading - Meta.Window or existing WindowReading
 * @param {string|null} [wmClassOverride]
 * @returns {Record<string,string>}
 */
export function extractWindowProperties(winOrReading, wmClassOverride = null) {
    if (!winOrReading)
        return {};

    const reading = isWindowReading(winOrReading)
        ? winOrReading
        : readWindow(winOrReading, {wmClassOverride});
    if (!reading)
        return {};

    const props = {
        wmClass: wmClassOverride || reading.declaredWmClass,
        clientType: reading.clientTypeToken,
        windowType: String(reading.windowType),
        hasParent: boolString(reading.hasParent),
        allowsResize: boolString(reading.allowsResize),
        isAttachedDialog: boolString(reading.isAttachedDialog),
        hasRing: boolString(reading.hasRing),
        hasSsd: boolString(reading.hasSsd),
        isMaximized: boolString(reading.isMaximized),
        isFullscreen: boolString(reading.isFullscreen),
        hasTileMatch: boolString(reading.hasTileMatch),
    };

    const f = reading.frameRect;
    if (f && Number.isFinite(f.width) && Number.isFinite(f.height) && f.width > 0 && f.height > 0) {
        props.width = String(Math.round(f.width));
        props.height = String(Math.round(f.height));
    }

    return props;
}

/**
 * Builds the pick reply's subpixel-phase diagnostic fields, so a user can compare the phase we
 * cut on with the phase Mutter actually applied.
 *
 * The mirror is `getWindowSubpixelOffset`; the applied phase is read back from the surface
 * container's cached transform (`getAppliedSubpixelPhase`). The applied read is also the
 * production source on the container path (the shadow reads it too, see `shadowPhaseOffset`), so
 * this reply is where a user compares the two when the mirror's monitor scan cannot be exercised
 * locally. The reply is an `a{ss}` map, so every field is a string, and an unreadable applied
 * phase says so rather than claiming a zero; an unreadable monitor scan answers "unknown" for
 * the mirror for the same reason. This runs only when a user asks for the pick, never per frame.
 *
 * @param {object|null} win - Meta.Window
 * @returns {Record<string,string>} mirrorPhaseX/Y and appliedPhaseX/Y
 */
export function extractPhaseProperties(win) {
    const mirror = getWindowSubpixelOffset(win);
    const properties = {
        // null is "the monitor scan could not complete", not a phase of zero; say so rather than
        // report a fabricated zero the user would compare against the applied read.
        mirrorPhaseX: mirror ? String(mirror.x) : 'unknown',
        mirrorPhaseY: mirror ? String(mirror.y) : 'unknown',
    };

    // The applied transform only exists for a Wayland surface container; the mirror's own doc
    // answers zero for X11, so the applied side says not-applicable instead of echoing that zero.
    if (getWindowClientType(win) !== WindowClientType.WAYLAND) {
        properties.appliedPhaseX = 'n/a';
        properties.appliedPhaseY = 'n/a';
        return properties;
    }

    const applied = getAppliedSubpixelPhase(win);
    properties.appliedPhaseX = applied ? String(applied.x) : 'unavailable';
    properties.appliedPhaseY = applied ? String(applied.y) : 'unavailable';
    return properties;
}

/**
 * The decoration-side diagnostics keys, in reply order. Named once so `extractDiagnosticProperties`
 * and `WindowDecoration.diagnosticsView` cannot silently disagree about what crossing the bus is.
 * Only the live clip is carried here; the overview is deliberately left out (see development.md).
 */
export const DIAGNOSTIC_DECORATION_KEYS = Object.freeze([
    'clipTargetType',
    'clipTargetName',
    'phaseInTransform',
    'clipFrame',
    'clipInsets',
    'clipScale',
    'clipEnabled',
    'clipSuspended',
]);

/**
 * Reads the D-Bus in-args into the two facts the inspector branches on: whether the required
 * boolean was passed and whether it asks for diagnostics. `debug = false` is exactly the quiet
 * interactive pick; there is one knob, so a map would add parsing rules without adding meaning.
 *
 * A call with no argument at all is *invalid*, not `false`: D-Bus has no default arguments, and
 * treating a caller that forgot the argument as a quiet pick would hide the arity break. There is
 * no non-interactive path - diagnostics only add fields to the pick the user is about to make.
 *
 * @param {Array|null} params - GJS hands the in-args to `PickWindowAsync` as one array
 * @returns {{valid: boolean, diagnostics: boolean}}
 */
export function parseDebugFlag(params) {
    if (!Array.isArray(params) || params.length < 1)
        return {valid: false, diagnostics: false};
    const debug = params[0];
    if (typeof debug !== 'boolean')
        return {valid: false, diagnostics: false};
    return {
        valid: true,
        diagnostics: debug,
    };
}

/**
 * Renders the cached Adwaita classification for the reply without starting a probe. A diagnostic
 * must not change what it observes, so the async read is never triggered here: `unknown` means the
 * process has not been classified yet, `cannotTell` means there is no classifier to ask, and only
 * a landed answer becomes `true`/`false`. Without this a cache miss could be read as a negative
 * "not libadwaita" answer.
 *
 * @param {object|null} classifier - ProcessClassifier, or null when the manager has none
 * @param {number} pid
 * @returns {'true'|'false'|'unknown'|'cannotTell'}
 */
export function cachedNativeLikeCorners(classifier, pid) {
    if (!classifier || typeof classifier.adwaitaLook !== 'function' || !(pid > 0))
        return 'cannotTell';
    const cached = classifier.adwaitaLook(pid);
    if (cached === null || cached === undefined)
        return 'unknown';
    return cached ? 'true' : 'false';
}

/**
 * Renders a read value as the stringly `a{ss}` reply expects. Nullish and non-finite reads become
 * an explicit `unavailable` rather than being dropped, so a caller can tell "not reachable" from
 * "not in this reply".
 * @param {*} value
 * @returns {string}
 */
function diagnosticText(value) {
    if (value === null || value === undefined)
        return 'unavailable';
    if (typeof value === 'boolean')
        return value ? 'true' : 'false';
    if (typeof value === 'number')
        return Number.isFinite(value) ? String(value) : 'unavailable';
    if (typeof value === 'object')
        return JSON.stringify(value);
    return String(value);
}

/** @param {object|null} rect @returns {string} JSON x/y/width/height, or `unavailable` */
function diagnosticRect(rect) {
    if (!rect)
        return 'unavailable';
    const {x = 0, y = 0, width = 0, height = 0} = rect;
    if (![x, y, width, height].every(Number.isFinite))
        return 'unavailable';
    return JSON.stringify({x, y, width, height});
}

/** The diagnostics-only field names per logical read group. */
const PHASE_FIELDS = Object.freeze([
    'mirrorPhaseX', 'mirrorPhaseY', 'appliedPhaseX', 'appliedPhaseY',
]);

/**
 * Builds the diagnostics-only half of the `PickWindow` reply: the live geometry and the live
 * clip internals the width-shrink question was blind on.
 *
 * Every live read is isolated in its own group, so one throw degrades only that group's fields to
 * `unavailable` rather than discarding the whole reply - which is exactly when a transient failure
 * is most worth observing. Nothing writes, probes or queues a repaint.
 *
 * @param {object|null} win - Meta.Window
 * @param {object|null} [deco] - The window's live WindowDecoration, or null when untracked
 * @param {object} [reads] - Read seam; defaults to the live platform reads, tests inject throws
 * @returns {Record<string,string>}
 */
export function extractDiagnosticProperties(win, deco = null, reads = null) {
    const read = reads ?? {
        phases: w => extractPhaseProperties(w),
        frameRect: w => getWindowFrameRect(w),
        bufferRect: w => getWindowBufferRect(w),
        actor: w => getWindowActor(w),
    };
    const properties = {};

    readGroup(properties, PHASE_FIELDS, () => read.phases(win));
    readGroup(properties, ['frameRect'], () => ({frameRect: diagnosticRect(read.frameRect(win))}));
    readGroup(properties, ['bufferRect'], () => ({bufferRect: diagnosticRect(read.bufferRect(win))}));
    readGroup(properties, ['windowActorAllocation'], () => {
        const actor = read.actor(win);
        return {
            windowActorAllocation: actor
                ? diagnosticRect({x: actor.x, y: actor.y, width: actor.width, height: actor.height})
                : 'unavailable',
        };
    });

    // The getter reads live GObject state; a torn-down actor there must cost only the decoration
    // block, not the reply. Each key is read and rendered independently so one bad field cannot
    // drop the others.
    let view = null;
    try {
        view = deco?.diagnosticsView ?? null;
    } catch {
        view = null;
    }
    for (const key of DIAGNOSTIC_DECORATION_KEYS) {
        try {
            properties[key] = view ? diagnosticText(view[key]) : 'unavailable';
        } catch {
            properties[key] = 'unavailable';
        }
    }

    return properties;
}

/**
 * Assigns one logical read group, degrading just its fields to `unavailable` when it throws.
 * @param {Record<string,string>} properties
 * @param {string[]} keys
 * @param {() => object} read
 */
function readGroup(properties, keys, read) {
    try {
        Object.assign(properties, read());
    } catch {
        for (const key of keys)
            properties[key] = 'unavailable';
    }
}
