/**
 * picker contract unit tests: window identity and properties (jasmine-gjs).
 * Run: pnpm test
 */

import {
    WindowType,
} from '../src/lib/mutterRules.generated.js';
import {
    chooseWindowIdentity, isWindowBackedAppId,
} from '../src/lib/rules.js';
import {
    WindowClientType, buildRuleKeyFromProperties, extractWindowProperties,
} from '../src/lib/pick.js';

/** The exact TypeError GJS raises for a MetaWindow string backed by non-UTF-8 bytes. */
const INVALID_UTF8 = 'String from C value is invalid UTF-8 and cannot be safely stored';
const throwInvalidUtf8 = () => {
    throw new TypeError(INVALID_UTF8);
};

describe('extractWindowProperties', () => {
    it('extracts the full window-kind fingerprint inputs', () => {
        const mockWin = {
            get_wm_class: () => 'com.tencent.wechat',
            get_window_type: () => WindowType.NORMAL,
            get_client_type: () => WindowClientType.WAYLAND,
            get_transient_for: () => ({}),
            allows_resize: () => false,
            is_attached_dialog: () => false,
        };
        expect(extractWindowProperties(mockWin)).toEqual({
            wmClass: 'com.tencent.wechat',
            clientType: 'wayland',
            windowType: String(WindowType.NORMAL),
            hasParent: 'true',
            allowsResize: 'false',
            isAttachedDialog: 'false',
            hasRing: 'false',
            hasSsd: 'false',
            isMaximized: 'false',
            isFullscreen: 'false',
            hasTileMatch: 'false',
        });
    });

    it('marks X11 clients and encodes every boolean field', () => {
        const x11Win = {
            get_wm_class: () => 'wechat',
            get_window_type: () => WindowType.MODAL_DIALOG,
            get_client_type: () => WindowClientType.X11,
            get_transient_for: () => null,
            allows_resize: () => true,
            is_attached_dialog: () => true,
        };
        expect(extractWindowProperties(x11Win)).toEqual({
            wmClass: 'wechat',
            clientType: 'x11',
            windowType: String(WindowType.MODAL_DIALOG),
            hasParent: 'false',
            allowsResize: 'true',
            isAttachedDialog: 'true',
            hasRing: 'false',
            hasSsd: 'false',
            isMaximized: 'false',
            isFullscreen: 'false',
            hasTileMatch: 'false',
        });
    });

    it('detects client declared ring when buffer_rect is larger than frame_rect', () => {
        const ringedWin = {
            get_wm_class: () => 'firefox',
            get_window_type: () => WindowType.NORMAL,
            get_client_type: () => WindowClientType.WAYLAND,
            get_frame_rect: () => ({x: 30, y: 30, width: 800, height: 600}),
            get_buffer_rect: () => ({x: 0, y: 0, width: 860, height: 660}),
            decorated: false,
            get_transient_for: () => null,
            allows_resize: () => true,
            is_attached_dialog: () => false,
        };
        expect(extractWindowProperties(ringedWin).hasRing).toBe('true');

        // Borderless video surface (PiP): buffer_rect matches frame_rect
        const pipWin = {
            get_wm_class: () => 'firefox',
            get_window_type: () => WindowType.NORMAL,
            get_client_type: () => WindowClientType.WAYLAND,
            get_frame_rect: () => ({x: 100, y: 100, width: 400, height: 225}),
            get_buffer_rect: () => ({x: 100, y: 100, width: 400, height: 225}),
            decorated: false,
            get_transient_for: () => null,
            allows_resize: () => true,
            is_attached_dialog: () => false,
        };
        expect(extractWindowProperties(pipWin).hasRing).toBe('false');
    });

    it('carries the SSD flag, so the key can tell an SSD kind from a bare one', () => {
        const ssdWin = {
            get_wm_class: () => 'wps',
            get_window_type: () => WindowType.NORMAL,
            get_client_type: () => WindowClientType.X11,
            decorated: true,
            get_transient_for: () => null,
            allows_resize: () => true,
            is_attached_dialog: () => false,
        };
        const props = extractWindowProperties(ssdWin);
        expect(props.hasSsd).toBe('true');
        // The same window without the frame is a different kind.
        expect(buildRuleKeyFromProperties(props)).toContain('has_ssd=true');
        expect(buildRuleKeyFromProperties(props)).not.toBe(
            buildRuleKeyFromProperties({...props, hasSsd: 'false'}));
    });

    it('falls back to get_sandboxed_app_id when wm_class is unavailable', () => {
        const flatpakWin = {
            get_sandboxed_app_id: () => 'org.signal.Signal',
            get_transient_for: () => null,
            allows_resize: () => true,
        };
        expect(extractWindowProperties(flatpakWin).wmClass).toBe('org.signal.Signal');
    });

    it('accepts a pre-resolved wmClass override (Shell.WindowTracker fallback for WM_CLASS-less windows)', () => {
        const noWmClassWin = {
            get_wm_class: () => null,
            get_transient_for: () => null,
        };
        expect(extractWindowProperties(noWmClassWin, 'wechat').wmClass).toBe('wechat');
    });

    it('handles null and undefined safely', () => {
        expect(extractWindowProperties(null)).toEqual({});
        expect(extractWindowProperties(undefined)).toEqual({});
    });

    it('survives an unreadable wm_class and still reads the rest of the fingerprint', () => {
        const win = {
            get_wm_class: throwInvalidUtf8,
            get_gtk_application_id: () => 'org.example.Wechat',
            get_window_type: () => WindowType.NORMAL,
            get_client_type: () => WindowClientType.X11,
            get_transient_for: () => null,
            allows_resize: () => true,
            is_attached_dialog: () => false,
        };
        expect(() => extractWindowProperties(win)).not.toThrow();
        expect(extractWindowProperties(win)).toEqual({
            wmClass: 'org.example.Wechat',
            clientType: 'x11',
            windowType: String(WindowType.NORMAL),
            hasParent: 'false',
            allowsResize: 'true',
            isAttachedDialog: 'false',
            hasRing: 'false',
            hasSsd: 'false',
            isMaximized: 'false',
            isFullscreen: 'false',
            hasTileMatch: 'false',
        });
    });

    it('carries transient state so prefs can say the rule applies on restore', () => {
        const win = {
            get_wm_class: () => 'wps',
            get_transient_for: () => null,
            is_maximized: () => true,
            is_fullscreen: () => false,
            get_tile_match: () => ({}),
        };
        const props = extractWindowProperties(win);
        expect(props.isMaximized).toBe('true');
        expect(props.isFullscreen).toBe('false');
        expect(props.hasTileMatch).toBe('true');
    });

    it('treats a wholly unreadable name as no identity', () => {
        const win = {
            get_wm_class: throwInvalidUtf8,
            get_sandboxed_app_id: throwInvalidUtf8,
            get_gtk_application_id: throwInvalidUtf8,
            get_transient_for: () => null,
        };
        expect(extractWindowProperties(win).wmClass).toBe('');
    });
});

describe('chooseWindowIdentity', () => {
    it('prefers what the window declares itself', () => {
        const chosen = chooseWindowIdentity({declared: 'wechat', peer: 'other', tracked: 'x.desktop', pid: 1});
        expect(chosen).toBe('wechat');
    });

    it('falls back to a sibling process window when the window declares nothing', () => {
        const chosen = chooseWindowIdentity({peer: 'wechat', tracked: 'snap.wechat', pid: 1});
        expect(chosen).toBe('wechat');
    });

    it('uses the tracker id when it names a real application', () => {
        expect(chooseWindowIdentity({tracked: 'wechat.desktop', pid: 42})).toBe('wechat.desktop');
    });

    it('rejects Shell window-backed placeholder ids', () => {
        expect(isWindowBackedAppId('window:5')).toBeTrue();
        expect(isWindowBackedAppId('wechat.desktop')).toBeFalse();
        expect(chooseWindowIdentity({tracked: 'window:5', pid: 42})).toBe('pid-42');
    });

    it('falls back to a process identity when nothing names the application', () => {
        expect(chooseWindowIdentity({pid: 42})).toBe('pid-42');
    });

    it('returns empty when nothing identifies the window', () => {
        expect(chooseWindowIdentity({})).toBe('');
        expect(chooseWindowIdentity({pid: -1})).toBe('');
    });

    it('ignores a whitespace-only declared identity and falls through', () => {
        expect(chooseWindowIdentity({declared: '   ', pid: 42})).toBe('pid-42');
        expect(chooseWindowIdentity({declared: '   ', tracked: 'wechat.desktop'})).toBe('wechat.desktop');
        expect(chooseWindowIdentity({declared: '   ', peer: 'org.example.Wechat'})).toBe('org.example.Wechat');
    });
});

