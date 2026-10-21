/** Which signals can change a decoration input, and how a burst of them becomes one pass. */

import GLib from 'gi://GLib';

import {isDecoratableWindowType} from './detector.js';
import {getSurfaceContainer, getWindowActor, getWindowPid, getWindowType}
    from '../platform/window.js';

/** A drag delivers its signals in bursts; the geometry path is designed for one pass per burst. */
export const RECONCILE_DEBOUNCE_MS = 50;

// No workspace signal: no decoration input depends on the workspace, so keys change nothing.
const WINDOW_SIGNALS = [
    'position-changed', 'size-changed',
    'notify::maximized-horizontally', 'notify::maximized-vertically',
    'notify::fullscreen', 'notify::main-monitor', 'highest-scale-monitor-changed',
];

// Children coming and going can replace the clip target; the actor's allocation is the gate below.
const ACTOR_SIGNALS = ['child-added', 'child-removed'];

/** One tracked window; its signals, debounce and first-frame gate outlive the decoration. */
class TrackedWindow {
    constructor(win, decoration, pid) {
        this.win = win;
        this.decoration = decoration;
        // Read once: a later teardown read can come back empty, leaving no owner to forget it by.
        this.pid = pid;
        this.signals = [];
        this.timeout = null;
        this.idleId = null;
        this.firstFrameDone = false;
        this.actorWired = false;
        // The container notify::allocation is connected to, so a re-wiring pass cannot repeat it.
        this.wiredContainer = null;
        // A vanished container keeps its wiredContainer subscription, but this read reports none.
        this.surfaceContainer = null;
    }

    get isPendingReconcile() {
        return Boolean(this.timeout);
    }
}

export class WindowTracking {
    /** @param [St] - The St namespace the clip-target resolver needs to spot a foreign child. */
    constructor({onPassDue, onGone, debounceMs = RECONCILE_DEBOUNCE_MS, St = null}) {
        this._onPassDue = onPassDue;
        this._onGone = onGone;
        this._debounceMs = debounceMs;
        this._St = St;
        this._windows = new Map();
    }

    get size() {
        return this._windows.size;
    }

    get hasPending() {
        for (const record of this._windows.values()) {
            if (record.timeout)
                return true;
        }
        return false;
    }

    accepts(win) {
        return Boolean(win) && !this._windows.has(win) &&
            isDecoratableWindowType(getWindowType(win));
    }

    /** Runs the first pass now when the actor is allocated, else when its allocation arrives. */
    add(win, decoration) {
        if (!this.accepts(win))
            return null;

        const record = new TrackedWindow(win, decoration, getWindowPid(win));
        this._windows.set(win, record);

        for (const signal of WINDOW_SIGNALS)
            this._connect(record, win, signal, () => this.touch(win));

        // Focus is not debounced: the shadow must start with the animation the user is watching.
        this._connect(record, win, 'notify::appears-focused', () => this.passNow(win));
        this._connect(record, win, 'unmanaging', () => this._onGone(win));

        const actor = getWindowActor(win);
        this.observe(win);
        if (actor && actor.width > 0 && actor.height > 0) {
            record.firstFrameDone = true;
            this.passNow(win);
        } else {
            this.touch(win);
        }
        return record;
    }

    /** Re-read each pass: XWayland swaps the surface child, and the actor can appear late. */
    observe(win) {
        const record = this._windows.get(win);
        if (!record)
            return;

        const actor = getWindowActor(win);
        if (!actor) {
            record.surfaceContainer = null;
            return;
        }

        if (!record.actorWired) {
            record.actorWired = true;
            this._connect(record, actor, 'notify::allocation', () => this._onAllocation(win, actor));
            for (const signal of ACTOR_SIGNALS)
                this._connect(record, actor, signal, () => this.touch(win));
        }

        // The container's allocation can move (0 -> real, buffer swap) while the actor's does not.
        const container = getSurfaceContainer(actor, win, this._St);
        record.surfaceContainer = container;
        if (container && container !== record.wiredContainer) {
            if (record.wiredContainer)
                this._unwatch(record, record.wiredContainer);
            record.wiredContainer = container;
            this._connect(record, container, 'notify::allocation', () => this.touch(win));
        }
    }

    /** Coalesces a burst into one pass; a window already waiting keeps the pass it has. */
    touch(win) {
        const record = this._windows.get(win);
        if (!record || record.timeout)
            return;
        record.timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._debounceMs, () => {
            record.timeout = null;
            this._onPassDue(win);
            return GLib.SOURCE_REMOVE;
        });
    }

    passNow(win) {
        const record = this._windows.get(win);
        if (!record)
            return;
        this._dropPending(record);
        this._onPassDue(win);
    }

    /** An X11 client sets _NET_WM_PID late, so the read at tracking time can come back empty. */
    learnPid(win) {
        const record = this._windows.get(win);
        if (record && !(record.pid > 0))
            record.pid = getWindowPid(win);
        return record?.pid ?? 0;
    }

    get(win) {
        return this._windows.get(win) ?? null;
    }

    /** The container `observe()` read this pass; the decoration consumes it instead of asking. */
    surfaceContainer(win) {
        return this._windows.get(win)?.surfaceContainer ?? null;
    }

    has(win) {
        return this._windows.has(win);
    }

    /** A snapshot, so a caller can release while iterating. */
    entries() {
        return [...this._windows.entries()];
    }

    /** Drops pending work and signals; the decoration stays the caller's to destroy. */
    release(win) {
        const record = this._windows.get(win);
        if (!record)
            return null;
        this._dropPending(record);
        this._unwatch(record, null);
        this._windows.delete(win);
        return record;
    }

    /** The gate opens on an idle: the actor tree cannot be mutated during allocation. */
    _onAllocation(win, actor) {
        const record = this._windows.get(win);
        if (!record)
            return;

        if (record.firstFrameDone || actor.width <= 0 || actor.height <= 0) {
            this.touch(win);
            return;
        }

        if (record.idleId)
            GLib.Source.remove(record.idleId);
        record.idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            record.idleId = null;
            record.firstFrameDone = true;
            this._onPassDue(win);
            return GLib.SOURCE_REMOVE;
        });
    }

    _dropPending(record) {
        if (record.idleId) {
            GLib.Source.remove(record.idleId);
            record.idleId = null;
        }
        if (record.timeout) {
            GLib.Source.remove(record.timeout);
            record.timeout = null;
        }
    }

    _unwatch(record, only) {
        if (only) {
            const index = record.signals.findIndex(([obj]) => obj === only);
            if (index >= 0) {
                this._disconnect(record.signals[index]);
                record.signals.splice(index, 1);
            }
            return;
        }
        for (const entry of record.signals)
            this._disconnect(entry);
        record.signals.length = 0;
    }

    /** A failed connect is swallowed: an object torn down mid-subscription must not abort it. */
    _connect(record, obj, signal, handler) {
        try {
            record.signals.push([obj, obj.connect(signal, handler)]);
        } catch {
            // A signal on a dead object cannot be tracked; the pass that finds it skips it.
        }
    }

    _disconnect([obj, id]) {
        try {
            obj.disconnect(id);
        } catch {
        }
    }
}
