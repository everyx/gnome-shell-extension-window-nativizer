/** The look comes from a mapped provider, not the theme; the same read says whether it is GTK4. */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {journal} from '../platform/journal.js';

// The first is the only GTK4 one: the band can prove its own resize handle from a window's ring.
const GTK4_PROVIDER = 'libadwaita-1.so';
const ADWAITA_PROVIDERS = [
    GTK4_PROVIDER,
    'libhandy-1.so', // GTK3 predecessor (window.csd.unified)
];

const NO_PROVIDER = Object.freeze({adwaitaLook: false, gtk4: false});

/** Bounded so a transient EIO is retried and a persistent EACCES is not hammered. */
const RETRY_DELAYS_MS = [1000, 2000, 4000];

/** Async so the read runs in a worker thread; the synchronous API is an EGO finding. */
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

/** @returns whether an Adwaita provider is mapped, and whether that provider is the GTK4 one */
export function classifyProcess(mapsText) {
    if (!mapsText || typeof mapsText !== 'string')
        return {...NO_PROVIDER};
    return {
        adwaitaLook: ADWAITA_PROVIDERS.some(name => mapsText.includes(name)),
        gtk4: mapsText.includes(GTK4_PROVIDER),
    };
}

/** Classification and probe lifecycle, held by Manager so no module-level state leaks. */
export class ProcessClassifier {
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
            // A failed read is unknown, not a verdict: caching it would outlive the failure.
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

    /** Reuses the failed reader; a pending retry is cancelled by forgetProcess() and destroy(). */
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

    /** Tri-state: true, false, or null while the read is in flight. */
    adwaitaLook(pid) {
        if (!isValidPid(pid))
            return false;

        return this._processCache.get(pid)?.adwaitaLook ?? null;
    }

    /** Same tri-state: null until the read lands; only a landed answer may take a band away. */
    hasGtk4Client(pid) {
        if (!isValidPid(pid))
            return false;

        return this._processCache.get(pid)?.gtk4 ?? null;
    }

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

    /** Fires when an answer lands, so the caller re-decides what it left alone; null clears it. */
    setOnProcessKnown(cb) {
        this._onProcessKnown = cb;
    }

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
