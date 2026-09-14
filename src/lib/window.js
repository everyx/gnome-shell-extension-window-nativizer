/**
 * Shell-side window helpers: gathering the identity candidates that rules.js chooses
 * between. Not pure - it needs Shell.WindowTracker and the live window list.
 */

import Shell from 'gi://Shell';

import {readDeclaredIdentity} from './pick.js';
import {chooseWindowIdentity} from './rules.js';

/** Every mapped window, used to find a sibling of the same process. */
function listWindowActors() {
    return global.get_window_actors?.() ?? [];
}

/**
 * A window's fallback identity, keyed by the declared identity it was derived from.
 *
 * Only answers that did not come from the pid fallback are kept: that one is what a
 * window gets while the app tracker is still catching up, and remembering it would
 * freeze a rule onto a session-local identity. The declared identity is part of the
 * key because it is the input that arrives late and has to invalidate the answer.
 */
const fallbackIdentities = new WeakMap();

/**
 * Resolves a stable application identity for a window. The picker and the runtime
 * must both use this resolver, otherwise a rule created for a picked window could
 * never match it at runtime. The order the candidates are weighed in is in
 * docs/rule-model.md.
 *
 * @param {object} win - Meta.Window instance
 * @returns {string} Identity, or '' when the window cannot be identified at all
 */
export function resolveWindowIdentity(win) {
    if (!win)
        return '';

    const declared = readDeclaredIdentity(win);
    if (declared)
        return declared;

    const remembered = fallbackIdentities.get(win);
    if (remembered && remembered.declared === declared)
        return remembered.identity;

    const pid = win.get_pid?.() ?? -1;
    let peer = '';
    if (pid > 0) {
        for (const actor of listWindowActors()) {
            const candidate = actor.meta_window ?? actor.metaWindow;
            if (!candidate || candidate === win || candidate.get_pid?.() !== pid)
                continue;
            peer = readDeclaredIdentity(candidate);
            if (peer)
                break;
        }
    }

    let tracked = '';
    try {
        tracked = Shell.WindowTracker.get_default()?.get_window_app(win)?.get_id?.() ?? '';
    } catch {
        // WindowTracker is unusable while the session is tearing down.
    }

    const identity = chooseWindowIdentity({declared, peer, tracked, pid});
    if (identity && !identity.startsWith('pid-'))
        fallbackIdentities.set(win, {declared, identity});
    return identity;
}
