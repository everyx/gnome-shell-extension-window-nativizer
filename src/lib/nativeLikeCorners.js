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
    'libhandy-1.so', // GTK3 predecessor (window.csd.unified)
];

/** What a process maps, for the two questions asked of it. */
const NO_PROVIDER = Object.freeze({adwaitaLook: false, gtk4: false});

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
 * @param {*} pid
 * @returns {boolean}
 */
function isValidPid(pid) {
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
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
 * Manages per-process classification and async /proc/<pid>/maps probe lifecycle.
 * Instantiated and held by Manager to eliminate module-level global state and leaks.
 */
export class ProcessClassifier {
    /**
     * @param {object} [options]
     * @param {(pid: number, done: (mapsText: string|null, error?: Error) => void, cancellable: Gio.Cancellable) => void} [options.readMaps]
     */
    constructor(options = {}) {
        /** @type {Map<number, {adwaitaLook: boolean, gtk4: boolean}>} */
        this._processCache = new Map();
        /** @type {Map<number, {cancellable: Gio.Cancellable}>} */
        this._inFlight = new Map();
        /** @type {((pid: number) => void)|null} */
        this._onProcessKnown = null;
        this._destroyed = false;
        this._readMaps = options.readMaps ?? readMaps;
    }

    /** @returns {boolean} */
    get isDestroyed() {
        return this._destroyed;
    }

    /**
     * Initiates an async read of /proc/<pid>/maps if not already cached, in flight, or destroyed.
     * @param {number} pid
     * @param {object} [deps]
     * @param {(pid: number, done: (mapsText: string|null, error?: Error) => void, cancellable: Gio.Cancellable) => void} [deps.readMaps]
     */
    probeAdwaitaLook(pid, deps = {}) {
        if (this._destroyed || !isValidPid(pid))
            return;
        if (this._processCache.has(pid) || this._inFlight.has(pid))
            return;
        this._startRead(pid, deps.readMaps ?? this._readMaps);
    }

    /**
     * @param {number} pid
     * @param {(pid: number, done: (mapsText: string|null, error?: Error) => void, cancellable: Gio.Cancellable) => void} reader
     */
    _startRead(pid, reader) {
        const entry = {cancellable: new Gio.Cancellable()};
        this._inFlight.set(pid, entry);
        const done = (mapsText, error) => {
            if (this._inFlight.get(pid) !== entry)
                return;
            this._inFlight.delete(pid);
            // A process whose maps cannot be read is decorated, and cached as such: a retry per query
            // would start a read per reconcile. forgetProcess() is the retry point (last window closed).
            this._processCache.set(pid, error ? NO_PROVIDER : classifyProcess(mapsText));
            try {
                this._onProcessKnown?.(pid);
            } catch (cbError) {
                if (typeof logError === 'function')
                    logError(cbError, '[window-nativizer] Error in onProcessKnown callback');
            }
        };
        try {
            reader(pid, done, entry.cancellable);
        } catch (error) {
            done(null, error);
        }
    }

    /**
     * Whether a process has the Adwaita look.
     * @param {number} pid
     * @returns {boolean} Whether the process has the Adwaita look (from the cache; unknown reads as true)
     */
    hasAdwaitaLook(pid) {
        if (!isValidPid(pid))
            return false;

        return this._processCache.get(pid)?.adwaitaLook ?? true;
    }

    /**
     * Whether a process is a GTK4 client, i.e. whether it maps libadwaita.
     * @param {number} pid
     * @returns {boolean} Whether the process is a GTK4 client (from the cache; unknown reads as false)
     */
    hasGtk4Client(pid) {
        if (!isValidPid(pid))
            return false;

        // Unlike `hasAdwaitaLook()`, an unknown answer is not a yes: only a landed answer may
        // take a band away from a window.
        return this._processCache.get(pid)?.gtk4 ?? false;
    }

    /**
     * Whether an asynchronous answer is currently in flight for a pid.
     * @param {number} pid
     * @returns {boolean}
     */
    isAdwaitaLookPending(pid) {
        if (this._destroyed || !isValidPid(pid))
            return false;
        return this._inFlight.has(pid);
    }

    /**
     * Whether window's own process already rounds corners.
     * @param {object} win - Meta.Window
     * @returns {boolean} Whether window's own process already rounds corners.
     */
    hasNativeLikeCorners(win) {
        if (!win)
            return false;
        return this.hasAdwaitaLook(win.get_pid?.());
    }

    /**
     * Forgets a process from the cache and cancels any read in flight.
     * @param {number} pid
     */
    forgetProcess(pid) {
        const entry = this._inFlight.get(pid);
        this._inFlight.delete(pid);
        this._processCache.delete(pid);
        entry?.cancellable.cancel();
    }

    /**
     * Registers the callback that fires when a process's answer lands, so the caller can re-decide
     * the windows it left alone. `null` unregisters; `destroy()` clears it.
     * @param {((pid: number) => void)|null} cb
     */
    setOnProcessKnown(cb) {
        this._onProcessKnown = cb;
    }

    /**
     * Clear the cache and the callback, and cancel every read in flight.
     */
    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._onProcessKnown = null;
        const entries = [...this._inFlight.values()];
        this._inFlight.clear();
        this._processCache.clear();
        for (const entry of entries)
            entry.cancellable.cancel();
    }
}
