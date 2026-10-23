/** Sole writer: one grep finds every message, and one injected object observes them all. */

/** The tag a support log is searched for; a throw escaping our catches is the one untagged line. */
export const PREFIX = '[window-nativizer]';

export class Journal {
    /** Sinks are injectable because the Shell's console.warn cannot be replaced. */
    constructor(options = {}) {
        this._warn = options.warn ?? (message => console.warn(message));
        this._failure = options.failure ?? ((error, message) => logError(error, message));
    }

    /** The prefix belongs to this module, so no caller can write it twice or forget it. */
    warn(text) {
        this._warn(`${PREFIX} ${text}`);
    }

    /** The sink adds the stack, which is why an error takes this path and a diagnostic does not. */
    failure(error, text) {
        this._failure(error, `${PREFIX} ${text}`);
    }
}

/** Shared default: a decoration and its effects must share a sink, or half a pass goes elsewhere. */
export const journal = new Journal();
