/**
 * Desktop-entry index unit tests: the WM_CLASS matching that decides which app a rule names.
 * Run: pnpm test
 */

import {findAppInfoByWmClass, stripDesktopSuffix} from '../src/lib/appInfo.js';

function app(id, name, startupWmClass = null) {
    return {
        app: {get_startup_wm_class: () => startupWmClass},
        id,
        name,
        wmClass: startupWmClass ?? stripDesktopSuffix(id),
    };
}

describe('stripDesktopSuffix', () => {
    it('drops the suffix a desktop id carries and a WM_CLASS does not', () => {
        expect(stripDesktopSuffix('org.gnome.Nautilus.desktop')).toBe('org.gnome.Nautilus');
        expect(stripDesktopSuffix('firefox')).toBe('firefox');
        expect(stripDesktopSuffix('.desktop')).toBe('');
    });
});

describe('findAppInfoByWmClass', () => {
    const apps = [app('org.gnome.Nautilus.desktop', 'Files'), app('code.desktop', 'Code', 'Code')];

    it('matches a window class against the desktop id without its suffix', () => {
        expect(findAppInfoByWmClass('org.gnome.Nautilus', apps)?.id).toBe('org.gnome.Nautilus.desktop');
    });

    it('matches the startup WM_CLASS case-insensitively', () => {
        expect(findAppInfoByWmClass('code', apps)?.name).toBe('Code');
    });

    it('matches nothing for an empty or unknown class', () => {
        expect(findAppInfoByWmClass('', apps)).toBeNull();
        expect(findAppInfoByWmClass('nope', apps)).toBeNull();
    });
});
