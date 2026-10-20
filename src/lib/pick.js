import {WindowClientType} from './mutterRules.generated.js';

import {
    buildRuleKeyFromProperties,
    boolString,
    fingerprintProperties,
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
 * @param winOrReading - Meta.Window or existing WindowReading
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
        // The seven structural attributes come from the rule table, so the dictionary prefs turns back
        // into a key and the key itself cannot disagree about what a window kind is.
        ...fingerprintProperties(reading),
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
 * Builds the pick reply's subpixel-phase diagnostic fields, letting a user compare the mirror we
 * cut on with the phase Mutter applied. Both are strings; an unreadable read says so rather than
 * claiming zero. Runs only on a pick, never per frame. Both reads use the clip's container rule.
 */
export function extractPhaseProperties(win, St = null) {
    const mirror = getWindowSubpixelOffset(win, St);
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

    const applied = getAppliedSubpixelPhase(win, St);
    properties.appliedPhaseX = applied ? String(applied.x) : 'unavailable';
    properties.appliedPhaseY = applied ? String(applied.y) : 'unavailable';
    return properties;
}

/**
 * The decoration-side diagnostics keys, in reply order. Named once so `extractDiagnosticProperties`
 * and `WindowDecoration.diagnosticsView` cannot silently disagree about what crossing the bus is.
 * The live clip and the shadow over the same body are carried here; the overview is deliberately
 * left out.
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
    'containerBox',
    'shadowWidth',
    'shadowHeight',
    'shadowCast',
    'shadowRightBand',
]);

/**
 * Reads the D-Bus in-args into the two facts the inspector branches on: was the required boolean
 * passed, and does it ask for diagnostics. A call with no argument is *invalid*, not `false` - D-Bus
 * has no default arguments, and treating it as a quiet pick would hide the arity break. There is no
 * non-interactive path.
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
 * Renders the cached Adwaita classification without starting a probe: a diagnostic must not change
 * what it observes. `unknown` means not yet classified, `cannotTell` means no classifier, and only a
 * landed answer becomes `true`/`false` - without that a cache miss would read as "not libadwaita".
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

function diagnosticRect(rect) {
    if (!rect)
        return 'unavailable';
    const {x = 0, y = 0, width = 0, height = 0} = rect;
    if (![x, y, width, height].every(Number.isFinite))
        return 'unavailable';
    return JSON.stringify({x, y, width, height});
}

const PHASE_FIELDS = Object.freeze([
    'mirrorPhaseX', 'mirrorPhaseY', 'appliedPhaseX', 'appliedPhaseY',
]);

/**
 * Builds the diagnostics-only half of the `PickWindow` reply. Every live read is isolated in its own
 * group, so one throw degrades only that group to `unavailable` rather than discarding the reply,
 * and nothing writes, probes or queues a repaint.
 */
export function extractDiagnosticProperties(win, deco = null, reads = null, St = null) {
    const read = reads ?? {
        phases: w => extractPhaseProperties(w, St),
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
 */
function readGroup(properties, keys, read) {
    try {
        Object.assign(properties, read());
    } catch {
        for (const key of keys)
            properties[key] = 'unavailable';
    }
}
