import {PendingSource} from '../src/effects/pendingSource.js';

/**
 * A fake GLib: ids are handed out in order and `remove()` records what was taken back, so a spec
 * can tell which callback is still able to run. `run(id)` fires one the way GLib would.
 */
function fakeSource() {
    const queued = new Map();
    const removed = [];
    let next = 0;

    return {
        removed,
        add: callback => {
            next += 1;
            queued.set(next, callback);
            return next;
        },
        remove: id => {
            removed.push(id);
            queued.delete(id);
        },
        run(id) {
            const callback = queued.get(id);
            if (!callback)
                throw new Error(`source ${id} is not queued`);
            queued.delete(id);
            const keep = callback();
            // GLib keeps a repeating source under the same id, which is what makes cancel() the
            // only way to end it.
            if (keep)
                queued.set(id, callback);
            return keep;
        },
        get live() {
            return [...queued.keys()];
        },
    };
}

describe('PendingSource (one live source per slot)', () => {
    it('cancels the source it supersedes instead of orphaning it', () => {
        // The bug this exists for: suspending again without cancelling left two idles queued, and
        // the first one zeroed the shared id, so teardown could no longer reach the second.
        const glib = fakeSource();
        const slot = new PendingSource(glib.add, glib.remove);

        slot.queue(() => {});
        const first = glib.live[0];
        slot.queue(() => {});

        expect(glib.removed).toEqual([first]);
        expect(glib.live.length).toBe(1);
    });

    it('cancels the live source, whichever queue produced it', () => {
        const glib = fakeSource();
        const slot = new PendingSource(glib.add, glib.remove);

        slot.queue(() => {});
        const first = glib.live[0];
        slot.queue(() => {});
        const live = glib.live[0];
        slot.cancel();

        expect(glib.removed).toEqual([first, live]);
        expect(glib.live).toEqual([]);
    });

    it('shares one id, so a fired callback leaves the slot empty rather than stale', () => {
        const glib = fakeSource();
        const slot = new PendingSource(glib.add, glib.remove);
        let runs = 0;

        slot.queue(() => {
            runs += 1;
        });
        glib.run(glib.live[0]);

        expect(runs).toBe(1);
        expect(glib.live).toEqual([]);
        // A later cancel is a no-op: nothing is queued, so nothing is removed.
        slot.cancel();
        expect(glib.removed).toEqual([]);
    });

    it('does not remove a source twice when cancel() follows a fire', () => {
        const glib = fakeSource();
        const slot = new PendingSource(glib.add, glib.remove);

        slot.queue(() => {});
        glib.run(glib.live[0]);
        slot.queue(() => {});
        const second = glib.live[0];
        slot.cancel();
        slot.cancel();

        expect(glib.removed).toEqual([second]);
    });

    it('keeps tracking a source the callback asked GLib to keep', () => {
        // The reported inconsistency: returning true leaves the source live in GLib, so the slot
        // must keep its id - otherwise cancel() can no longer end what the callback restarted.
        const glib = fakeSource();
        const slot = new PendingSource(glib.add, glib.remove);

        slot.queue(() => true);
        const id = glib.live[0];
        expect(glib.run(id)).toBeTrue();
        expect(glib.live).toEqual([id]);

        slot.cancel();
        expect(glib.removed).toEqual([id]);
        expect(glib.live).toEqual([]);
    });

    it('keeps a source the callback queues in its place', () => {
        // A callback that re-enters queue() must not have its replacement cleared by the outer
        // callback's own bookkeeping: that is the orphaned-idle bug through a different door.
        const glib = fakeSource();
        const slot = new PendingSource(glib.add, glib.remove);

        slot.queue(() => {
            slot.queue(() => {});
            return false;
        });
        const outer = glib.live[0];
        glib.run(outer);

        // The replacement is live and tracked, so a teardown can still reach it.
        expect(glib.live.length).toBe(1);
        const replacement = glib.live[0];
        expect(replacement).not.toBe(outer);
        slot.cancel();
        expect(glib.removed).toEqual([outer, replacement]);
    });

    it('empties the slot when the callback throws', () => {
        // GLib ends a source whose callback throws; keeping the id would leave cancel() removing a
        // source that is already gone, which GLib answers with a critical rather than a no-op.
        const glib = fakeSource();
        const slot = new PendingSource(glib.add, glib.remove);

        slot.queue(() => {
            throw new Error('set_enabled on a disposed effect');
        });

        expect(() => glib.run(glib.live[0])).toThrowError(/disposed effect/);
        slot.cancel();
        expect(glib.removed).toEqual([]);
    });

    it('empties the slot when the callback removes its source', () => {
        const glib = fakeSource();
        const slot = new PendingSource(glib.add, glib.remove);

        slot.queue(() => false);
        glib.run(glib.live[0]);

        // Nothing is live and nothing is tracked, so a later cancel removes nothing.
        expect(glib.live).toEqual([]);
        slot.cancel();
        expect(glib.removed).toEqual([]);
    });

});

describe('clipEffect suspend bookkeeping (the sequence that orphaned an idle)', () => {
    it('queues at most one disable across suspend, resume and suspend again', () => {
        // The effect itself needs Cogl, so this drives the same slot the effect owns. What the effect
        // adds - resume() cancelling, _suspend() queueing through the slot - is the wiring audited by
        // reading src/effects/clipEffect.js; the invariant it relies on is the one pinned here.
        const glib = fakeSource();
        const slot = new PendingSource(glib.add, glib.remove);
        let suspended = false;
        let disabled = 0;

        const suspend = () => {
            if (suspended)
                return;
            suspended = true;
            slot.queue(() => {
                if (suspended)
                    disabled += 1;
            });
        };
        const resume = () => {
            slot.cancel();
            suspended = false;
        };

        suspend();
        resume();
        suspend();

        // The sequence that used to leave two idles: after it, exactly one source is live.
        expect(glib.live.length).toBe(1);

        // Teardown reaches that one, so no callback runs against a gone effect.
        slot.cancel();
        expect(glib.live).toEqual([]);
        expect(disabled).toBe(0);
    });
});
