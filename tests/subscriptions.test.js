import {Subscriptions} from '../src/lib/subscriptions.js';

/** A stand-in for a GObject: `connect` hands out increasing ids, `disconnect` records them. */
function fakeObject({throwOnConnect = false} = {}) {
    let nextId = 1;
    const live = new Set();
    return {
        live,
        signals: [],
        connect(signal) {
            if (throwOnConnect)
                throw new Error('object is being disposed');
            const id = nextId++;
            live.add(id);
            this.signals.push(signal);
            return id;
        },
        disconnect(id) {
            if (!live.delete(id))
                throw new Error(`no handler ${id}`);
        },
    };
}

describe('Subscriptions', () => {
    it('disconnects every signal it connected, and only those', () => {
        const subs = new Subscriptions();
        const win = fakeObject();
        const display = fakeObject();
        subs.connect(win, 'unmanaging', () => {});
        subs.connect(win, 'notify::appears-focused', () => {});
        subs.connect(display, 'restacked', () => {});

        expect(subs.count).toBe(3);
        subs.disconnectAll();
        expect(subs.count).toBe(0);
        expect(win.live.size).toBe(0);
        expect(display.live.size).toBe(0);
        // A second teardown is what a partly-failed enable does; it must be a no-op, not a throw.
        subs.disconnectAll();
        expect(subs.count).toBe(0);
    });

    it('drops one owner\'s signals and keeps the rest', () => {
        const subs = new Subscriptions();
        const closing = fakeObject();
        const other = fakeObject();
        subs.connect(closing, 'unmanaging', () => {});
        subs.connect(other, 'restacked', () => {});

        subs.forget(closing);
        expect(closing.live.size).toBe(0);
        expect(other.live.size).toBe(1);
        expect(subs.count).toBe(1);
    });

    it('reports a failed connect by default, because an owner must not lose its own signal', () => {
        const subs = new Subscriptions();
        expect(() => subs.connect(fakeObject({throwOnConnect: true}), 'x', () => {}))
            .toThrowError(/object is being disposed/);
        expect(subs.count).toBe(0);
    });

    it('swallows a failed connect when lenient, and keeps the ones that did connect', () => {
        const subs = new Subscriptions();
        const live = fakeObject();
        subs.connect(fakeObject({throwOnConnect: true}), 'unmanaging', () => {}, {lenient: true});
        subs.connect(live, 'unmanaging', () => {}, {lenient: true});
        expect(subs.count).toBe(1);
        expect(live.live.size).toBe(1);
    });

    it('survives an object that is already destroyed at teardown', () => {
        const subs = new Subscriptions();
        const win = fakeObject();
        subs.connect(win, 'unmanaging', () => {});
        // The object died with its signals still registered: disconnect throws, teardown does not.
        win.live.clear();
        expect(() => subs.disconnectAll()).not.toThrow();
        expect(subs.count).toBe(0);
    });
});
