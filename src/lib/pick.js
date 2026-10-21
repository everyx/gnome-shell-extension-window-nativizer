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

/** Re-exported so importers that still reach through this module keep working. */
export {
    buildRuleKeyFromProperties,
    readWindowString,
    readDeclaredIdentity,
    getWindowFromActor
};

export const INSPECTOR_DBUS_NAME = 'org.gnome.Shell.Extensions.WindowNativizer';
export const INSPECTOR_DBUS_PATH = '/org/gnome/Shell/Extensions/WindowNativizer';

/** Kept as data so a spec can assert the signature without loading the St/Main modules. */
export const INSPECTOR_DBUS_IFACE_XML = `
<node>
  <interface name="${INSPECTOR_DBUS_NAME}">
    <method name="PickWindow">
      <arg type="b" direction="in" name="debug"/>
      <arg type="a{ss}" direction="out" name="properties"/>
    </method>
  </interface>
</node>`;

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
        // The structural keys come from the rule table, so prefs turns the dictionary back into one key.
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

/** Both read through the clip's own container rule, so the mirror and the applied phase compare. */
export function extractPhaseProperties(win, St = null) {
    const mirror = getWindowSubpixelOffset(win, St);
    const properties = {
        // null means the scan did not complete, not a zero phase; say unknown rather than fabricate one.
        mirrorPhaseX: mirror ? String(mirror.x) : 'unknown',
        mirrorPhaseY: mirror ? String(mirror.y) : 'unknown',
    };

    // The applied transform exists only on Wayland, so X11 says n/a rather than echo a zero.
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

/** Named once so reply and diagnosticsView agree; the overview is deliberately left out. */
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

/** No arg is invalid, not false: D-Bus has no defaults, so reading it as quiet hides the break. */
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

/** A diagnostic must not change what it observes: no probe, and a miss is unknown, not false. */
export function cachedNativeLikeCorners(classifier, pid) {
    if (!classifier || typeof classifier.adwaitaLook !== 'function' || !(pid > 0))
        return 'cannotTell';
    const cached = classifier.adwaitaLook(pid);
    if (cached === null || cached === undefined)
        return 'unknown';
    return cached ? 'true' : 'false';
}

/** Nullish and non-finite become unavailable, telling "not reachable" from "not in this reply". */
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

/** One throw costs only its own group's fields, and nothing here writes, probes or repaints. */
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

function readGroup(properties, keys, read) {
    try {
        Object.assign(properties, read());
    } catch {
        for (const key of keys)
            properties[key] = 'unavailable';
    }
}
