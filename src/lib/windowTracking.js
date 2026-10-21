/**
 * Window tracking: the windows the manager drives, one record each - the decoration, the signals it
 * is subscribed with, and the two sources that gate a pass.
 *
 * Which signals can change a decoration input, and how a burst of them coalesces into one pass, is
 * routing policy and lives here. What a pass then does with the reading is the manager's business,
 * so this module never reads a window's state, geometry or style.
 */

import GLib from 'gi://GLib';

import {isDecoratableWindowType} from './detector.js';
import {getSurfaceContainer, getWindowActor, getWindowPid, getWindowType}
    from '../platform/window.js';

/**
 * How long a burst of geometry signals settles before one pass reads the window. Every signal a
 * decoration input can change on arrives in bursts during a drag, and one pass per burst is what the
 * geometry path is designed for.
 */
export const RECONCILE_DEBOUNCE_MS = 50;

/**
 * The window signals a decoration input can change on. Keys change nothing here on purpose: the
 * manager connects no workspace signal, because no decoration input depends on the workspace.
 */
const WINDOW_SIGNALS = [
    'position-changed', 'size-changed',
    'notify::maximized-horizontally', 'notify::maximized-vertically',
    'notify::fullscreen', 'notify::main-monitor', 'highest-scale-monitor-changed',
];

/**
 * The actor signals a pass reads: children arriving and leaving can replace the clip target, and the
 * window actor's own allocation is the first-frame gate below.
 */
const ACTOR_SIGNALS = ['child-added', 'child-removed'];

/**
 * One tracked window. The signals, the debounce and the first-frame gate belong to the manager's
 * lifecycle rather than the decoration's, so they live beside it.
 */
class TrackedWindow {
    constructor(win, decoration, pid) {
        this.win = win;
        this.decoration = decoration;
        // Read once and remembered: a later read during teardown can come back empty, which would
        // leave the process classified with no owner to forget it by.
        this.pid = pid;
        this.signals = [];
        this.timeout = null;
        this.idleId = null;
        this.firstFrameDone = false;
        this.actorWired = false;
        // The surface container the clip targets, tracked so its allocation can be watched without
        // re-connecting on every pass. Null until the child exists.
        this.wiredContainer = null;
    }

    get isPendingReconcile() {
        return Boolean(this.timeout);
    }
}

export class WindowTracking {
    /**
     * @param onPassDue - Called with the window when a pass is due; the manager reads and applies
     * @param onGone - Called with the window before its record is dropped, from `unmanaging`
     * @param [debounceMs] - How long a burst settles, for a test clock
     * @param [St] - The St namespace the clip-target resolver identifies a surface container with
     */
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

    /**
     * Whether any tracked window has a pass waiting on its debounce.
     */
    get hasPending() {
        for (const record of this._windows.values()) {
            if (record.timeout)
                return true;
        }
        return false;
    }

    /**
     * @returns Whether the manager draws this window: a decoratable kind it is not already tracking
     */
    accepts(win) {
        return Boolean(win) && !this._windows.has(win) &&
            isDecoratableWindowType(getWindowType(win));
    }

    /**
     * Subscribes a window and runs its first pass: immediately when its actor is already allocated,
     * otherwise once the allocation arrives.
     *
     * @param decoration - The decoration the manager built for this window
     * @returns The record, or null when the window is not one to track
     */
    add(win, decoration) {
        if (!this.accepts(win))
            return null;

        const record = new TrackedWindow(win, decoration, getWindowPid(win));
        this._windows.set(win, record);

        for (const signal of WINDOW_SIGNALS)
            this._connect(record, win, signal, () => this.touch(win));

        // Focus is not geometry, so it is not debounced: the shadow it selects is the animation the
        // user is watching, and delaying its start by the debounce window is visible against the
        // window's own backdrop change.
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

    /**
     * Re-reads where this window's actor signals belong. Called from every pass, because the surface
     * container can be replaced (XWayland swaps the surface child) and the actor itself can appear
     * late.
     */
    observe(win) {
        const record = this._windows.get(win);
        if (!record)
            return;

        const actor = getWindowActor(win);
        if (!actor)
            return;

        if (!record.actorWired) {
            record.actorWired = true;
            this._connect(record, actor, 'notify::allocation', () => this._onAllocation(win, actor));
            for (const signal of ACTOR_SIGNALS)
                this._connect(record, actor, signal, () => this.touch(win));
        }

        // The clip attaches to the surface container, a child of the window actor, whose allocation
        // can move (0 -> real, a buffer swap) without the actor's changing. Watching it re-runs the
        // readings so the insets cannot go stale and re-verifies a target that was deferred while the
        // container was unallocated.
        const container = getSurfaceContainer(actor, win, this._St);
        if (container && container !== record.wiredContainer) {
            if (record.wiredContainer)
                this._unwatch(record, record.wiredContainer);
            record.wiredContainer = container;
            this._connect(record, container, 'notify::allocation', () => this.touch(win));
        }
    }

    /**
     * Coalesces a burst into one pass. A window already waiting is left to the pass it has.
     */
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

    /**
     * Runs a pass now, superseding a debounce that was waiting.
     */
    passNow(win) {
        const record = this._windows.get(win);
        if (!record)
            return;
        this._dropPending(record);
        this._onPassDue(win);
    }

    /**
     * Learns a window's pid after the fact: an X11 client sets `_NET_WM_PID` only once the window
     * exists, so the read taken at tracking time can come back empty.
     *
     * @returns The remembered pid, 0 when unknown
     */
    learnPid(win) {
        const record = this._windows.get(win);
        if (record && !(record.pid > 0))
            record.pid = getWindowPid(win);
        return record?.pid ?? 0;
    }

    get(win) {
        return this._windows.get(win) ?? null;
    }

    has(win) {
        return this._windows.has(win);
    }

    /**
     * @returns A snapshot of [window, record] pairs, so a caller can release while iterating
     */
    entries() {
        return [...this._windows.entries()];
    }

    /**
     * Drops a window's pending work and subscriptions and forgets it. The decoration is the caller's
     * to destroy, in its own order.
     *
     * @returns The record that was dropped, or null
     */
    release(win) {
        const record = this._windows.get(win);
        if (!record)
            return null;
        this._dropPending(record);
        this._unwatch(record, null);
        this._windows.delete(win);
        return record;
    }

    /**
     * The first-frame gate: a window actor only has a size once Mutter has allocated it, and a pass
     * before that reads a placeholder frame. An allocation with an extent opens the gate on an idle
     * (mutating the actor tree during allocation is not allowed); anything else is geometry and is
     * debounced like the rest.
     */
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

    /**
     * @param [only] - Disconnect just this object's signal; omit it to disconnect every signal the
     *        record holds
     */
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

    /**
     * Connects a signal a decoration input can change on. A failure is swallowed: a window or actor
     * torn down mid-subscription must not abort the pass that discovered it.
     */
    _connect(record, obj, signal, handler) {
        try {
            record.signals.push([obj, obj.connect(signal, handler)]);
        } catch {
            // The object is already gone; the pass that found it will not look again.
        }
    }

    _disconnect([obj, id]) {
        try {
            obj.disconnect(id);
        } catch {
            // Object already destroyed.
        }
    }
}
