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
    WindowClientType, buildRuleKeyFromProperties, extractWindowProperties, extractPhaseProperties,
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

    it('marks XWayland clients and encodes every boolean field', () => {
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

describe('extractPhaseProperties', () => {
    let originalGlobal;

    beforeEach(() => {
        originalGlobal = globalThis.global;
    });

    afterEach(() => {
        globalThis.global = originalGlobal;
    });

    const matrix = (tx, ty) => ({
        get_x_translation: () => tx,
        get_y_translation: () => ty,
        get_x_scale: () => 1,
        get_y_scale: () => 1,
    });

    it('carries both phases as strings for a stubbed container', () => {
        // 4/3 monitor at the origin: actor x=241 -> mirror -0.25, actor y=200 -> mirror 0.25. The
        // container sits at 0 and its cached transform carries the same phase, so the two agree.
        globalThis.global = {
            display: {
                get_n_monitors: () => 1,
                get_monitor_scale: () => 4 / 3,
                get_monitor_geometry: () => ({x: 0, y: 0, width: 1920, height: 1080}),
            },
        };
        const container = {x: 0, y: 0, get_transform: () => matrix(-0.25, 0.25)};
        const win = {
            get_client_type: () => WindowClientType.WAYLAND,
            get_frame_rect: () => ({x: 0, y: 0, width: 1920, height: 1080}),
            get_compositor_private: () => ({x: 241, y: 200, get_children: () => [container]}),
        };

        const fields = extractPhaseProperties(win);
        expect(fields.mirrorPhaseX).toBe('-0.25');
        expect(fields.mirrorPhaseY).toBe('0.25');
        expect(fields.appliedPhaseX).toBe('-0.25');
        expect(fields.appliedPhaseY).toBe('0.25');
    });

    it('says a non-Wayland client is not applicable', () => {
        const fields = extractPhaseProperties({get_client_type: () => WindowClientType.X11});
        expect(fields.appliedPhaseX).toBe('n/a');
        expect(fields.appliedPhaseY).toBe('n/a');
    });

    it('says an unreadable container is unavailable and never throws', () => {
        const win = {
            get_client_type: () => WindowClientType.WAYLAND,
            get_frame_rect: () => ({x: 0, y: 0, width: 1920, height: 1080}),
            get_compositor_private: () => ({x: 0, y: 0, get_children: () => []}),
        };
        expect(() => extractPhaseProperties(win)).not.toThrow();
        expect(extractPhaseProperties(win).appliedPhaseX).toBe('unavailable');
        expect(extractPhaseProperties(win).appliedPhaseY).toBe('unavailable');
    });

    it('says the mirror is unknown when a monitor geometry is unreadable', () => {
        globalThis.global = {
            display: {
                get_n_monitors: () => 1,
                get_monitor_scale: () => 1.25,
                get_monitor_geometry: () => null,
            },
        };
        const win = {
            get_client_type: () => WindowClientType.WAYLAND,
            get_frame_rect: () => ({x: 0, y: 0, width: 1920, height: 1080}),
            get_compositor_private: () => ({x: 0, y: 0, get_children: () => []}),
        };
        const fields = extractPhaseProperties(win);
        expect(fields.mirrorPhaseX).toBe('unknown');
        expect(fields.mirrorPhaseY).toBe('unknown');
    });

    it('says the mirror is unknown when an intersecting monitor scale is unreadable', () => {
        // The pick reply must report the new strict-read path as unknown, not echo the 1.0
        // fallback as a zero phase the user would compare against the applied read.
        globalThis.global = {
            display: {
                get_n_monitors: () => 1,
                get_monitor_scale: () => { throw new Error('scale went away'); },
                get_monitor_geometry: () => ({x: 0, y: 0, width: 1920, height: 1080}),
            },
        };
        const win = {
            get_client_type: () => WindowClientType.WAYLAND,
            get_frame_rect: () => ({x: 0, y: 0, width: 1920, height: 1080}),
            get_compositor_private: () => ({x: 0, y: 0, get_children: () => []}),
        };
        const fields = extractPhaseProperties(win);
        expect(fields.mirrorPhaseX).toBe('unknown');
        expect(fields.mirrorPhaseY).toBe('unknown');
    });
});
