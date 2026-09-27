// Shell-side identity gathering — candidate order in docs/rule-model.md.

import Shell from 'gi://Shell';

import {readDeclaredIdentity, getWindowFromActor} from './pick.js';
import {chooseWindowIdentity} from './rules.js';

function listWindowActors() {
    return global.get_window_actors?.() ?? [];
}

// Declared- and tracker-derived answers are remembered; pid fallback would freeze a
// session-local rule, and a peer-derived answer is not remembered either: the peer scan is
// O(actors) but only runs for a window that declares no identity at all, while caching it
// could not be invalidated correctly for a peer the manager does not track (a popup, a dock).
// Key includes declared so a late WM_CLASS invalidates the cached answer.
const fallbackIdentities = new WeakMap();

/** @param {object} win @returns {string} stable identity or '' */
export function resolveWindowIdentity(win) {
    if (!win)
        return '';

    const declared = readDeclaredIdentity(win);
    if (declared)
        return declared;

    const remembered = fallbackIdentities.get(win);
    if (remembered && remembered.declared === declared)
        return remembered.identity;

    let pid = -1;
    try {
        pid = win.get_pid?.() ?? -1;
    } catch {
        // Window went away mid-resolve; fall through with no pid.
    }
    let peer = '';
    if (pid > 0) {
        for (const actor of listWindowActors()) {
            const candidate = getWindowFromActor(actor);
            if (!candidate || candidate === win)
                continue;
            try {
                if (candidate.get_pid?.() !== pid)
                    continue;
            } catch {
                continue; // Peer is itself being torn down.
            }
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
    if (identity && identity !== peer && !identity.startsWith('pid-'))
        fallbackIdentities.set(win, {declared, identity});
    return identity;
}
