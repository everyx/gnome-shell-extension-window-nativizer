import GLib from 'gi://GLib';

import {CornerProbe} from '../src/lib/cornerProbe.js';
import {
    isClipSafe,
    cornerProbeKey,
    needsCornerAlphaProbe,
} from '../src/lib/cornerReading.js';
import {evaluateWindowActions, inferDecorationBaseline} from '../src/lib/detector.js';
import {buildRuleKey} from '../src/lib/rules.js';
import {WindowType} from '../src/lib/mutterRules.generated.js';

function flushAsync() {
    return new Promise(resolve => {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

describe('isClipSafe', () => {
    it('counts a clip as safe when every corner matches the interior alpha', () => {
        expect(isClipSafe({corners: [255, 255, 255, 255], interior: 255})).toBeTrue();
        expect(isClipSafe({corners: [220, 220, 220, 220], interior: 220})).toBeTrue();
    });

    it('counts a clip as unsafe when a corner carries other content', () => {
        expect(isClipSafe({corners: [0, 0, 0, 0], interior: 255})).toBeFalse();
        expect(isClipSafe({corners: [14, 14, 14, 14], interior: 255})).toBeFalse();
        expect(isClipSafe({corners: [0, 0, 255, 255], interior: 255})).toBeFalse();
    });

    it('returns null when the window has not painted its first frame yet or read failed', () => {
        expect(isClipSafe(null)).toBeNull();
        expect(isClipSafe({corners: [0, 0, 0, 0], interior: 0})).toBeNull();
        expect(isClipSafe({corners: [null, 255, 255, 255], interior: 255})).toBeNull();
    });
});

describe('needsCornerAlphaProbe', () => {
    const baseReading = {
        hasValidGeometry: true,
        hasSsd: false,
        hasRing: false,
        bufferAlpha: true,
        nativeLikeCorners: false,
        allowsResize: true,
        windowType: WindowType.NORMAL,
    };

    it('probes fixed-size and unverified alpha windows without SSD or ring', () => {
        expect(needsCornerAlphaProbe({...baseReading, allowsResize: false})).toBeTrue();
        expect(needsCornerAlphaProbe({...baseReading, windowType: WindowType.DIALOG})).toBeTrue();
        expect(needsCornerAlphaProbe({...baseReading, windowType: WindowType.UTILITY})).toBeTrue();
    });

    it('skips a maximized window, which Mutter reports as not resizable', () => {
        // `meta_window_allows_resize()` answers false when maximized or fullscreen, so those read as
        // fixed-size; neither is ever decorated, and probing one only costs a read and a cache line.
        const fixed = {hasValidGeometry: true, hasSsd: false, hasRing: false, bufferAlpha: true,
            nativeLikeCorners: false, allowsResize: false, windowType: 0};
        expect(needsCornerAlphaProbe(fixed)).toBeTrue();
        expect(needsCornerAlphaProbe({...fixed, isMaximized: true})).toBeFalse();
        expect(needsCornerAlphaProbe({...fixed, isFullscreen: true})).toBeFalse();
    });

    it('skips resizable normal windows, native-like windows, SSD, and declared rings', () => {
        expect(needsCornerAlphaProbe(baseReading)).toBeFalse();
        expect(needsCornerAlphaProbe({...baseReading, allowsResize: false, nativeLikeCorners: true})).toBeFalse();
        expect(needsCornerAlphaProbe({...baseReading, allowsResize: false, hasSsd: true})).toBeFalse();
        expect(needsCornerAlphaProbe({...baseReading, allowsResize: false, hasRing: true})).toBeFalse();
        expect(needsCornerAlphaProbe({...baseReading, allowsResize: false, bufferAlpha: false})).toBeFalse();
    });
});

describe('cornerProbeKey', () => {
    it('names the kind the way a correction does, size and all', () => {
        const kind = {
            clientTypeToken: 'wayland',
            windowType: WindowType.NORMAL,
            hasParent: false,
            isAttachedDialog: false,
            hasRing: false,
            hasSsd: false,
            frameWidth: 280,
            frameHeight: 380,
        };
        const fixed = cornerProbeKey({...kind, hasValidGeometry: true, wmClass: 'wechat', allowsResize: false});
        expect(fixed).toContain('wechat:');
        expect(fixed).toContain('size=280x380');

        // A resizable window's size is not part of its kind: the same key a rule is written under, so a
        // verdict and a correction cannot describe different windows of one app.
        const resizable = cornerProbeKey({...kind, hasValidGeometry: true, wmClass: 'wechat',
            allowsResize: true});
        expect(resizable).not.toContain(',size=');
        expect(resizable).toBe(buildRuleKey('wechat', {
            ...kind,
            allowsResize: true,
            width: 280,
            height: 380,
        }));

        const pidKey = cornerProbeKey({...kind, hasValidGeometry: true, wmClass: 'pid-1234',
            allowsResize: false});
        expect(pidKey).toBeNull();
    });
});

describe('CornerProbe', () => {
    it('caches verdict per window size and across windows via persistent XDG kind cache', async () => {
        const cachePath = GLib.build_filenamev([GLib.get_tmp_dir(), `wn-probe-test-${GLib.get_monotonic_time()}.json`]);
        const win1 = {};
        const win2 = {};
        const actor = {};
        const rect = {x: 10, y: 20, width: 280, height: 380};
        const kindKey = 'wechat:client_type=wayland,window_type=0,has_parent=false,allows_resize=false,attached_dialog=false,has_ring=false,has_ssd=false,size=280x380';
        const notified = [];
        let reads = 0;

        try {
            const probe1 = new CornerProbe({
                cachePath,
                readCorners: async () => {
                    reads++;
                    return {corners: [255, 255, 255, 255], interior: 255};
                },
                onCornerKnown: w => notified.push(w),
            });

            expect(probe1.clipSafe(win1, rect, kindKey)).toBeNull();
            probe1.probe(win1, actor, rect, kindKey);
            await flushAsync();

            expect(reads).toBe(1);
            expect(notified).toEqual([win1]);
            expect(probe1.clipSafe(win1, rect, kindKey)).toBeTrue();
            // A brand-new window of the same kind hits synchronously without probing first.
            expect(probe1.clipSafe(win2, rect, kindKey)).toBeTrue();
            probe1.destroy();

            // Reloading from the XDG cache file hits synchronously on frame 1 in a fresh session.
            const probe2 = new CornerProbe({
                cachePath,
                readCorners: async () => {
                    reads++;
                    return {corners: [255, 255, 255, 255], interior: 255};
                },
            });
            expect(probe2.clipSafe(win2, rect, kindKey)).toBeTrue();
            probe2.destroy();
        } finally {
            GLib.unlink(cachePath);
        }
    });

    it('waits for transitions-completed when actor is mid-map-animation', async () => {
        const win = {};
        const listeners = new Map();
        const actor = {
            opacity: 180,
            scale_x: 0.92,
            scale_y: 0.92,
            connect: (sig, cb) => {
                listeners.set(sig, cb);
                return 1;
            },
            disconnect: id => {
                if (id === 1)
                    listeners.delete('transitions-completed');
            },
        };
        const rect = {x: 0, y: 0, width: 280, height: 380};
        let reads = 0;

        const probe = new CornerProbe({
            cachePath: null,
            readCorners: async () => {
                reads++;
                return {corners: [255, 255, 255, 255], interior: 255};
            },
            timeoutAdd: () => 99,
            timeoutRemove: () => {},
        });

        probe.probe(win, actor, rect);
        await flushAsync();
        expect(reads).toBe(0);
        expect(listeners.has('transitions-completed')).toBeTrue();

        actor.opacity = 255;
        actor.scale_x = 1;
        actor.scale_y = 1;
        listeners.get('transitions-completed')();
        await flushAsync();

        expect(reads).toBe(1);
        expect(probe.clipSafe(win, rect)).toBeTrue();
        probe.destroy();
    });

    it('retries when first frame is blank and stops cleanly on forgetWindow', async () => {
        const win = {};
        const actor = {};
        const rect = {x: 0, y: 0, width: 640, height: 560};
        const timers = [];
        let attempt = 0;

        const probe = new CornerProbe({
            cachePath: null,
            readCorners: async () => {
                attempt++;
                if (attempt === 1)
                    return {corners: [0, 0, 0, 0], interior: 0};
                return {corners: [0, 0, 0, 0], interior: 255};
            },
            timeoutAdd: (_ms, cb) => {
                const id = timers.length + 1;
                timers.push({id, cb});
                return id;
            },
            timeoutRemove: () => {},
        });

        probe.probe(win, actor, rect);
        await flushAsync();
        expect(probe.clipSafe(win, rect)).toBeNull();
        expect(timers.length).toBe(1);

        timers[0].cb();
        await flushAsync();
        expect(probe.clipSafe(win, rect)).toBeFalse();

        probe.forgetWindow(win);
        expect(probe.clipSafe(win, rect)).toBeNull();
        probe.destroy();
    });

    it('never samples a window our own clip is on', async () => {
        const win = {};
        const actor = {};
        const rect = {x: 0, y: 0, width: 280, height: 380};
        const kindKey = 'wechat:client_type=wayland,window_type=0,has_parent=false,' +
            'allows_resize=false,attached_dialog=false,has_ring=false,has_ssd=false,size=280x380';
        let reads = 0;

        const probe = new CornerProbe({
            cachePath: null,
            isDecorated: () => true,
            readCorners: async () => {
                reads++;
                return {corners: [255, 255, 255, 255], interior: 255};
            },
        });

        probe.probe(win, actor, rect, kindKey);
        await flushAsync();

        expect(reads).toBe(0);
        expect(probe.clipSafe(win, rect, kindKey)).toBeNull();
        probe.destroy();
    });

    it('discards a sample that lands after our clip went on', async () => {
        const win = {};
        const actor = {};
        const rect = {x: 0, y: 0, width: 280, height: 380};
        const kindKey = 'wechat:client_type=wayland,window_type=0,has_parent=false,' +
            'allows_resize=false,attached_dialog=false,has_ring=false,has_ssd=false,size=280x380';
        const notified = [];
        let decorated = false;
        let reads = 0;

        const probe = new CornerProbe({
            cachePath: null,
            isDecorated: () => decorated,
            readCorners: async () => {
                reads++;
                return {corners: [0, 0, 0, 0], interior: 255};
            },
            onCornerKnown: w => notified.push(w),
        });

        probe.probe(win, actor, rect, kindKey);
        // The pass drew between the request and its answer, so the sample reads the corners we cut.
        decorated = true;
        await flushAsync();

        expect(reads).toBe(1);
        expect(notified).toEqual([]);
        expect(probe.clipSafe(win, rect, kindKey)).toBeNull();
        expect(probe.clipSafe({}, rect, kindKey)).toBeNull();
        expect(probe.lastSampleText(win)).toContain('discarded=decorated');
        probe.destroy();
    });

    it('remembers the kinds measured safe to clip, and never that one is unsafe', async () => {
        const win = {};
        const rect = {x: 0, y: 0, width: 280, height: 380};
        const kindKey = 'wechat:client_type=wayland,window_type=0,has_parent=false,' +
            'allows_resize=false,attached_dialog=false,has_ring=false,has_ssd=false,size=280x380';

        const opaque = new CornerProbe({
            cachePath: null,
            readCorners: async () => ({corners: [255, 255, 255, 255], interior: 255}),
        });
        opaque.probe(win, {}, rect, kindKey);
        await flushAsync();
        expect(opaque.clipSafe(win, rect, kindKey)).toBeTrue();
        expect(opaque.clipSafe({}, rect, kindKey)).toBeTrue();
        opaque.destroy();

        const unsafe = new CornerProbe({
            cachePath: null,
            readCorners: async () => ({corners: [0, 0, 0, 0], interior: 255}),
        });
        unsafe.probe(win, {}, rect, kindKey);
        await flushAsync();
        expect(unsafe.clipSafe(win, rect, kindKey)).toBeFalse();
        // Nothing to remember: an unprobed window of the kind already stands down, so an unsafe
        // sample cannot leave a verdict behind for the rest of the session or in the file.
        expect(unsafe.clipSafe({}, rect, kindKey)).toBeNull();
        unsafe.destroy();
    });

    it('decides every window whose kind cannot be shared, and stores nothing for it', async () => {
        const cachePath = GLib.build_filenamev([GLib.get_tmp_dir(), `wn-probe-null-${GLib.get_monotonic_time()}.json`]);
        const rect = {x: 0, y: 0, width: 280, height: 380};
        const notified = [];
        const first = {};
        const second = {};

        try {
            const probe = new CornerProbe({
                cachePath,
                readCorners: async () => ({corners: [255, 255, 255, 255], interior: 255}),
                onCornerKnown: w => notified.push(w),
            });

            // A `pid-*` identity has no kind to share across windows, so each window is its own case.
            probe.probe(first, {}, rect, null);
            await flushAsync();
            probe.probe(second, {}, rect, null);
            await flushAsync();

            expect(notified).toEqual([first, second]);
            expect(probe.clipSafe(second, rect, null)).toBeTrue();
            probe.destroy();

            // Nothing was stored, so the file may never have been written at all.
            if (GLib.file_test(cachePath, GLib.FileTest.EXISTS)) {
                const [, bytes] = GLib.file_get_contents(cachePath);
                expect(Object.keys(JSON.parse(new TextDecoder().decode(bytes)))).toEqual([]);
            }
        } finally {
            GLib.unlink(cachePath);
        }
    });

    it('notifies every window of a kind, not only the probe that filled its entry', async () => {
        const rect = {x: 0, y: 0, width: 280, height: 380};
        const kindKey = 'wechat:client_type=wayland,window_type=0,has_parent=false,' +
            'allows_resize=false,attached_dialog=false,has_ring=false,has_ssd=false,size=280x380';
        const notified = [];
        const pending = [];
        const probe = new CornerProbe({
            cachePath: null,
            readCorners: () => new Promise(resolve => pending.push(() =>
                resolve({corners: [255, 255, 255, 255], interior: 255}))),
            onCornerKnown: w => notified.push(w),
        });
        const first = {};
        const second = {};

        probe.probe(first, {}, rect, kindKey);
        probe.probe(second, {}, rect, kindKey);
        await flushAsync();
        expect(pending.length).toBe(2);

        // The first answer fills the kind entry and decides its own window...
        pending[0]();
        await flushAsync();
        expect(notified).toEqual([first]);

        // ...and the second window, reading that entry as already filled, still has to be decided:
        // its own pass ran before either read finished, so nothing else would come back for it.
        pending[1]();
        await flushAsync();
        expect(notified).toEqual([first, second]);
        expect(probe.clipSafe(second, rect, kindKey)).toBeTrue();
        probe.destroy();
    });

    it('reconciles the window on a self-rounded answer too, and stores nothing for the kind', async () => {
        const rect = {x: 0, y: 0, width: 280, height: 380};
        const kindKey = 'wechat:client_type=wayland,window_type=0,has_parent=false,' +
            'allows_resize=false,attached_dialog=false,has_ring=false,has_ssd=false,size=280x380';
        const notified = [];
        const probe = new CornerProbe({
            cachePath: null,
            readCorners: async () => ({corners: [0, 0, 0, 0], interior: 255}),
            onCornerKnown: w => notified.push(w),
        });
        const win = {};

        probe.probe(win, {}, rect, kindKey);
        await flushAsync();

        expect(probe.clipSafe(win, rect, kindKey)).toBeFalse();
        // The window was drawn under "unknown", so its answer - either answer - has to reach it.
        expect(notified).toEqual([win]);
        // But nothing about it is worth a kind entry: an unprobed window already stands down.
        expect(probe.clipSafe({}, rect, kindKey)).toBeNull();
        probe.destroy();
    });
});

describe('detector with a clip-safe reading', () => {
    it('decorates fixed-size and alpha dialog windows when corner probe proves corners opaque', () => {
        const wechatOpaque = inferDecorationBaseline({
            isX11: false,
            sideW: 0,
            sideH: 0,
            bufferAlpha: true,
            allowsResize: false,
            clipSafe: true,
        });
        expect(wechatOpaque.corners).toBeTrue();
        expect(wechatOpaque.shadow).toBeTrue();

        const wechatSelfRounded = inferDecorationBaseline({
            isX11: false,
            sideW: 0,
            sideH: 0,
            bufferAlpha: true,
            allowsResize: false,
            clipSafe: false,
        });
        expect(wechatSelfRounded.corners).toBeFalse();
        expect(wechatSelfRounded.shadow).toBeFalse();
        expect(wechatSelfRounded.reason).toContain('fixed-size');

        const opaqueDialog = evaluateWindowActions({
            bufferWidth: 400, bufferHeight: 300,
            frameWidth: 400, frameHeight: 300,
            windowType: WindowType.DIALOG,
            bufferAlpha: true,
            clipSafe: true,
            wmClass: 'wechat',
        });
        expect(opaqueDialog.drawClip).toBeTrue();
        expect(opaqueDialog.drawShadow).toBeTrue();
    });
});
