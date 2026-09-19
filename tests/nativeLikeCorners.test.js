import {
    classifyProcess,
    destroy,
    forgetProcess,
    hasGtk4Client,
    hasNativeLikeCorners,
    hasAdwaitaLook,
    init,
    isAdwaitaLookPending,
    probeAdwaitaLook,
    setOnProcessKnown,
} from '../src/lib/nativeLikeCorners.js';

const mapped = path => `7f9914000-7f9915000 r-xp 00000000 103:02 12345 ${path}\n`;
const maps = (...paths) => paths.map(mapped).join('');

describe('nativeLikeCorners', () => {
    beforeEach(() => {
        init();
    });

    afterEach(() => {
        destroy();
    });

    describe('classifyProcess', () => {
        // The two answers a process gives: the Adwaita look (any provider) and whether the
        // client is GTK4 (libadwaita only), which is the one the resize band reads.
        const look = mapsText => classifyProcess(mapsText).adwaitaLook;
        const gtk4 = mapsText => classifyProcess(mapsText).gtk4;

        it('takes libadwaita as a provider, and as the GTK4 one', () => {
            const mapsText = maps('/usr/lib/libgtk-4.so.1', '/usr/lib/libadwaita-1.so.0');
            expect(look(mapsText)).toBeTrue();
            expect(gtk4(mapsText)).toBeTrue();
        });

        it('takes libhandy as a provider, but not as a GTK4 client', () => {
            const mapsText = maps('/usr/lib/libhandy-1.so.0');
            expect(look(mapsText)).toBeTrue();
            expect(gtk4(mapsText)).toBeFalse();
        });

        it('takes libxul as a provider (Mozilla Gecko / Firefox), but not as a GTK4 client', () => {
            const mapsText = maps('/usr/lib/firefox/libxul.so');
            expect(look(mapsText)).toBeTrue();
            expect(gtk4(mapsText)).toBeFalse();
        });

        it('does not take the Qt 6 built-in decoration plugin as a provider — it is top-only (ceCornerRadius=12)', () => {
            const plugin = '/usr/lib/qt6/plugins/wayland-decoration-client/libadwaita.so';
            expect(look(maps(plugin))).toBeFalse();
            expect(gtk4(maps(plugin))).toBeFalse();
        });

        it('does not take QAdwaitaDecorations as a provider — it will be nativized (top-only radius)', () => {
            const qadwaita = '/usr/lib/qt6/plugins/wayland-decoration-client/libqadwaitadecorations.so';
            expect(look(maps(qadwaita))).toBeFalse();
        });

        it('still takes libadwaita-1.so, libhandy-1.so, and libxul.so as native-like (regression guard)', () => {
            expect(look(maps('/usr/lib/libadwaita-1.so.0'))).toBeTrue();
            expect(look(maps('/usr/lib/libhandy-1.so.0'))).toBeTrue();
            expect(look(maps('/usr/lib/firefox/libxul.so'))).toBeTrue();
            expect(look(maps('/usr/lib/libadwaita-1.so.0', '/usr/lib/libhandy-1.so.0', '/usr/lib/firefox/libxul.so'))).toBeTrue();
        });

        it('reports a plain GTK program as holding no provider, GTK4 included', () => {
            expect(look(maps('/usr/lib/libgtk-4.so.1'))).toBeFalse();
            expect(look(maps('/usr/lib/libgtk-3.so.0'))).toBeFalse();
            // A GTK4 program without libadwaita has the same handle, but nothing readable says so.
            expect(gtk4(maps('/usr/lib/libgtk-4.so.1'))).toBeFalse();
        });

        it('reports Qt, Chromium and libc as holding no provider', () => {
            expect(look(maps('/usr/lib/libc.so.6', '/usr/lib/libQt6Core.so.6',
                '/usr/lib/chromium/chromium'))).toBeFalse();
        });

        it('treats missing input as holding no provider', () => {
            for (const input of [null, undefined, '']) {
                expect(look(input)).toBeFalse();
                expect(gtk4(input)).toBeFalse();
            }
        });
    });

    describe('hasGtk4Client', () => {
        const reader = mapsText => (pid, done) => done(mapsText);

        it('returns false for an invalid pid', () => {
            expect(hasGtk4Client(null)).toBeFalse();
            expect(hasGtk4Client(0)).toBeFalse();
            expect(hasGtk4Client(-1)).toBeFalse();
        });

        it('answers yes for a libadwaita process', () => {
            expect(hasGtk4Client(828282, {readMaps: reader(maps('/usr/lib/libadwaita-1.so.0'))}))
                .toBeTrue();
        });

        it('answers no for the GTK3 providers, whose handle is not theirs to report', () => {
            expect(hasGtk4Client(828283, {readMaps: reader(maps('/usr/lib/firefox/libxul.so'))}))
                .toBeFalse();
            expect(hasGtk4Client(828284, {readMaps: reader(maps('/usr/lib/libhandy-1.so.0'))}))
                .toBeFalse();
        });

        it('reads as no while the answer is in flight, then yes once it lands', () => {
            // Only a landed answer may take a band away from a window, so this default is the
            // opposite of `hasAdwaitaLook()`'s - that one counts an answer still coming as yes.
            let finish;
            const readMaps = (pid, done) => { finish = done; };
            expect(hasGtk4Client(838383, {readMaps})).toBeFalse();
            expect(hasAdwaitaLook(838383, {readMaps})).toBeTrue();
            finish(maps('/usr/lib/libadwaita-1.so.0'));
            expect(hasGtk4Client(838383, {readMaps})).toBeTrue();
        });
    });

    describe('hasAdwaitaLook', () => {
        // The reader is injected in the shape a real asynchronous read finishes with, so a spec
        // can hold the answer back and see what a caller does while it is still unknown.
        const reader = mapsText => (pid, done) => done(mapsText);
        const failing = (pid, done) => done(null, new Error('EACCES'));

        it('returns false for an invalid pid', () => {
            expect(hasAdwaitaLook(null)).toBeFalse();
            expect(hasAdwaitaLook(0)).toBeFalse();
            expect(hasAdwaitaLook(-1)).toBeFalse();
        });

        it('decorates a process whose maps cannot be read, and reads it once', () => {
            let reads = 0;
            const readMaps = (pid, done) => { reads++; done(null, new Error('EACCES')); };
            expect(hasAdwaitaLook(717171, {readMaps})).toBeFalse();
            expect(hasAdwaitaLook(717171, {readMaps})).toBeFalse();
            expect(reads).toBe(1);
        });

        it('decorates a process whose reader throws instead of answering', () => {
            const readMaps = () => { throw new Error('boom'); };
            expect(hasAdwaitaLook(717172, {readMaps})).toBeFalse();
            // A throw is an answer: the pid must not stay pending, or its windows would never be decided.
            expect(isAdwaitaLookPending(717172)).toBeFalse();
            expect(hasAdwaitaLook(717172, {readMaps})).toBeFalse();
        });

        it('leaves a window alone while its read is in flight, then answers', () => {
            let finish;
            const readMaps = (pid, done) => { finish = done; };

            expect(hasAdwaitaLook(313131, {readMaps})).toBeTrue();
            expect(hasAdwaitaLook(313131, {readMaps})).toBeTrue(); // one read, still in flight
            finish(maps('/usr/lib/libgtk-4.so.1'));
            expect(hasAdwaitaLook(313131, {readMaps})).toBeFalse(); // now from the cache
        });

        it('reports the pid whose answer landed', () => {
            const known = [];
            setOnProcessKnown(pid => known.push(pid));

            expect(hasAdwaitaLook(414141, {readMaps: failing})).toBeFalse();
            expect(known).toEqual([414141]);
        });

        it('reads a pid once, then serves the cache', () => {
            let reads = 0;
            const readMaps = (pid, done) => { reads++; done(maps('/usr/lib/libc.so.6')); };
            hasAdwaitaLook(515151, {readMaps});
            hasAdwaitaLook(515151, {readMaps});
            expect(reads).toBe(1);
        });

        it('re-reads a pid once it is forgotten', () => {
            let reads = 0;
            const readMaps = (pid, done) => { reads++; done(maps('/usr/lib/libc.so.6')); };
            hasAdwaitaLook(616161, {readMaps});
            forgetProcess(616161);
            hasAdwaitaLook(616161, {readMaps});
            expect(reads).toBe(2);
        });

        it('accepts a mapped provider', () => {
            expect(hasAdwaitaLook(424242, {readMaps: reader(maps('/usr/lib/libadwaita-1.so.0'))}))
                .toBeTrue();
        });

        it('rejects a GTK program holding no provider', () => {
            expect(hasAdwaitaLook(424243, {
                readMaps: reader(maps('/usr/lib/libgtk-4.so.1', '/usr/lib/libgtk-3.so.0')),
            })).toBeFalse();
        });

        it('rejects a non-GTK program', () => {
            expect(hasAdwaitaLook(424245, {readMaps: reader(maps('/usr/lib/libQt6Core.so.6'))}))
                .toBeFalse();
        });

        it('ignores an answer that lands after the pid was forgotten', () => {
            const known = [];
            let finish;
            setOnProcessKnown(pid => known.push(pid));

            hasAdwaitaLook(515100, {readMaps: (pid, done) => { finish = done; }});
            forgetProcess(515100);
            finish(maps('/usr/lib/libadwaita-1.so.0'));

            expect(known).toEqual([]);
            // Forgotten is unknown again: the next query reads afresh instead of trusting that.
            expect(hasAdwaitaLook(515100, {readMaps: reader(maps('/usr/lib/libc.so.6'))}))
                .toBeFalse();
        });

        it('drops the cache and the callback on destroy()', () => {
            const known = [];
            let finish;
            setOnProcessKnown(pid => known.push(pid));

            hasAdwaitaLook(616100, {readMaps: (pid, done) => { finish = done; }});
            destroy();
            finish(maps('/usr/lib/libgtk-4.so.1'));

            expect(known).toEqual([]);
            // A stale `false` from that read must not stand as this pid's answer;
            // query defaults to true when destroyed without firing new I/O.
            expect(hasAdwaitaLook(616100, {readMaps: reader(maps('/usr/lib/libadwaita-1.so.0'))}))
                .toBeTrue();
        });
    });

    describe('isAdwaitaLookPending', () => {
        it('returns false for an invalid pid', () => {
            expect(isAdwaitaLookPending(null)).toBeFalse();
            expect(isAdwaitaLookPending(0)).toBeFalse();
            expect(isAdwaitaLookPending(-1)).toBeFalse();
        });

        it('is false before probing, true while probe is in flight, and false once it lands', () => {
            let finish;
            const readMaps = (pid, done) => { finish = done; };

            expect(isAdwaitaLookPending(272727)).toBeFalse(); // pure query before command
            probeAdwaitaLook(272727, {readMaps});             // command initiates I/O
            expect(isAdwaitaLookPending(272727)).toBeTrue();  // now pending
            finish(maps('/usr/lib/libc.so.6'));
            expect(isAdwaitaLookPending(272727)).toBeFalse(); // landed
        });

        it('returns false immediately when probe resolves synchronously', () => {
            const readMaps = (pid, done) => done(maps('/usr/lib/libc.so.6'));
            probeAdwaitaLook(282828, {readMaps});
            expect(isAdwaitaLookPending(282828)).toBeFalse();
        });

        it('is false once the pid is forgotten or the module is destroyed', () => {
            probeAdwaitaLook(373737, {readMaps: () => {}});
            expect(isAdwaitaLookPending(373737)).toBeTrue();
            forgetProcess(373737);
            expect(isAdwaitaLookPending(373737)).toBeFalse();

            probeAdwaitaLook(383838, {readMaps: () => {}});
            expect(isAdwaitaLookPending(383838)).toBeTrue();
            destroy();
            expect(isAdwaitaLookPending(383838)).toBeFalse();

            let readAttempted = false;
            probeAdwaitaLook(393939, {readMaps: () => { readAttempted = true; }});
            expect(isAdwaitaLookPending(393939)).toBeFalse();
            expect(readAttempted).toBeFalse();
        });
    });

    describe('hasNativeLikeCorners', () => {
        it('probes maps for the pid the window reports', () => {
            let probedPid;
            const readMaps = pid => { probedPid = pid; };
            hasNativeLikeCorners({get_pid: () => 9999999}, {readMaps});
            expect(probedPid).toBe(9999999);
        });

        it('returns false for a window without a usable pid', () => {
            expect(hasNativeLikeCorners({get_pid: () => 0})).toBeFalse();
            expect(hasNativeLikeCorners({})).toBeFalse();
        });

        it('safely handles null and undefined', () => {
            expect(hasNativeLikeCorners(null)).toBeFalse();
            expect(hasNativeLikeCorners(undefined)).toBeFalse();
        });
    });
});
