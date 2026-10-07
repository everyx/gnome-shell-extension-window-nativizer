import {
    ProcessClassifier,
    classifyProcess,
} from '../src/lib/nativeLikeCorners.js';

const mapped = path => `7f9914000-7f9915000 r-xp 00000000 103:02 12345 ${path}\n`;
const maps = (...paths) => paths.map(mapped).join('');

describe('classifyProcess (pure function)', () => {
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

    it('does not take the Qt 6 built-in decoration plugin as a provider — it is top-only (ceCornerRadius=12)', () => {
        const plugin = '/usr/lib/qt6/plugins/wayland-decoration-client/libadwaita.so';
        expect(look(maps(plugin))).toBeFalse();
        expect(gtk4(maps(plugin))).toBeFalse();
    });

    it('does not take QAdwaitaDecorations as a provider — it will be nativized (top-only radius)', () => {
        const qadwaita = '/usr/lib/qt6/plugins/wayland-decoration-client/libqadwaitadecorations.so';
        expect(look(maps(qadwaita))).toBeFalse();
    });

    it('still takes libadwaita-1.so and libhandy-1.so as native-like (regression guard)', () => {
        expect(look(maps('/usr/lib/libadwaita-1.so.0'))).toBeTrue();
        expect(look(maps('/usr/lib/libhandy-1.so.0'))).toBeTrue();
        expect(look(maps('/usr/lib/libadwaita-1.so.0', '/usr/lib/libhandy-1.so.0'))).toBeTrue();
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

describe('ProcessClassifier (instance-scoped lifecycle)', () => {
    /** @type {ProcessClassifier} */
    let classifier;

    beforeEach(() => {
        classifier = new ProcessClassifier();
    });

    afterEach(() => {
        classifier.destroy();
    });

    describe('hasGtk4Client', () => {
        const reader = mapsText => (pid, done) => done(mapsText);

        it('returns false for an invalid pid', () => {
            expect(classifier.hasGtk4Client(null)).toBeFalse();
            expect(classifier.hasGtk4Client(0)).toBeFalse();
            expect(classifier.hasGtk4Client(-1)).toBeFalse();
        });

        it('answers yes for a libadwaita process', () => {
            classifier.probeAdwaitaLook(828282, {readMaps: reader(maps('/usr/lib/libadwaita-1.so.0'))});
            expect(classifier.hasGtk4Client(828282)).toBeTrue();
        });

        it('answers no for a process that is not GTK4', () => {
            classifier.probeAdwaitaLook(828284, {readMaps: reader(maps('/usr/lib/libhandy-1.so.0'))});
            expect(classifier.hasGtk4Client(828284)).toBeFalse();
        });

        it('reads as no while the answer is in flight, then yes once it lands', () => {
            let finish;
            const readMaps = (pid, done) => { finish = done; };
            classifier.probeAdwaitaLook(838383, {readMaps});
            expect(classifier.hasGtk4Client(838383)).toBeFalse();
            expect(classifier.adwaitaLook(838383)).toBeNull();
            finish(maps('/usr/lib/libadwaita-1.so.0'));
            expect(classifier.hasGtk4Client(838383)).toBeTrue();
        });
    });

    describe('adwaitaLook', () => {
        const reader = mapsText => (pid, done) => done(mapsText);
        const failing = (pid, done) => done(null, new Error('EACCES'));

        it('returns false for an invalid pid', () => {
            expect(classifier.adwaitaLook(null)).toBeFalse();
            expect(classifier.adwaitaLook(0)).toBeFalse();
            expect(classifier.adwaitaLook(-1)).toBeFalse();
        });

        it('decorates a process whose maps cannot be read, and reads it once', () => {
            let reads = 0;
            const readMaps = (pid, done) => { reads++; done(null, new Error('EACCES')); };
            classifier.probeAdwaitaLook(717171, {readMaps});
            expect(classifier.adwaitaLook(717171)).toBeFalse();
            classifier.probeAdwaitaLook(717171, {readMaps}); // idempotent: already cached
            expect(classifier.adwaitaLook(717171)).toBeFalse();
            expect(reads).toBe(1);
        });

        it('decorates a process whose reader throws instead of answering', () => {
            const readMaps = () => { throw new Error('boom'); };
            classifier.probeAdwaitaLook(717172, {readMaps});
            expect(classifier.adwaitaLook(717172)).toBeFalse();
        });

        it('answers nothing while the read is in flight, then the maps answer', () => {
            let finish;
            const readMaps = (pid, done) => { finish = done; };

            classifier.probeAdwaitaLook(313131, {readMaps});
            expect(classifier.adwaitaLook(313131)).toBeNull();
            finish(maps('/usr/lib/libgtk-4.so.1'));
            expect(classifier.adwaitaLook(313131)).toBeFalse();
        });

        it('reports the pid whose answer landed', () => {
            const known = [];
            classifier.setOnProcessKnown(pid => known.push(pid));

            classifier.probeAdwaitaLook(414141, {readMaps: failing});
            expect(classifier.adwaitaLook(414141)).toBeFalse();
            expect(known).toEqual([414141]);
        });

        it('reads a pid once, then serves the cache', () => {
            let reads = 0;
            const readMaps = (pid, done) => { reads++; done(maps('/usr/lib/libc.so.6')); };
            classifier.probeAdwaitaLook(515151, {readMaps});
            expect(classifier.adwaitaLook(515151)).toBeFalse();
            expect(classifier.adwaitaLook(515151)).toBeFalse();
            expect(reads).toBe(1);
        });

        it('re-reads a pid once it is forgotten', () => {
            let reads = 0;
            const readMaps = (pid, done) => { reads++; done(maps('/usr/lib/libc.so.6')); };
            classifier.probeAdwaitaLook(616161, {readMaps});
            classifier.adwaitaLook(616161);
            classifier.forgetProcess(616161);
            classifier.probeAdwaitaLook(616161, {readMaps});
            classifier.adwaitaLook(616161);
            expect(reads).toBe(2);
        });

        it('accepts a mapped provider', () => {
            classifier.probeAdwaitaLook(424242, {readMaps: reader(maps('/usr/lib/libadwaita-1.so.0'))});
            expect(classifier.adwaitaLook(424242)).toBeTrue();
        });

        it('rejects a GTK program holding no provider', () => {
            classifier.probeAdwaitaLook(424243, {
                readMaps: reader(maps('/usr/lib/libgtk-4.so.1', '/usr/lib/libgtk-3.so.0')),
            });
            expect(classifier.adwaitaLook(424243)).toBeFalse();
        });

        it('rejects a non-GTK program', () => {
            classifier.probeAdwaitaLook(424245, {readMaps: reader(maps('/usr/lib/libQt6Core.so.6'))});
            expect(classifier.adwaitaLook(424245)).toBeFalse();
        });

        it('ignores an answer that lands after the pid was forgotten', () => {
            const known = [];
            let finish;
            classifier.setOnProcessKnown(pid => known.push(pid));

            classifier.probeAdwaitaLook(515100, {readMaps: (pid, done) => { finish = done; }});
            classifier.forgetProcess(515100);
            finish(maps('/usr/lib/libadwaita-1.so.0'));

            expect(known).toEqual([]);
            classifier.probeAdwaitaLook(515100, {readMaps: reader(maps('/usr/lib/libc.so.6'))});
            expect(classifier.adwaitaLook(515100)).toBeFalse();
        });

        it('drops the cache and the callback on destroy()', () => {
            const known = [];
            let finish;
            classifier.setOnProcessKnown(pid => known.push(pid));

            classifier.probeAdwaitaLook(616100, {readMaps: (pid, done) => { finish = done; }});
            classifier.destroy();
            finish(maps('/usr/lib/libgtk-4.so.1'));

            expect(known).toEqual([]);
            // A destroyed classifier ignores further probes and answers "not known", starting no I/O
            classifier.probeAdwaitaLook(616100, {readMaps: reader(maps('/usr/lib/libadwaita-1.so.0'))});
            expect(classifier.adwaitaLook(616100)).toBeNull();
        });
    });

    describe('adwaitaLook when there is no answer', () => {
        it('is null until the answer lands, and then the maps answer', () => {
            let finish;
            const readMaps = (pid, done) => { finish = done; };

            classifier.probeAdwaitaLook(272727, {readMaps});
            expect(classifier.adwaitaLook(272727)).toBeNull();
            finish(maps('/usr/lib/libc.so.6'));
            expect(classifier.adwaitaLook(272727)).toBeFalse();
        });

        it('answers in the same call when the probe resolves synchronously', () => {
            const readMaps = (pid, done) => done(maps('/usr/lib/libc.so.6'));
            classifier.probeAdwaitaLook(282828, {readMaps});
            expect(classifier.adwaitaLook(282828)).toBeFalse();
        });

        it('is null once the pid is forgotten or the instance is destroyed', () => {
            classifier.probeAdwaitaLook(373737, {readMaps: () => {}});
            expect(classifier.adwaitaLook(373737)).toBeNull();
            classifier.forgetProcess(373737);
            expect(classifier.adwaitaLook(373737)).toBeNull();

            classifier.probeAdwaitaLook(383838, {readMaps: () => {}});
            expect(classifier.adwaitaLook(383838)).toBeNull();
            classifier.destroy();
            expect(classifier.adwaitaLook(383838)).toBeNull();

            let readAttempted = false;
            classifier.probeAdwaitaLook(393939, {readMaps: () => { readAttempted = true; }});
            expect(classifier.adwaitaLook(393939)).toBeNull();
            expect(readAttempted).toBeFalse();
        });
    });

    describe('query purity', () => {
        it('never starts a read from a query, however often it is called', () => {
            let reads = 0;
            const readMaps = (pid, done) => { reads++; done(maps('/usr/lib/libc.so.6')); };

            expect(classifier.adwaitaLook(700001)).toBeNull();
            expect(classifier.hasGtk4Client(700001)).toBeFalse();
            expect(reads).toBe(0);

            classifier.probeAdwaitaLook(700001, {readMaps});
            expect(reads).toBe(1);
            expect(classifier.adwaitaLook(700001)).toBeFalse();
        });
    });

    describe('multi-instance isolation', () => {
        it('completely isolates process caches, in-flight reads and destruction between instances', () => {
            const c1 = new ProcessClassifier();
            const c2 = new ProcessClassifier();

            const pid = 556677;
            c1.probeAdwaitaLook(pid, {readMaps: (p, done) => done(maps('/usr/lib/libadwaita-1.so.0'))});

            // c1 has cached libadwaita
            expect(c1.hasGtk4Client(pid)).toBeTrue();
            // c2 knows nothing about pid yet
            expect(c2.hasGtk4Client(pid)).toBeFalse();

            // Destroying c1 does not affect c2
            c1.destroy();
            expect(c1.isDestroyed).toBeTrue();
            expect(c2.isDestroyed).toBeFalse();

            // c2 can probe independently
            c2.probeAdwaitaLook(pid, {readMaps: (p, done) => done(maps('/usr/lib/libhandy-1.so.0'))});
            expect(c2.hasGtk4Client(pid)).toBeFalse();
            expect(c2.adwaitaLook(pid)).toBeTrue();

            c2.destroy();
            expect(c2.isDestroyed).toBeTrue();
        });
    });
});
