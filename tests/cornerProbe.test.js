import GLib from 'gi://GLib';

import {CornerProbe} from '../src/lib/cornerProbe.js';
import {
    classifyCornerAlpha,
    cornerProbeKey,
    needsCornerAlphaProbe,
} from '../src/lib/cornerReading.js';
import {evaluateWindowActions, inferDecorationBaseline} from '../src/lib/detector.js';
import {WindowType} from '../src/lib/mutterRules.generated.js';

function flushAsync() {
    return new Promise(resolve => {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

describe('classifyCornerAlpha', () => {
    it('classifies opaque corners matching interior alpha as not self-rounded', () => {
        expect(classifyCornerAlpha({corners: [255, 255, 255, 255], interior: 255})).toBeFalse();
        expect(classifyCornerAlpha({corners: [220, 220, 220, 220], interior: 220})).toBeFalse();
    });

    it('classifies transparent or shadow-faded corners as self-rounded', () => {
        expect(classifyCornerAlpha({corners: [0, 0, 0, 0], interior: 255})).toBeTrue();
        expect(classifyCornerAlpha({corners: [14, 14, 14, 14], interior: 255})).toBeTrue();
        expect(classifyCornerAlpha({corners: [0, 0, 255, 255], interior: 255})).toBeTrue();
    });

    it('returns null when the window has not painted its first frame yet or read failed', () => {
        expect(classifyCornerAlpha(null)).toBeNull();
        expect(classifyCornerAlpha({corners: [0, 0, 0, 0], interior: 0})).toBeNull();
        expect(classifyCornerAlpha({corners: [null, 255, 255, 255], interior: 255})).toBeNull();
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

    it('skips resizable normal windows, native-like windows, SSD, and declared rings', () => {
        expect(needsCornerAlphaProbe(baseReading)).toBeFalse();
        expect(needsCornerAlphaProbe({...baseReading, allowsResize: false, nativeLikeCorners: true})).toBeFalse();
        expect(needsCornerAlphaProbe({...baseReading, allowsResize: false, hasSsd: true})).toBeFalse();
        expect(needsCornerAlphaProbe({...baseReading, allowsResize: false, hasRing: true})).toBeFalse();
        expect(needsCornerAlphaProbe({...baseReading, allowsResize: false, bufferAlpha: false})).toBeFalse();
    });
});

describe('cornerProbeKey', () => {
    it('builds a stable kind+size key and excludes session-scoped pid-* identities', () => {
        const key = cornerProbeKey({
            hasValidGeometry: true,
            wmClass: 'wechat',
            clientTypeToken: 'wayland',
            windowType: WindowType.NORMAL,
            hasParent: false,
            allowsResize: false,
            isAttachedDialog: false,
            hasRing: false,
            hasSsd: false,
            frameWidth: 280,
            frameHeight: 380,
        });
        expect(key).toContain('wechat:');
        expect(key).toContain('size=280x380');

        const pidKey = cornerProbeKey({
            hasValidGeometry: true,
            wmClass: 'pid-1234',
            clientTypeToken: 'wayland',
            windowType: WindowType.NORMAL,
            allowsResize: false,
            frameWidth: 280,
            frameHeight: 380,
        });
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

            expect(probe1.selfRoundedCorners(win1, rect, kindKey)).toBeNull();
            probe1.probe(win1, actor, rect, kindKey);
            await flushAsync();

            expect(reads).toBe(1);
            expect(notified).toEqual([win1]);
            expect(probe1.selfRoundedCorners(win1, rect, kindKey)).toBeFalse();
            // A brand-new window of the same kind hits synchronously without probing first.
            expect(probe1.selfRoundedCorners(win2, rect, kindKey)).toBeFalse();
            probe1.destroy();

            // Reloading from the XDG cache file hits synchronously on frame 1 in a fresh session.
            const probe2 = new CornerProbe({
                cachePath,
                readCorners: async () => {
                    reads++;
                    return {corners: [255, 255, 255, 255], interior: 255};
                },
            });
            expect(probe2.selfRoundedCorners(win2, rect, kindKey)).toBeFalse();
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
        expect(probe.selfRoundedCorners(win, rect)).toBeFalse();
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
        expect(probe.selfRoundedCorners(win, rect)).toBeNull();
        expect(timers.length).toBe(1);

        timers[0].cb();
        await flushAsync();
        expect(probe.selfRoundedCorners(win, rect)).toBeTrue();

        probe.forgetWindow(win);
        expect(probe.selfRoundedCorners(win, rect)).toBeNull();
        probe.destroy();
    });
});

describe('detector with selfRoundedCorners probe', () => {
    it('decorates fixed-size and alpha dialog windows when corner probe proves corners opaque', () => {
        const wechatOpaque = inferDecorationBaseline({
            isX11: false,
            sideW: 0,
            sideH: 0,
            bufferAlpha: true,
            allowsResize: false,
            selfRoundedCorners: false,
        });
        expect(wechatOpaque.corners).toBeTrue();
        expect(wechatOpaque.shadow).toBeTrue();

        const wechatSelfRounded = inferDecorationBaseline({
            isX11: false,
            sideW: 0,
            sideH: 0,
            bufferAlpha: true,
            allowsResize: false,
            selfRoundedCorners: true,
        });
        expect(wechatSelfRounded.corners).toBeFalse();
        expect(wechatSelfRounded.shadow).toBeFalse();
        expect(wechatSelfRounded.reason).toContain('fixed-size');

        const opaqueDialog = evaluateWindowActions({
            bufferWidth: 400, bufferHeight: 300,
            frameWidth: 400, frameHeight: 300,
            windowType: WindowType.DIALOG,
            bufferAlpha: true,
            selfRoundedCorners: false,
            wmClass: 'wechat',
        });
        expect(opaqueDialog.drawClip).toBeTrue();
        expect(opaqueDialog.drawShadow).toBeTrue();
    });
});
