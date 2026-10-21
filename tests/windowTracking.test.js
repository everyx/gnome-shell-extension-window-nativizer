/**
 * Window tracking: which signals wake a pass, how a burst coalesces, and what teardown disconnects.
 * The manager's routing policy used to live in three places inside a 620-line class with no unit
 * test; here it is driven by a fake emitter instead of a compositor.
 * Run: pnpm test
 */

import {WindowTracking, RECONCILE_DEBOUNCE_MS} from '../src/lib/windowTracking.js';
import {WindowType} from '../src/lib/mutterRules.generated.js';

/**
 * A window or actor that records what was connected to it, so a test can count subscriptions and
 * check that teardown released them.
 */
function fakeEmitter(extra = {}) {
    let nextId = 1;
    const live = new Map();  // id -> signal
    return {
        ...extra,
        connect(signal) {
            const id = nextId++;
            live.set(id, signal);
            return id;
        },
        disconnect(id) {
            live.delete(id);
        },
        get liveSignals() {
            return [...live.values()];
        },
        get liveCount() {
            return live.size;
        },
    };
}

/**
 * @param [actorSize] - The window actor's allocation; null for a window with no actor yet
 */
function fakeWindow({type = WindowType.NORMAL, pid = 4242, actor = null, children = null} = {}) {
    const win = fakeEmitter({
        get_window_type: () => type,
        get_pid: () => pid,
        get_compositor_private: () => actor,
    });
    if (actor && children)
        actor.get_children = () => children;
    return win;
}

function fakeActor({width = 800, height = 600} = {}) {
    return fakeEmitter({width, height});
}

/**
 * @returns A tracker whose passes are recorded instead of run
 */
function makeTracker(overrides = {}) {
    const due = [];
    const gone = [];
    const tracking = new WindowTracking({
        onPassDue: win => due.push(win),
        onGone: win => gone.push(win),
        debounceMs: 60_000,  // never fires during a test unless the test advances it
        ...overrides,
    });
    return {tracking, due, gone};
}

const decoration = () => ({destroyed: false, destroy() {
    this.destroyed = true;
}});

describe('WindowTracking — which windows it drives', () => {
    it('accepts a decoratable kind it is not already tracking', () => {
        const {tracking} = makeTracker();
        expect(tracking.accepts(fakeWindow())).toBeTrue();
        expect(tracking.accepts(fakeWindow({type: WindowType.DIALOG}))).toBeTrue();
    });

    it('refuses a kind the extension never decorates, and an already-tracked window', () => {
        const {tracking} = makeTracker();
        expect(tracking.accepts(fakeWindow({type: WindowType.DOCK}))).toBeFalse();
        expect(tracking.accepts(fakeWindow({type: WindowType.TOOLTIP}))).toBeFalse();
        expect(tracking.accepts(null)).toBeFalse();

        const win = fakeWindow();
        tracking.add(win, decoration());
        expect(tracking.accepts(win)).toBeFalse();
    });

    it('refuses to add a window it would not accept, and reports it', () => {
        const {tracking} = makeTracker();
        expect(tracking.add(fakeWindow({type: WindowType.MENU}), decoration())).toBeNull();
        expect(tracking.size).toBe(0);
    });
});

describe('WindowTracking — what wakes a pass', () => {
    it('runs the first pass at once when the actor is already allocated', () => {
        const {tracking, due} = makeTracker();
        const actor = fakeActor();
        const win = fakeWindow({actor});

        tracking.add(win, decoration());

        expect(due).toEqual([win]);
        expect(tracking.get(win).firstFrameDone).toBeTrue();
    });

    it('waits on the debounce when the actor has no allocation yet', () => {
        const {tracking, due} = makeTracker();
        const win = fakeWindow({actor: fakeActor({width: 0, height: 0})});

        tracking.add(win, decoration());

        expect(due).toEqual([]);
        expect(tracking.hasPending).toBeTrue();
        expect(tracking.get(win).firstFrameDone).toBeFalse();
    });

    it('debounces a burst into one pending pass', () => {
        const {tracking, due} = makeTracker();
        const win = fakeWindow({actor: fakeActor()});
        tracking.add(win, decoration());
        due.length = 0;

        // Two geometry signals in the same burst: the second leaves the first pass to run alone.
        tracking.touch(win);
        tracking.touch(win);

        expect(due).toEqual([]);
        expect(tracking.hasPending).toBeTrue();
    });

    it('runs an immediate pass instead of the one the debounce was holding', () => {
        const {tracking, due} = makeTracker();
        const win = fakeWindow({actor: fakeActor()});
        tracking.add(win, decoration());
        due.length = 0;

        tracking.touch(win);
        tracking.passNow(win);

        expect(due).toEqual([win]);
        expect(tracking.hasPending).toBeFalse();
    });

    it('subscribes the window signals a decoration input can change on, and focus separately', () => {
        const {tracking} = makeTracker();
        const win = fakeWindow({actor: fakeActor()});
        tracking.add(win, decoration());

        // Seven geometry signals, the focus one, and the window going away.
        expect(win.liveSignals).toContain('position-changed');
        expect(win.liveSignals).toContain('size-changed');
        expect(win.liveSignals).toContain('notify::maximized-horizontally');
        expect(win.liveSignals).toContain('notify::maximized-vertically');
        expect(win.liveSignals).toContain('notify::fullscreen');
        expect(win.liveSignals).toContain('notify::main-monitor');
        expect(win.liveSignals).toContain('highest-scale-monitor-changed');
        expect(win.liveSignals).toContain('notify::appears-focused');
        expect(win.liveSignals).toContain('unmanaging');
    });

    it('watches the window actor and its surface container, re-wiring a replaced container', () => {
        const {tracking} = makeTracker();
        const first = fakeEmitter({width: 800, height: 600, x: 0, y: 0});
        const second = fakeEmitter({width: 800, height: 600, x: 0, y: 0});
        let children = [first];
        const actor = fakeEmitter({
            width: 800, height: 600,
            get_children: () => children,
        });
        const win = fakeWindow({actor});

        tracking.add(win, decoration());
        expect(actor.liveSignals).toContain('notify::allocation');
        expect(actor.liveSignals).toContain('child-added');
        expect(actor.liveSignals).toContain('child-removed');
        expect(first.liveSignals).toContain('notify::allocation');

        // XWayland swaps the surface child: the old container's watch goes, the new one's arrives.
        children = [second];
        tracking.observe(win);

        expect(first.liveCount).toBe(0);
        expect(second.liveSignals).toContain('notify::allocation');
        expect(tracking.get(win).wiredContainer).toBe(second);
    });

    it('hands the container it read to the pass, so the clip need not read the rule again', () => {
        const {tracking} = makeTracker();
        const container = fakeEmitter({width: 800, height: 600, x: 0, y: 0});
        const actor = fakeEmitter({width: 800, height: 600, get_children: () => [container]});
        const win = fakeWindow({actor});

        tracking.add(win, decoration());
        expect(tracking.surfaceContainer(win)).toBe(container);

        // A pass with no container says so with null, which is different from never having observed.
        const bare = fakeEmitter({width: 800, height: 600, get_children: () => []});
        const other = fakeWindow({actor: bare});
        tracking.add(other, decoration());
        expect(tracking.surfaceContainer(other)).toBeNull();
        expect(tracking.surfaceContainer(fakeWindow())).toBeNull();
    });
});

describe('WindowTracking — teardown', () => {
    it('drops every subscription and the pending pass, and hands back the record', () => {
        const {tracking, due} = makeTracker();
        const actor = fakeActor();
        const win = fakeWindow({actor, pid: 99});
        tracking.add(win, decoration());
        tracking.touch(win);

        const released = tracking.release(win);

        expect(released.pid).toBe(99);
        expect(win.liveCount).toBe(0);
        expect(actor.liveCount).toBe(0);
        expect(tracking.size).toBe(0);
        expect(tracking.hasPending).toBeFalse();
        expect(due).toEqual([win]);
    });

    it('answers a release for a window it never tracked without throwing', () => {
        const {tracking} = makeTracker();
        expect(tracking.release(fakeWindow())).toBeNull();
        expect(tracking.get(fakeWindow())).toBeNull();
    });

    it('pretends nothing is pending once the only window is released', () => {
        const {tracking} = makeTracker();
        const win = fakeWindow({actor: fakeActor({width: 0, height: 0})});
        tracking.add(win, decoration());
        expect(tracking.hasPending).toBeTrue();
        tracking.release(win);
        expect(tracking.hasPending).toBeFalse();
    });
});

describe('WindowTracking — the window a gap leaves behind', () => {
    it('learns a pid that only arrives after tracking', () => {
        const {tracking} = makeTracker();
        let pid = -1;
        const win = fakeWindow({actor: fakeActor()});
        win.get_pid = () => pid;
        tracking.add(win, decoration());
        expect(tracking.get(win).pid).toBe(-1);

        pid = 321;
        expect(tracking.learnPid(win)).toBe(321);
        expect(tracking.get(win).pid).toBe(321);
    });

    it('keeps a pid it already read rather than re-reading it', () => {
        const {tracking} = makeTracker();
        let pid = 7;
        const win = fakeWindow({actor: fakeActor()});
        win.get_pid = () => pid;
        tracking.add(win, decoration());

        pid = 8;
        expect(tracking.learnPid(win)).toBe(7);
    });

    it('hands out a snapshot of its entries, so a caller can release while iterating', () => {
        const {tracking} = makeTracker();
        const win = fakeWindow({actor: fakeActor()});
        tracking.add(win, decoration());

        const entries = tracking.entries();
        expect(entries.length).toBe(1);
        tracking.release(win);
        expect(entries.length).toBe(1);
        expect(tracking.size).toBe(0);
    });

    it('defaults its debounce to the documented window', () => {
        expect(RECONCILE_DEBOUNCE_MS).toBe(50);
    });
});
