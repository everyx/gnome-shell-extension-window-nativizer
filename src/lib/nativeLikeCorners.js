/**
 * Native-like corners: inference that a window already has Adwaita radius because its process maps
 * an Adwaita provider. GTK theme is not a provider. The same reading answers whether the client is
 * GTK4, which the resize band asks about.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {journal} from '../platform/journal.js';

// Per-process via /proc/<pid>/maps. The first is
// the only GTK4 one, whose own resize handle the band can prove from a window's declared ring.
const GTK4_PROVIDER = 'libadwaita-1.so';
const ADWAITA_PROVIDERS = [
    GTK4_PROVIDER,
    'libhandy-1.so', // GTK3 predecessor (window.csd.unified)
];

const NO_PROVIDER = Object.freeze({adwaitaLook: false, gtk4: false});

/**
 * Bounded retry schedule for a failed /proc read. A transient failure (EIO during teardown) must
 * not leave a stable window unclassified forever, and a persistent one (EACCES) must not be
 * hammered: three attempts at 1s/2s/4s, then the next explicit probe starts a fresh episode.
 */
const RETRY_DELAYS_MS = [1000, 2000, 4000];

/**
 * Reads /proc/<pid>/maps off the main loop: GIO runs a local file's async read in a worker thread,
 * and the synchronous API is what EGO-X-004 flags.
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

function isValidPid(pid) {
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
}

/**
 * @param mapsText - Contents of /proc/pid/maps
 * @returns Whether the process maps an Adwaita provider,
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
     * @param [options.timeoutAdd] - Timer seam for tests
     * @param [options.timeoutRemove] - Timer seam for tests
     */
    constructor(options = {}) {
        this._processCache = new Map();
        this._inFlight = new Map();
        this._pendingRetries = new Map();
        this._retryCounts = new Map();
        this._onProcessKnown = null;
        this._destroyed = false;
        this._readMaps = options.readMaps ?? readMaps;
        this._timeoutAdd = options.timeoutAdd ?? ((delayMs, cb) =>
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
                cb();
                return GLib.SOURCE_REMOVE;
            }));
        this._timeoutRemove = options.timeoutRemove ?? (id => GLib.Source.remove(id));
    }

    get isDestroyed() {
        return this._destroyed;
    }

    /**
     * Initiates an async read of /proc/<pid>/maps if not already cached, in flight, or destroyed.
     */
    probeAdwaitaLook(pid, deps = {}) {
        if (this._destroyed || !isValidPid(pid))
            return;
        if (this._processCache.has(pid) || this._inFlight.has(pid) || this._pendingRetries.has(pid))
            return;
        // An explicit probe starts a fresh failure episode; let its bounded retries run again.
        this._retryCounts.delete(pid);
        this._startRead(pid, deps.readMaps ?? this._readMaps);
    }

    _startRead(pid, reader) {
        const entry = {cancellable: new Gio.Cancellable()};
        this._inFlight.set(pid, entry);
        const done = (mapsText, error) => {
            if (this._inFlight.get(pid) !== entry)
                return;
            this._inFlight.delete(pid);
            // A failed read is "unknown", not a verdict: caching it as definitely not libadwaita
            // would last the process's lifetime, so a window that recovered would wear our clip and
            // band. Leave the cache empty, schedule a bounded retry, and do not fire the callback -
            // a failure gives nothing to re-decide.
            if (error || typeof mapsText !== 'string') {
                this._scheduleRetry(pid, reader);
                return;
            }
            this._retryCounts.delete(pid);
            this._processCache.set(pid, classifyProcess(mapsText));
            try {
                this._onProcessKnown?.(pid);
            } catch (cbError) {
                journal.failure(cbError, 'Error in onProcessKnown callback');
            }
        };
        try {
            reader(pid, done, entry.cancellable);
        } catch (error) {
            done(null, error);
        }
    }

    /**
     * Schedules a bounded, backoff retry for a pid whose read failed. The retry reuses the reader
     * that failed and stops after RETRY_DELAYS_MS.length attempts; an explicit probe starts a new
     * episode. forgetProcess() and destroy() cancel a pending retry so it cannot touch a forgotten
     * pid or a torn-down window.
     */
    _scheduleRetry(pid, reader) {
        if (this._destroyed)
            return;
        const attempt = (this._retryCounts.get(pid) ?? 0) + 1;
        if (attempt > RETRY_DELAYS_MS.length)
            return;
        this._retryCounts.set(pid, attempt);
        const id = this._timeoutAdd(RETRY_DELAYS_MS[attempt - 1], () => {
            this._pendingRetries.delete(pid);
            if (this._destroyed || this._processCache.has(pid))
                return;
            this._startRead(pid, reader);
        });
        this._pendingRetries.set(pid, {id, reader});
    }

    /**
     * Returns true for Adwaita providers, false for non-Adwaita, or null while read is in flight.
     */
    adwaitaLook(pid) {
        if (!isValidPid(pid))
            return false;

        return this._processCache.get(pid)?.adwaitaLook ?? null;
    }

    /**
     * Whether a process is a GTK4 client, i.e. whether it maps libadwaita. Same tri-state as
     * `adwaitaLook()`: null until the read lands, because only a landed answer may take a band
     * away from a window.
     */
    hasGtk4Client(pid) {
        if (!isValidPid(pid))
            return false;

        return this._processCache.get(pid)?.gtk4 ?? null;
    }

    /**
     * Forgets a process from the cache and cancels any read in flight or retry pending.
     */
    forgetProcess(pid) {
        const entry = this._inFlight.get(pid);
        this._inFlight.delete(pid);
        const retry = this._pendingRetries.get(pid);
        this._pendingRetries.delete(pid);
        this._retryCounts.delete(pid);
        this._processCache.delete(pid);
        entry?.cancellable.cancel();
        if (retry)
            this._timeoutRemove(retry.id);
    }

    /**
     * Registers the callback that fires when a process's answer lands, so the caller can re-decide
     * the windows it left alone. `null` unregisters; `destroy()` clears it.
     */
    setOnProcessKnown(cb) {
        this._onProcessKnown = cb;
    }

    /**
     * Clear the cache and the callback, and cancel every read in flight and every retry pending.
     */
    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._onProcessKnown = null;
        const entries = [...this._inFlight.values()];
        this._inFlight.clear();
        const retries = [...this._pendingRetries.values()];
        this._pendingRetries.clear();
        this._retryCounts.clear();
        this._processCache.clear();
        for (const entry of entries)
            entry.cancellable.cancel();
        for (const retry of retries)
            this._timeoutRemove(retry.id);
    }
}
