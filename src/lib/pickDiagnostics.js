/** The picker's diagnostics reply: every field the debug pick adds, and nothing that can throw out. */

import {extractPhaseProperties} from './pickProperties.js';
import {getWindowActor, getWindowBufferRect, getWindowFrameRect} from '../platform/window.js';

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
