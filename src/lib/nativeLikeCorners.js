/**
 * Native-like corners: inference that a window already has Adwaita radius because
 * its process maps an Adwaita provider. GTK theme is not a provider.
 * See docs/decoration-model.md § When a window's corners already look like ours.
 */

import Gio from 'gi://Gio';

// Per-process via /proc/<pid>/maps; see docs/decoration-model.md for provider table.
const ADWAITA_PROVIDERS = [
    'libadwaita-1.so', // GTK4
    'libhandy-1.so',  // GTK3 predecessor (window.csd.unified)
    'libxul.so',      // Mozilla Gecko (Firefox 153+ four-corner CSD)
];

/** pid -> the answer, once it has landed. Absent while a read is in flight. */
const processCache = new Map();

/**
 * pid -> the read in flight, as `{cancellable}`. Created here and not at module scope, because a
 * GObject instance before `enable()` is a rejection. The entry is its own token: dropping it
 * (forgetProcess, destroy) cancels the read and makes a late answer unrecognisable, so it cannot
 * speak for a pid that has moved on - by then it may be another process.
 */
const inFlight = new Map();

/** Fires with the pid when an answer lands; Manager re-decides that process's windows. */
let onProcessKnown = null;

/**
 * Reads /proc/<pid>/maps off the main loop: GIO runs a local file's async read in a worker thread,
 * and the synchronous API is what EGO-X-004 flags.
 * @param {number} pid
 * @param {(mapsText: string|null, error?: Error) => void} done
 * @param {Gio.Cancellable} cancellable
 */
function readMaps(pid, done, cancellable) {
    Gio.File.new_for_path(`/proc/${pid}/maps`).load_contents_async(cancellable, (file, res) => {
        try {
            const [, bytes] = file.load_contents_finish(res);
            done(new TextDecoder().decode(bytes));
        } catch (error) {
            done(null, error);
        }
    });
}

/**
 * @param {number} pid
 * @param {(pid: number, done: (mapsText: string|null, error?: Error) => void, cancellable: Gio.Cancellable) => void} reader
 */
function startRead(pid, reader) {
    const entry = {cancellable: new Gio.Cancellable()};
    inFlight.set(pid, entry);
    const done = (mapsText, error) => {
        if (inFlight.get(pid) !== entry)
            return;
        inFlight.delete(pid);
        // A process whose maps cannot be read is decorated, and cached as such: a retry per query
        // would start a read per reconcile. forgetProcess() is the retry point (last window closed).
        processCache.set(pid, error ? false : classifyProcess(mapsText));
        onProcessKnown?.(pid);
    };
    try {
        reader(pid, done, entry.cancellable);
    } catch (error) {
        // A reader that throws instead of answering must not leave the pid pending: that window
        // would then never be decided.
        done(null, error);
    }
}

/**
 * @param {string} mapsText - Contents of /proc/pid/maps
 * @returns {boolean} Whether the process maps an Adwaita provider
 */
export function classifyProcess(mapsText) {
    if (!mapsText || typeof mapsText !== 'string')
        return false;
    return ADWAITA_PROVIDERS.some(name => mapsText.includes(name));
}

/**
 * Registers the callback that fires when a process's answer lands, so the caller can re-decide
 * the windows it left alone. `null` unregisters; `destroy()` clears it.
 * @param {((pid: number) => void)|null} cb
 */
export function setOnProcessKnown(cb) {
    onProcessKnown = cb;
}

/**
 * Whether a process has the Adwaita look.
 *
 * The read is asynchronous, so the first query for a process cannot answer yet: it counts as
 * native-like, and a caller that can wait asks `isAdwaitaLookPending()` first rather than acting
 * on that guess. The reasoning and the cost are in docs/decoration-model.md.
 * @param {number} pid
 * @param {object} [deps]
 * @param {(pid: number, done: (mapsText: string|null, error?: Error) => void, cancellable: Gio.Cancellable) => void} [deps.readMaps]
 * @returns {boolean} Whether process has Adwaita look (cached per pid; a read in flight reads as true)
 */
export function hasAdwaitaLook(pid, deps = {}) {
    if (!pid || typeof pid !== 'number' || pid <= 0)
        return false;

    if (!processCache.has(pid) && !inFlight.has(pid))
        startRead(pid, deps.readMaps ?? readMaps);

    // A read that has not answered yet counts as native-like, and a reader that answers
    // synchronously has already landed by this line, so the cache decides wherever it can.
    return processCache.get(pid) ?? true;
}

/**
 * Whether a provider answer is still on its way for a pid. The caller waits for it instead of
 * deciding on `hasAdwaitaLook()`'s pending answer, which cannot tell a native window from one
 * that needs us.
 * @param {number} pid
 * @returns {boolean}
 */
export function isAdwaitaLookPending(pid) {
    return inFlight.has(pid);
}

/**
 * @param {object} win - Meta.Window
 * @returns {boolean} Whether window's own process already rounds corners.
 */
export function hasNativeLikeCorners(win) {
    if (!win)
        return false;
    return hasAdwaitaLook(win.get_pid?.());
}

/**
 * @param {number} pid
 */
export function forgetProcess(pid) {
    const entry = inFlight.get(pid);
    inFlight.delete(pid);
    processCache.delete(pid);
    entry?.cancellable.cancel();
}

/** Clear the cache and the callback, and cancel every read in flight (extension disable()). */
export function destroy() {
    const entries = [...inFlight.values()];
    inFlight.clear();
    processCache.clear();
    onProcessKnown = null;
    for (const entry of entries)
        entry.cancellable.cancel();
}
