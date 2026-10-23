/**
 * The overview's two hooks are one unit: a resize moves the mask, a workspace move rebuilds the
 * clone's card, and both are installed and dropped together. What this pins is the failure in
 * between - the one case a count of live subscriptions cannot answer.
 */

import {OverviewDecoration} from '../src/lib/overviewDecoration.js';

/** A window whose second hook can be made to fail once, the way a disposed actor does. */
function fakeWindow({refuse = 0} = {}) {
    const state = {connects: 0, disconnects: 0, refuse};
    return {
        state,
        connect(signal) {
            state.connects++;
            if (signal === 'workspace-changed' && state.refuse-- > 0)
                throw new Error('window is being disposed');
            return state.connects;
        },
        disconnect() {
            state.disconnects++;
        },
    };
}

describe('OverviewDecoration hooks', () => {
    it('retries the pair a failed connect left half-installed', () => {
        const win = fakeWindow({refuse: 1});
        const overview = new OverviewDecoration(win, {});
        overview._inOverview = true;

        expect(() => overview._syncHooks()).toThrowError(/being disposed/);
        // Half of the pair is live, which is exactly why the retry cannot ask "is anything there".
        expect(overview._hooks.count).toBe(1);

        overview._syncHooks();
        expect(overview._hooks.count).toBe(2);
        expect(overview._hooksInstalled).toBeTrue();
    });

    it('installs the pair once per episode, not once per settle', () => {
        // setMode and every _refresh settle through here while in the overview: reconnecting would
        // drop and restore the very handler that is being emitted.
        const win = fakeWindow();
        const overview = new OverviewDecoration(win, {});
        overview._inOverview = true;

        overview._syncHooks();
        overview._syncHooks();
        overview._syncHooks();
        expect(win.state.connects).toBe(2);
        expect(overview._hooks.count).toBe(2);
    });

    it('drops both when the overview is left, and can install them again', () => {
        const win = fakeWindow();
        const overview = new OverviewDecoration(win, {});
        overview._inOverview = true;
        overview._syncHooks();

        overview._inOverview = false;
        overview._syncHooks();
        expect(overview._hooks.count).toBe(0);
        expect(overview._hooksInstalled).toBeFalse();

        overview._inOverview = true;
        overview._syncHooks();
        expect(overview._hooks.count).toBe(2);
    });
});
