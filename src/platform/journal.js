/**
 * The extension's journal: the one place a line is built and the one place it is written. Every
 * message the extension emits goes through here, so a reader finds them all with one grep and a
 * spec observes them all by injecting one object.
 */

/**
 * Tags every line: a support log is searched for it, so text without it is text nobody finds. The
 * one other writer is a throw that can escape our catches, which GJS reports as a bare `JS ERROR`
 * with no sink of ours; a throw a catch absorbs carries no prefix, or it is tagged twice.
 */
export const PREFIX = '[window-nativizer]';

export class Journal {
    /**
     * @param [options.warn] - Sink for a diagnostic line; a spec injects one, since the shell's
     *        `console.warn` is not writable
     * @param [options.failure] - Sink for a caught error, taking the error and its line
     */
    constructor(options = {}) {
        this._warn = options.warn ?? (message => console.warn(message));
        this._failure = options.failure ?? ((error, message) => logError(error, message));
    }

    /**
     * Writes a diagnostic line. The text is content only: the prefix belongs to this module, so no
     * caller can write it twice or forget it.
     */
    warn(text) {
        this._warn(`${PREFIX} ${text}`);
    }

    /**
     * Writes a caught error. The line names what failed, as a diagnostic would; the sink adds the
     * stack, which is the reason an error takes this path and a diagnostic does not.
     */
    failure(error, text) {
        this._failure(error, `${PREFIX} ${text}`);
    }
}

/**
 * The journal every object shares unless one is injected. A decoration and the effects it builds
 * must write to the same place, or a spec observing a pass would see half of its lines.
 */
export const journal = new Journal();
