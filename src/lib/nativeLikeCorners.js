/**
 * Native-like corners: inference that a window already has Adwaita radius because its process maps
 * an Adwaita provider. GTK theme is not a provider. The same reading answers whether the client is
 * GTK4, which the resize band asks about. docs/decoration-model.md § When a window's corners
 * already look like ours.
 */

import Gio from 'gi://Gio';

// Per-process via /proc/<pid>/maps; docs/decoration-model.md has the provider table. The first is
// the only GTK4 one, whose own resize handle the band can prove from a window's declared ring.
const GTK4_PROVIDER = 'libadwaita-1.so';
const ADWAITA_PROVIDERS = [
    GTK4_PROVIDER,
    'libhandy-1.so',  // GTK3 predecessor (window.csd.unified)
];

/** What a process maps, for the two questions asked of it. */
const NO_PROVIDER = Object.freeze({adwaitaLook: false, gtk4: false});

/** pid -> the answer, once it has landed. Absent while a read is in flight. */
const processCache = new Map();

/**
 * pid -> the read in flight, as `{cancellable}`: a GObject at module scope is a rejection. The
 * entry is its own token, so dropping it (forgetProcess, destroy) cancels the read and makes a late
 * answer unrecognisable - by then the pid may be another process.
 */
const inFlight = new Map();

/** Fires with the pid when an answer lands; Manager re-decides that process's windows. */
let onProcessKnown = null;
let destroyed = false;

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
        processCache.set(pid, error ? NO_PROVIDER : classifyProcess(mapsText));
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
 * @param {*} pid
 * @returns {boolean}
 */
function isValidPid(pid) {
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
}

/**
 * Initiates an async read of /proc/<pid>/maps if not already cached, in flight, or destroyed.
 * @param {number} pid
 * @param {object} [deps]
 * @param {(pid: number, done: (mapsText: string|null, error?: Error) => void, cancellable: Gio.Cancellable) => void} [deps.readMaps]
 */
export function probeAdwaitaLook(pid, deps = {}) {
    if (destroyed || !isValidPid(pid))
        return;
    if (processCache.has(pid) || inFlight.has(pid))
        return;
    startRead(pid, deps.readMaps ?? readMaps);
}

/**
 * @param {string} mapsText - Contents of /proc/pid/maps
 * @returns {{adwaitaLook: boolean, gtk4: boolean}} Whether the process maps an Adwaita provider,
 *          and whether that provider is the GTK4 one
 */
export function classifyProcess(mapsText) {
    if (!mapsText || typeof mapsText !== 'string')
        return {...NO_PROVIDER};
    return {
        adwaitaLook: ADWAITA_PROVIDERS.some(name => mapsText.includes(name)),
        gtk4: mapsText.includes(GTK4_PROVIDER),
    };
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
 * @param {number} pid
 * @param {object} [deps]
 * @param {(pid: number, done: (mapsText: string|null, error?: Error) => void, cancellable: Gio.Cancellable) => void} [deps.readMaps]
 * @returns {{adwaitaLook: boolean, gtk4: boolean}|undefined}
 */
function answerFor(pid, deps = {}) {
    if (!isValidPid(pid))
        return undefined;
    if (!processCache.has(pid) && !inFlight.has(pid))
        probeAdwaitaLook(pid, deps);
    // A reader that answers synchronously lands above, so the cache decides first.
    return processCache.get(pid);
}

/**
 * Whether a process has the Adwaita look.
 * @param {number} pid
 * @param {object} [deps]
 * @param {(pid: number, done: (mapsText: string|null, error?: Error) => void, cancellable: Gio.Cancellable) => void} [deps.readMaps]
 * @returns {boolean} Whether process has Adwaita look (cached per pid; a read in flight reads as true)
 */
export function hasAdwaitaLook(pid, deps = {}) {
    if (!isValidPid(pid))
        return false;

    return answerFor(pid, deps)?.adwaitaLook ?? true;
}

/**
 * Whether a process is a GTK4 client, i.e. whether it maps libadwaita.
 *
 * GTK4 sizes a CSD window's input region from `RESIZE_HANDLE_SIZE` whatever the shadow is, so a
 * GTK4 client's own handle is a constant the declared margins can prove. GTK3 sizes its handle from
 * the theme instead, so nothing else can be read that way (docs/decoration-model.md § The resize
 * band).
 * @param {number} pid
 * @param {object} [deps]
 * @param {(pid: number, done: (mapsText: string|null, error?: Error) => void, cancellable: Gio.Cancellable) => void} [deps.readMaps]
 * @returns {boolean} Whether the process is a GTK4 client (cached per pid; a read in flight reads as false)
 */
export function hasGtk4Client(pid, deps = {}) {
    if (!isValidPid(pid))
        return false;

    // Unlike `hasAdwaitaLook()`, a read still in flight is not a yes: only a landed answer may
    // take a band away from a window.
    return answerFor(pid, deps)?.gtk4 ?? false;
}

/**
 * Whether an asynchronous answer is currently in flight for a pid.
 * @param {number} pid
 * @returns {boolean}
 */
export function isAdwaitaLookPending(pid) {
    if (destroyed || !isValidPid(pid))
        return false;
    return inFlight.has(pid);
}

/**
 * Whether window's own process already rounds corners.
 * @param {object} win - Meta.Window
 * @param {object} [deps]
 * @returns {boolean} Whether window's own process already rounds corners.
 */
export function hasNativeLikeCorners(win, deps = {}) {
    if (!win)
        return false;
    return hasAdwaitaLook(win.get_pid?.(), deps);
}

/**
 * Forgets a process from the cache and cancels any read in flight.
 * @param {number} pid
 */
export function forgetProcess(pid) {
    const entry = inFlight.get(pid);
    inFlight.delete(pid);
    processCache.delete(pid);
    entry?.cancellable.cancel();
}

/**
 * Clear the cache and the callback, and cancel every read in flight (extension disable()).
 */
export function destroy() {
    destroyed = true;
    onProcessKnown = null;
    const entries = [...inFlight.values()];
    inFlight.clear();
    processCache.clear();
    for (const entry of entries)
        entry.cancellable.cancel();
}

/**
 * Initializes or re-arms the module state for an active extension session, preserving any registered callback.
 */
export function init() {
    const cb = onProcessKnown;
    destroy();
    destroyed = false;
    onProcessKnown = cb;
}
