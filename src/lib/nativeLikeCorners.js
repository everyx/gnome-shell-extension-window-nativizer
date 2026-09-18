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
    'libxul.so',      // Mozilla Gecko (Firefox 153+ bug 1850827: 4-corner CSD via GtkCssProvider injection)
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
 * Whether a process has the Adwaita look. The read is asynchronous, so the first query counts as
 * native-like; a caller that can wait asks `isAdwaitaLookPending()` first instead of acting on that
 * guess (docs/decoration-model.md has the reasoning and the cost).
 * @param {number} pid
 * @param {object} [deps]
 * @param {(pid: number, done: (mapsText: string|null, error?: Error) => void, cancellable: Gio.Cancellable) => void} [deps.readMaps]
 * @returns {boolean} Whether process has Adwaita look (cached per pid; a read in flight reads as true)
 */
export function hasAdwaitaLook(pid, deps = {}) {
    if (!pid || typeof pid !== 'number' || pid <= 0)
        return false;

    // A reader that answers synchronously has landed by this line, so the cache decides first.
    return answerFor(pid, deps)?.adwaitaLook ?? true;
}

/**
 * The answer a pid has, reading it once when nobody has yet. A read in flight leaves the cache
 * empty: the caller's own default is what "not known yet" means to it.
 * @param {number} pid
 * @param {object} deps
 * @returns {{adwaitaLook: boolean, gtk4: boolean}|undefined}
 */
function answerFor(pid, deps) {
    if (!processCache.has(pid) && !inFlight.has(pid))
        startRead(pid, deps.readMaps ?? readMaps);
    return processCache.get(pid);
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
    if (!pid || typeof pid !== 'number' || pid <= 0)
        return false;

    // Unlike `hasAdwaitaLook()`, a read still in flight is not a yes: only a landed answer may
    // take a band away from a window.
    return answerFor(pid, deps)?.gtk4 ?? false;
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
