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
import {WindowClientType} from '../src/lib/mutterRules.generated.js';
import {buildRuleKeyFromProperties} from '../src/lib/rules.js';
import {extractWindowProperties, extractPhaseProperties} from '../src/lib/pickProperties.js';
import {extractDiagnosticProperties, cachedNativeLikeCorners, DIAGNOSTIC_DECORATION_KEYS} from '../src/lib/pickDiagnostics.js';
import {parseDebugFlag, INSPECTOR_DBUS_IFACE_XML} from '../src/lib/pickWire.js';

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

/** An X11 window with every live getter the diagnostic extraction reads. */
function diagnosticWin(overrides = {}) {
    return {
        get_wm_class: () => 'com.tencent.wechat',
        get_window_type: () => WindowType.NORMAL,
        get_client_type: () => WindowClientType.X11,
        get_transient_for: () => null,
        allows_resize: () => true,
        is_attached_dialog: () => false,
        get_frame_rect: () => ({x: 0, y: 0, width: 800, height: 600}),
        get_buffer_rect: () => ({x: 0, y: 0, width: 800, height: 600}),
        get_compositor_private: () => ({x: 0, y: 0, width: 800, height: 600}),
        ...overrides,
    };
}

describe('extractDiagnosticProperties', () => {
    it('adds the desktop-side diagnostics when asked', () => {
        const view = {
            clipTargetType: 'ClutterActor',
            clipTargetName: '',
            phaseInTransform: true,
            clipFrame: [0, 0, 800, 600],
            clipInsets: {left: 0, top: 0, right: 0, bottom: 0},
            clipScale: 1.25,
            clipEnabled: true,
            clipSuspended: false,
            containerBox: {x: 0, y: 0, width: 800, height: 600},
            shadowWidth: 824,
            shadowHeight: 624,
            shadowCast: {x: 0, y: 0, width: 824, height: 624},
            shadowRightBand: {x1: 812, y1: 0, x2: 824, y2: 624},
        };
        const props = extractDiagnosticProperties(diagnosticWin(), {diagnosticsView: view});

        expect(props.mirrorPhaseX).toBe('0');
        expect(props.appliedPhaseX).toBe('n/a');
        expect(props.frameRect).toBe('{"x":0,"y":0,"width":800,"height":600}');
        expect(props.bufferRect).toBe('{"x":0,"y":0,"width":800,"height":600}');
        expect(props.windowActorAllocation).toBe('{"x":0,"y":0,"width":800,"height":600}');
        expect(props.clipTargetType).toBe('ClutterActor');
        expect(props.clipTargetName).toBe('');
        expect(props.phaseInTransform).toBe('true');
        expect(props.clipFrame).toBe('[0,0,800,600]');
        expect(props.clipInsets).toBe('{"left":0,"top":0,"right":0,"bottom":0}');
        expect(props.clipScale).toBe('1.25');
        expect(props.clipEnabled).toBe('true');
        expect(props.clipSuspended).toBe('false');
        expect(props.containerBox).toBe('{"x":0,"y":0,"width":800,"height":600}');
        expect(props.shadowWidth).toBe('824');
        expect(props.shadowHeight).toBe('624');
        expect(props.shadowCast).toBe('{"x":0,"y":0,"width":824,"height":624}');
        expect(props.shadowRightBand).toBe('{"x1":812,"y1":0,"x2":824,"y2":624}');
    });

    it('renders an untracked window with explicit unavailable clip values', () => {
        const props = extractDiagnosticProperties(diagnosticWin(), null);
        for (const key of DIAGNOSTIC_DECORATION_KEYS)
            expect(props[key]).toBe('unavailable');
        // The window-side reads are still live even with no decoration.
        expect(props.bufferRect).not.toBe('unavailable');
    });

    it('never throws when the live decoration view throws', () => {
        const deco = {get diagnosticsView() { throw new Error('torn down'); }};
        expect(() => extractDiagnosticProperties(diagnosticWin(), deco)).not.toThrow();
        expect(extractDiagnosticProperties(diagnosticWin(), deco).clipEnabled).toBe('unavailable');
    });
});

describe('extractDiagnosticProperties read isolation', () => {
    // One read per logical group, so each can be made to throw on its own.
    const groupReads = () => ({
        phases: () => ({mirrorPhaseX: '1', mirrorPhaseY: '2', appliedPhaseX: 'n/a', appliedPhaseY: 'n/a'}),
        frameRect: () => ({x: 1, y: 2, width: 3, height: 4}),
        bufferRect: () => ({x: 5, y: 6, width: 7, height: 8}),
        actor: () => ({x: 9, y: 10, width: 11, height: 12}),
    });
    const boom = () => { throw new Error('read failed'); };

    it('keeps every other group when the phase read throws', () => {
        const props = extractDiagnosticProperties({}, null, {...groupReads(), phases: boom});
        expect(props.mirrorPhaseX).toBe('unavailable');
        expect(props.frameRect).toBe('{"x":1,"y":2,"width":3,"height":4}');
        expect(props.bufferRect).toBe('{"x":5,"y":6,"width":7,"height":8}');
        expect(props.windowActorAllocation).toBe('{"x":9,"y":10,"width":11,"height":12}');
    });

    it('keeps every other group when the frame-rect read throws', () => {
        const props = extractDiagnosticProperties({}, null, {...groupReads(), frameRect: boom});
        expect(props.frameRect).toBe('unavailable');
        expect(props.mirrorPhaseX).toBe('1');
        expect(props.bufferRect).toBe('{"x":5,"y":6,"width":7,"height":8}');
        expect(props.windowActorAllocation).toBe('{"x":9,"y":10,"width":11,"height":12}');
    });

    it('keeps every other group when the buffer-rect read throws', () => {
        const props = extractDiagnosticProperties({}, null, {...groupReads(), bufferRect: boom});
        expect(props.bufferRect).toBe('unavailable');
        expect(props.frameRect).toBe('{"x":1,"y":2,"width":3,"height":4}');
        expect(props.windowActorAllocation).toBe('{"x":9,"y":10,"width":11,"height":12}');
    });

    it('keeps every other group when the actor read throws', () => {
        const props = extractDiagnosticProperties({}, null, {...groupReads(), actor: boom});
        expect(props.windowActorAllocation).toBe('unavailable');
        expect(props.frameRect).toBe('{"x":1,"y":2,"width":3,"height":4}');
        expect(props.bufferRect).toBe('{"x":5,"y":6,"width":7,"height":8}');
    });
});

describe('parseDebugFlag', () => {
    it('rejects a call with no argument instead of reading it as the quiet pick', () => {
        expect(parseDebugFlag([]).valid).toBeFalse();
        expect(parseDebugFlag(null).valid).toBeFalse();
        expect(parseDebugFlag([undefined]).valid).toBeFalse();
    });

    it('rejects a non-boolean argument', () => {
        expect(parseDebugFlag(['yes']).valid).toBeFalse();
        expect(parseDebugFlag([{}]).valid).toBeFalse();
        expect(parseDebugFlag([1]).valid).toBeFalse();
    });

    it('reads `false` as the quiet interactive pick', () => {
        expect(parseDebugFlag([false])).toEqual({valid: true, diagnostics: false});
    });

    it('reads `true` as diagnostics on the same interactive pick', () => {
        expect(parseDebugFlag([true])).toEqual({valid: true, diagnostics: true});
    });
});

describe('cachedNativeLikeCorners', () => {
    it('reads the cached classification without starting a probe', () => {
        let probed = 0;
        const classifier = {adwaitaLook: () => true, probeAdwaitaLook: () => { probed++; }};
        expect(cachedNativeLikeCorners(classifier, 42)).toBe('true');
        expect(cachedNativeLikeCorners(classifier, 42)).toBe('true');
        expect(probed).toBe(0);
    });

    it('reports unknown when the classifier has no cached answer yet', () => {
        expect(cachedNativeLikeCorners({adwaitaLook: () => null}, 42)).toBe('unknown');
        expect(cachedNativeLikeCorners({adwaitaLook: () => undefined}, 42)).toBe('unknown');
    });

    it('reports cannotTell when there is no classifier to ask', () => {
        expect(cachedNativeLikeCorners(null, 42)).toBe('cannotTell');
        expect(cachedNativeLikeCorners({}, 42)).toBe('cannotTell');
    });

    it('keeps a cached negative distinct from no answer', () => {
        expect(cachedNativeLikeCorners({adwaitaLook: () => false}, 42)).toBe('false');
    });
});

describe('diagnostic vocabulary', () => {
    it('keeps unavailable, unknown, n/a and cannotTell distinct', () => {
        // `unavailable`: a reachable read that did not return.
        expect(extractDiagnosticProperties(diagnosticWin(), null).clipEnabled).toBe('unavailable');
        // `n/a`: the applied phase does not exist for a non-Wayland client.
        expect(extractPhaseProperties(diagnosticWin()).appliedPhaseX).toBe('n/a');
        // `unknown`: the classifier has no landed answer yet.
        expect(cachedNativeLikeCorners({adwaitaLook: () => null}, 42)).toBe('unknown');
        // `cannotTell`: there is no classifier to ask.
        expect(cachedNativeLikeCorners(null, 42)).toBe('cannotTell');
        // The four tokens are all different, so a consumer cannot fold one into another.
        expect(new Set(['unavailable', 'unknown', 'n/a', 'cannotTell']).size).toBe(4);
    });
});

describe('PickWindow D-Bus interface', () => {
    it('declares the required boolean under the original method name', () => {
        expect(INSPECTOR_DBUS_IFACE_XML).toContain('name="PickWindow"');
        expect(INSPECTOR_DBUS_IFACE_XML).toContain('type="b" direction="in" name="debug"');
    });
});
