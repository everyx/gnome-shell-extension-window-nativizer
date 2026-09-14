import {
    classifyProcess,
    destroy,
    forgetProcess,
    hasNativeLikeCorners,
    hasAdwaitaLook,
} from '../src/lib/nativeLikeCorners.js';

const mapped = path => `7f9914000-7f9915000 r-xp 00000000 103:02 12345 ${path}\n`;
const maps = (...paths) => paths.map(mapped).join('');

describe('nativeLikeCorners', () => {
    beforeEach(() => {
        destroy();
    });

    afterEach(() => {
        destroy();
    });

    describe('classifyProcess', () => {
        it('takes libadwaita as a provider', () => {
            const mapsText = maps('/usr/lib/libgtk-4.so.1', '/usr/lib/libadwaita-1.so.0');
            expect(classifyProcess(mapsText)).toBeTrue();
        });

        it('takes libhandy as a provider', () => {
            expect(classifyProcess(maps('/usr/lib/libhandy-1.so.0'))).toBeTrue();
        });

        it('takes Qt decoration plugins as providers, named by their own path', () => {
            const qadwaita = '/usr/lib/qt6/plugins/wayland-decoration-client/libqadwaitadecorations.so';
            const plugin = '/usr/lib/qt6/plugins/wayland-decoration-client/libadwaita.so';
            expect(classifyProcess(maps(qadwaita))).toBeTrue();
            expect(classifyProcess(maps(plugin))).toBeTrue();
        });

        it('reports a plain GTK program as holding no provider', () => {
            expect(classifyProcess(maps('/usr/lib/libgtk-4.so.1'))).toBeFalse();
            expect(classifyProcess(maps('/usr/lib/libgtk-3.so.0'))).toBeFalse();
        });

        it('reports Qt, Chromium and libc as holding no provider', () => {
            expect(classifyProcess(maps('/usr/lib/libc.so.6', '/usr/lib/libQt6Core.so.6',
                '/usr/lib/chromium/chromium'))).toBeFalse();
        });

        it('treats missing input as holding no provider', () => {
            for (const input of [null, undefined, '']) {
                expect(classifyProcess(input)).toBeFalse();
            }
        });
    });

    describe('hasAdwaitaLook', () => {
        it('returns false for an invalid pid', () => {
            expect(hasAdwaitaLook(null)).toBeFalse();
            expect(hasAdwaitaLook(0)).toBeFalse();
            expect(hasAdwaitaLook(-1)).toBeFalse();
        });

        it('returns false when the maps cannot be read, and caches nothing', () => {
            let reads = 0;
            const readMaps = () => { reads++; throw new Error('EACCES'); };
            expect(hasAdwaitaLook(717171, {readMaps})).toBeFalse();
            expect(hasAdwaitaLook(717171, {readMaps})).toBeFalse();
            expect(reads).toBe(2);
        });

        it('reads a pid once, then serves the cache', () => {
            let reads = 0;
            const readMaps = () => { reads++; return maps('/usr/lib/libc.so.6'); };
            hasAdwaitaLook(515151, {readMaps});
            hasAdwaitaLook(515151, {readMaps});
            expect(reads).toBe(1);
        });

        it('re-reads a pid once it is forgotten', () => {
            let reads = 0;
            const readMaps = () => { reads++; return maps('/usr/lib/libc.so.6'); };
            hasAdwaitaLook(616161, {readMaps});
            forgetProcess(616161);
            hasAdwaitaLook(616161, {readMaps});
            expect(reads).toBe(2);
        });

        it('accepts a mapped provider', () => {
            const readMaps = () => maps('/usr/lib/libadwaita-1.so.0');
            expect(hasAdwaitaLook(424242, {readMaps})).toBeTrue();
        });

        it('rejects a GTK program holding no provider', () => {
            expect(hasAdwaitaLook(424243, {
                readMaps: () => maps('/usr/lib/libgtk-4.so.1', '/usr/lib/libgtk-3.so.0'),
            })).toBeFalse();
        });

        it('rejects a non-GTK program', () => {
            expect(hasAdwaitaLook(424245, {readMaps: () => maps('/usr/lib/libQt6Core.so.6')}))
                .toBeFalse();
        });
    });

    describe('hasNativeLikeCorners', () => {
        it('probes the pid the window reports', () => {
            let asked = 0;
            hasNativeLikeCorners({get_pid: () => { asked++; return 9999999; }});
            expect(asked).toBe(1);
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
