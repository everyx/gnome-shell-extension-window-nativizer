import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {classifyCornerAlpha} from './cornerReading.js';
import {journal} from '../platform/journal.js';
import {readActorCornerAlpha} from '../platform/cornerAlpha.js';
import {defaultProbeCachePath, loadProbeCache, saveProbeCache} from '../platform/probeCache.js';

const RETRY_DELAYS_MS = [100, 200, 350, 600];
const TRANSITION_FALLBACK_MS = 400;
const SAVE_DEBOUNCE_MS = 500;

function sameDimensions(a, b) {
    return Boolean(a && b && a.width === b.width && a.height === b.height);
}

function isActorSettled(actor) {
    if (!actor)
        return false;
    return (actor.opacity ?? 255) >= 255 &&
        Math.abs((actor.scale_x ?? 1) - 1) <= 1e-3 &&
        Math.abs((actor.scale_y ?? 1) - 1) <= 1e-3;
}

export class CornerProbe {
    constructor(options = {}) {
        this._destroyed = false;
        this._cachePath = options.cachePath !== undefined
            ? options.cachePath
            : defaultProbeCachePath(options.uuid);
        this._kindCache = this._cachePath ? loadProbeCache(this._cachePath) : new Map();
        this._revalidated = new Set();
        this._winCache = new Map();
        this._lastSamples = new Map();
        this._inFlight = new Map();
        this._pendingRetries = new Map();
        this._pendingWaits = new Map();
        this._retryCounts = new Map();
        this._saveTimer = null;
        this._onCornerKnown = options.onCornerKnown ?? null;
        this._readCorners = options.readCorners ?? readActorCornerAlpha;
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

    /** Tri-state: true (self-rounded), false (opaque corners), or null while pending/unknown. */
    selfRoundedCorners(win, frameRect, kindKey = null) {
        if (!win || !frameRect)
            return null;
        const cached = this._winCache.get(win);
        if (cached && sameDimensions(cached, frameRect))
            return cached.value;
        if (kindKey && this._kindCache.has(kindKey))
            return this._kindCache.get(kindKey);
        return null;
    }

    probe(win, actor, frameRect, kindKey = null, deps = {}) {
        if (this._destroyed || !win || !actor || !frameRect || frameRect.width < 32 || frameRect.height < 32)
            return;

        const size = {width: frameRect.width, height: frameRect.height};
        const cached = this._winCache.get(win);
        if (cached && sameDimensions(cached, size))
            return;
        if (cached)
            this._winCache.delete(win);

        // If kindCache already has an entry, revalidate once per session in the background.
        if (kindKey && this._kindCache.has(kindKey)) {
            if (this._revalidated.has(kindKey))
                return;
            this._revalidated.add(kindKey);
        }

        const active = this._inFlight.get(win);
        if (active && sameDimensions(active, size))
            return;
        if (active) {
            this._inFlight.delete(win);
            active.cancellable.cancel();
        }

        const retry = this._pendingRetries.get(win);
        if (retry && sameDimensions(retry, size))
            return;
        if (retry) {
            this._pendingRetries.delete(win);
            this._timeoutRemove(retry.id);
        }

        const wait = this._pendingWaits.get(win);
        if (wait && sameDimensions(wait, size))
            return;
        if (wait)
            this._clearWait(win);

        this._retryCounts.delete(win);
        const rect = {
            x: frameRect.x,
            y: frameRect.y,
            width: frameRect.width,
            height: frameRect.height,
        };
        const reader = deps.readCorners ?? this._readCorners;
        if (!isActorSettled(actor)) {
            this._waitForTransition(win, actor, rect, kindKey, reader);
            return;
        }
        this._startRead(win, actor, rect, kindKey, reader);
    }

    _waitForTransition(win, actor, frameRect, kindKey, reader) {
        if (this._destroyed)
            return;
        let signalId = null;
        let timerId = null;
        const finish = () => {
            this._pendingWaits.delete(win);
            if (signalId !== null) {
                try {
                    actor.disconnect?.(signalId);
                } catch {
                    // Actor may already be disposed.
                }
                signalId = null;
            }
            if (timerId !== null) {
                this._timeoutRemove(timerId);
                timerId = null;
            }
            if (!this._destroyed)
                this._startRead(win, actor, frameRect, kindKey, reader);
        };
        if (typeof actor.connect === 'function')
            signalId = actor.connect('transitions-completed', finish);
        timerId = this._timeoutAdd(TRANSITION_FALLBACK_MS, finish);
        this._pendingWaits.set(win, {
            width: frameRect.width,
            height: frameRect.height,
            cancel: () => {
                if (signalId !== null) {
                    try {
                        actor.disconnect?.(signalId);
                    } catch {
                        // Actor may already be disposed.
                    }
                    signalId = null;
                }
                if (timerId !== null) {
                    this._timeoutRemove(timerId);
                    timerId = null;
                }
            },
        });
    }

    _clearWait(win) {
        const wait = this._pendingWaits.get(win);
        if (!wait)
            return;
        this._pendingWaits.delete(win);
        wait.cancel();
    }

    _startRead(win, actor, frameRect, kindKey, reader) {
        const entry = {
            width: frameRect.width,
            height: frameRect.height,
            cancellable: new Gio.Cancellable(),
        };
        this._inFlight.set(win, entry);

        const done = (sample, error) => {
            if (this._inFlight.get(win) !== entry)
                return;
            this._inFlight.delete(win);
            const verdict = error ? null : classifyCornerAlpha(sample);
            this._lastSamples.set(win, {
                sample: sample ?? null,
                verdict,
                error: error ? String(error) : null,
            });
            if (verdict === null) {
                this._scheduleRetry(win, actor, frameRect, kindKey, reader);
                return;
            }
            this._retryCounts.delete(win);
            const prevKind = kindKey ? this._kindCache.get(kindKey) : undefined;
            this._winCache.set(win, {width: frameRect.width, height: frameRect.height, value: verdict});
            if (kindKey && prevKind !== verdict) {
                this._kindCache.delete(kindKey);
                this._kindCache.set(kindKey, verdict);
                this._scheduleSave();
            }
            if (prevKind === verdict)
                return;
            try {
                this._onCornerKnown?.(win);
            } catch (cbError) {
                journal.failure(cbError, 'Error in onCornerKnown callback');
            }
        };

        Promise.resolve()
            .then(() => reader(actor, frameRect, entry.cancellable))
            .then(sample => done(sample, null), error => done(null, error));
    }

    _scheduleRetry(win, actor, frameRect, kindKey, reader) {
        if (this._destroyed)
            return;
        const attempt = (this._retryCounts.get(win) ?? 0) + 1;
        if (attempt > RETRY_DELAYS_MS.length)
            return;
        this._retryCounts.set(win, attempt);
        const id = this._timeoutAdd(RETRY_DELAYS_MS[attempt - 1], () => {
            this._pendingRetries.delete(win);
            if (this._destroyed || this._winCache.has(win))
                return;
            this._startRead(win, actor, frameRect, kindKey, reader);
        });
        this._pendingRetries.set(win, {
            id,
            width: frameRect.width,
            height: frameRect.height,
        });
    }

    _scheduleSave() {
        if (this._destroyed || !this._cachePath || this._saveTimer !== null)
            return;
        this._saveTimer = this._timeoutAdd(SAVE_DEBOUNCE_MS, () => {
            this._saveTimer = null;
            if (!this._destroyed)
                saveProbeCache(this._cachePath, this._kindCache);
        });
    }

    lastSampleText(win) {
        const entry = this._lastSamples.get(win);
        if (!entry)
            return 'none';
        if (entry.error)
            return `error:${entry.error}`;
        if (!entry.sample)
            return `null(verdict=${entry.verdict})`;
        return `corners=[${entry.sample.corners.join(',')}] interior=${entry.sample.interior} verdict=${entry.verdict}`;
    }

    forgetWindow(win) {
        const entry = this._inFlight.get(win);
        this._inFlight.delete(win);
        const retry = this._pendingRetries.get(win);
        this._pendingRetries.delete(win);
        this._clearWait(win);
        this._retryCounts.delete(win);
        this._winCache.delete(win);
        this._lastSamples.delete(win);
        entry?.cancellable.cancel();
        if (retry)
            this._timeoutRemove(retry.id);
    }

    setOnCornerKnown(cb) {
        this._onCornerKnown = cb;
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._onCornerKnown = null;
        if (this._saveTimer !== null) {
            this._timeoutRemove(this._saveTimer);
            this._saveTimer = null;
            saveProbeCache(this._cachePath, this._kindCache);
        }
        const entries = [...this._inFlight.values()];
        const retries = [...this._pendingRetries.values()];
        const waits = [...this._pendingWaits.values()];
        this._inFlight.clear();
        this._pendingRetries.clear();
        this._pendingWaits.clear();
        this._retryCounts.clear();
        this._winCache.clear();
        this._lastSamples.clear();
        this._revalidated.clear();
        for (const entry of entries)
            entry.cancellable.cancel();
        for (const retry of retries)
            this._timeoutRemove(retry.id);
        for (const wait of waits)
            wait.cancel();
    }
}
