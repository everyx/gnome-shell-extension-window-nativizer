import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {isClipSafe} from './cornerReading.js';
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
        this._kindCache = this._cachePath ? loadProbeCache(this._cachePath) : new Set();
        this._winCache = new Map();
        this._lastSamples = new Map();
        this._inFlight = new Map();
        this._pendingRetries = new Map();
        this._pendingWaits = new Map();
        this._retryCounts = new Map();
        this._saveTimer = null;
        this._onCornerKnown = options.onCornerKnown ?? null;
        this._readCorners = options.readCorners ?? readActorCornerAlpha;
        this._isDecorated = options.isDecorated ?? (() => false);
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

    /** Tri-state: true (our clip cuts solid pixels), false (it would cut content), null while unknown. */
    clipSafe(win, frameRect, kindKey = null) {
        if (!win || !frameRect)
            return null;
        const cached = this._winCache.get(win);
        if (cached && sameDimensions(cached, frameRect))
            return cached.value;
        // The cache holds the kinds we measured as safe to clip: that is the answer worth sharing,
        // because the other one is the stand-down an unprobed window already takes.
        if (kindKey && this._kindCache.has(kindKey))
            return true;
        return null;
    }

    probe(win, actor, frameRect, kindKey = null, deps = {}) {
        if (this._destroyed || !win || !actor || !frameRect || frameRect.width < 32 || frameRect.height < 32)
            return;
        // A window we rounded samples our own cut: `paint_to_content()` paints the actor with its effects.
        if (this._isDecorated(win))
            return;

        const size = {width: frameRect.width, height: frameRect.height};
        const cached = this._winCache.get(win);
        if (cached && sameDimensions(cached, size))
            return;
        if (cached)
            this._winCache.delete(win);

        // A window of a kind already measured safe needs no answer: it decorates from that entry on
        // its first frame.
        if (kindKey && this._kindCache.has(kindKey))
            return;

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
        // The transition wait and the retries land frames later, by which time the pass may have drawn.
        if (this._isDecorated(win))
            return;
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
            const verdict = error ? null : isClipSafe(sample);
            // Kept for the inspector only.
            const discarded = verdict !== null && this._isDecorated(win);
            this._lastSamples.set(win, {
                sample: sample ?? null,
                verdict,
                error: error ? String(error) : null,
                discarded,
            });
            if (discarded)
                return;
            if (verdict === null) {
                this._scheduleRetry(win, actor, frameRect, kindKey, reader);
                return;
            }
            this._retryCounts.delete(win);
            this._publish(win, frameRect, kindKey, verdict);
        };

        Promise.resolve()
            .then(() => reader(actor, frameRect, entry.cancellable))
            .then(sample => done(sample, null), error => done(null, error));
    }

    /**
     * One answer, one place: the window's own reading, the entry its kind will reuse, and the
     * reconcile for the window in hand. None of the three is derived from another, so no answer can
     * arrive with a consumer that never hears about it.
     */
    _publish(win, frameRect, kindKey, verdict) {
        this._winCache.set(win, {width: frameRect.width, height: frameRect.height, value: verdict});
        // Only "safe to clip" is worth an entry, and it is for the next window of the kind: this one
        // has been waiting since a pass that ran before the read finished.
        if (verdict === true && kindKey && !this._kindCache.has(kindKey)) {
            this._kindCache.add(kindKey);
            this._scheduleSave();
        }
        // Either answer ends the "unknown" the window was drawn under, so both are acted on. A
        // reconcile is idempotent, and asking whether the decision changed is the analysis that let
        // two earlier rounds ship a window nobody came back for.
        try {
            this._onCornerKnown?.(win);
        } catch (cbError) {
            journal.failure(cbError, 'Error in onCornerKnown callback');
        }
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
        const discarded = entry.discarded ? ' discarded=decorated' : '';
        return `corners=[${entry.sample.corners.join(',')}] interior=${entry.sample.interior} ` +
            `verdict=${entry.verdict}${discarded}`;
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
        for (const entry of entries)
            entry.cancellable.cancel();
        for (const retry of retries)
            this._timeoutRemove(retry.id);
        for (const wait of waits)
            wait.cancel();
    }
}
