import {
    classifyProcess,
    destroy,
    forgetProcess,
    hasNativeLikeCorners,
    isAdwaitaTheme,
    hasAdwaitaLook,
} from '../src/lib/nativeLikeCorners.js';

const mapped = path => `7f9914000-7f9915000 r-xp 00000000 103:02 12345 ${path}\n`;
const maps = (...paths) => paths.map(mapped).join('');
const neverAsks = {gtkTheme: () => { throw new Error('theme must not be read'); }};

describe('nativeLikeCorners', () => {
    beforeEach(() => {
        destroy();
    });

    afterEach(() => {
        destroy();
    });

    describe('classifyProcess', () => {
        it('takes libadwaita as a provider, and the program as GTK', () => {
            const info = classifyProcess(maps('/usr/lib/libgtk-4.so.1', '/usr/lib/libadwaita-1.so.0'));
            expect(info.hasProvider).toBeTrue();
            expect(info.isGtk).toBeTrue();
        });

        it('takes libhandy as a provider', () => {
            expect(classifyProcess(maps('/usr/lib/libhandy-1.so.0')).hasProvider).toBeTrue();
        });

        it('takes Qt decoration plugins as providers, named by their own path', () => {
            const qadwaita = '/usr/lib/qt6/plugins/wayland-decoration-client/libqadwaitadecorations.so';
            const plugin = '/usr/lib/qt6/plugins/wayland-decoration-client/libadwaita.so';
            expect(classifyProcess(maps(qadwaita)).hasProvider).toBeTrue();
            expect(classifyProcess(maps(plugin)).hasProvider).toBeTrue();
        });

        it('reports a plain GTK program as GTK, holding no provider', () => {
            const info = classifyProcess(maps('/usr/lib/libgtk-4.so.1'));
            expect(info.isGtk).toBeTrue();
            expect(info.hasProvider).toBeFalse();
            expect(classifyProcess(maps('/usr/lib/libgtk-3.so.0')).isGtk).toBeTrue();
        });

        it('reports Qt, Chromium and libc as neither', () => {
            const info = classifyProcess(maps('/usr/lib/libc.so.6', '/usr/lib/libQt6Core.so.6',
                '/usr/lib/chromium/chromium'));
            expect(info.hasProvider).toBeFalse();
            expect(info.isGtk).toBeFalse();
        });

        it('treats missing input as neither', () => {
            for (const input of [null, undefined, '']) {
                expect(classifyProcess(input).hasProvider).toBeFalse();
                expect(classifyProcess(input).isGtk).toBeFalse();
            }
        });
    });

    describe('isAdwaitaTheme', () => {
        it('accepts the adw-gtk3 family, dark and compact variants included', () => {
            expect(isAdwaitaTheme('adw-gtk3')).toBeTrue();
            expect(isAdwaitaTheme('adw-gtk3-dark')).toBeTrue();
            expect(isAdwaitaTheme('adw-gtk3-compact-dark')).toBeTrue();
            expect(isAdwaitaTheme('Adw-gtk3')).toBeTrue();
        });

        it('rejects the names that round only the top corners', () => {
            expect(isAdwaitaTheme('Adwaita')).toBeFalse();
            expect(isAdwaitaTheme('Adwaita-dark')).toBeFalse();
            expect(isAdwaitaTheme('Default')).toBeFalse();
            expect(isAdwaitaTheme('Breeze')).toBeFalse();
        });

        it('rejects missing input', () => {
            expect(isAdwaitaTheme(null)).toBeFalse();
            expect(isAdwaitaTheme(undefined)).toBeFalse();
            expect(isAdwaitaTheme('')).toBeFalse();
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

        it('accepts a mapped provider without consulting the theme', () => {
            const readMaps = () => maps('/usr/lib/libadwaita-1.so.0');
            expect(hasAdwaitaLook(424242, {...neverAsks, readMaps})).toBeTrue();
        });

        it('accepts a GTK program running under an Adwaita theme', () => {
            expect(hasAdwaitaLook(424243, {
                readMaps: () => maps('/usr/lib/libgtk-4.so.1'),
                gtkTheme: () => 'adw-gtk3-dark',
            })).toBeTrue();
        });

        it('rejects a GTK program under any other theme', () => {
            expect(hasAdwaitaLook(424244, {
                readMaps: () => maps('/usr/lib/libgtk-4.so.1'),
                gtkTheme: () => 'Adwaita',
            })).toBeFalse();
        });

        it('rejects a non-GTK program under an Adwaita theme', () => {
            expect(hasAdwaitaLook(424245, {...neverAsks, readMaps: () => maps('/usr/lib/libQt6Core.so.6')}))
                .toBeFalse();
        });

        it('re-reads the theme on every call, unlike the process', () => {
            let themes = 0;
            const api = {
                readMaps: () => maps('/usr/lib/libgtk-3.so.0'),
                gtkTheme: () => { themes++; return 'adw-gtk3'; },
            };
            hasAdwaitaLook(424246, api);
            hasAdwaitaLook(424246, api);
            expect(themes).toBe(2);
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
