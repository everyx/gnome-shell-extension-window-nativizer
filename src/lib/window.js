// Shell-side identity gathering — candidate order in docs/rule-model.md.

import Shell from 'gi://Shell';

import {readDeclaredIdentity} from './pick.js';
import {chooseWindowIdentity} from './rules.js';

function listWindowActors() {
    return global.get_window_actors?.() ?? [];
}

/**
 * Extracts the Meta.Window instance from a MetaWindowActor across Mutter property name variations.
 * @param {object|null} actor
 * @returns {object|null} Meta.Window instance or null
 */
export function getWindowFromActor(actor) {
    return actor?.meta_window ?? actor?.metaWindow ?? null;
}

// Only non-pid answers are remembered; pid fallback would freeze a session-local rule.
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

    const pid = win.get_pid?.() ?? -1;
    let peer = '';
    if (pid > 0) {
        for (const actor of listWindowActors()) {
            const candidate = getWindowFromActor(actor);
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
