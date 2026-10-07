import {
    readWindow,
    readDeclaredIdentity,
    getWindowFromActor,
    readWindowString,
    safeRead,
    isWindowReading,
    isClassificationPending,
} from '../src/lib/window.js';

import {evaluateWindowActions} from '../src/lib/detector.js';
import {ProcessClassifier} from '../src/lib/nativeLikeCorners.js';
import {buildRuleKeyFromProperties} from '../src/lib/rules.js';
import {extractWindowProperties} from '../src/lib/pick.js';
import {WindowType, WindowClientType} from '../src/lib/mutterRules.generated.js';

describe('window inspection (readWindow)', () => {
    it('returns null for falsy window references', () => {
        expect(readWindow(null)).toBeNull();
        expect(readWindow(undefined)).toBeNull();
    });

    it('returns null when buffer or frame rect query throws (window tearing down)', () => {
        const tearingDownWin = {
            get_buffer_rect() {
                throw new Error('Window is deallocated');
            },
            get_frame_rect() {
                return {x: 0, y: 0, width: 800, height: 600};
            },
        };
        expect(readWindow(tearingDownWin)).toBeNull();
    });

    it('reads a complete valid window snapshot', () => {
        const mockWin = {
            get_buffer_rect: () => ({x: 100, y: 100, width: 850, height: 650}),
            get_frame_rect: () => ({x: 125, y: 125, width: 800, height: 600}),
            get_client_type: () => WindowClientType.WAYLAND,
            get_window_type: () => WindowType.NORMAL,
            get_wm_class: () => 'org.gnome.TextEditor',
            get_pid: () => 1234,
            decorated: false,
            maximized_horizontally: false,
            maximized_vertically: false,
            is_maximized: () => false,
            is_fullscreen: () => false,
            get_tile_match: () => null,
            get_transient_for: () => null,
            is_attached_dialog: () => false,
            allows_resize: () => true,
            appears_focused: true,
        };

        const reading = readWindow(mockWin);
        expect(reading).not.toBeNull();
        expect(reading.hasValidGeometry).toBeTrue();
        expect(reading.bufferWidth).toBe(850);
        expect(reading.bufferHeight).toBe(650);
        expect(reading.frameWidth).toBe(800);
        expect(reading.frameHeight).toBe(600);
        expect(reading.insets).toEqual({left: 25, top: 25, right: 25, bottom: 25});
        expect(reading.isX11).toBeFalse();
        expect(reading.clientTypeToken).toBe('wayland');
        expect(reading.hasSsd).toBeFalse();
        expect(reading.windowType).toBe(WindowType.NORMAL);
        expect(reading.wmClass).toBe('org.gnome.TextEditor');
        expect(reading.pid).toBe(1234);
        expect(reading.appearsFocused).toBeTrue();
        expect(reading.allowsResize).toBeTrue();
    });

    it('survives throwing getters on metadata reads and provides safe fallbacks', () => {
        const thrower = () => {
            throw new Error('Method unavailable');
        };

        const fragileWin = {
            get_buffer_rect: () => ({x: 0, y: 0, width: 500, height: 400}),
            get_frame_rect: () => ({x: 0, y: 0, width: 500, height: 400}),
            get_client_type: thrower,
            get_window_type: thrower,
            get_wm_class: thrower,
            get_sandboxed_app_id: thrower,
            get_gtk_application_id: thrower,
            get_pid: thrower,
            is_maximized: thrower,
            is_fullscreen: thrower,
            get_transient_for: thrower,
            is_attached_dialog: thrower,
            allows_resize: thrower,
            get_tile_match: thrower,
        };

        const reading = readWindow(fragileWin);
        expect(reading).not.toBeNull();
        expect(reading.isX11).toBeFalse();
        expect(reading.windowType).toBe(WindowType.NORMAL);
        expect(reading.wmClass).toBe('');
        expect(reading.pid).toBe(-1);
        expect(reading.isMaximized).toBeFalse();
        expect(reading.isFullscreen).toBeFalse();
        expect(reading.hasParent).toBeFalse();
        expect(reading.isAttachedDialog).toBeFalse();
        expect(reading.allowsResize).toBeTrue();
    });

    it('supports wmClassOverride option', () => {
        const win = {
            get_buffer_rect: () => ({x: 0, y: 0, width: 500, height: 400}),
            get_frame_rect: () => ({x: 0, y: 0, width: 500, height: 400}),
            get_wm_class: () => 'original_class',
        };
        const reading = readWindow(win, {wmClassOverride: 'custom_override'});
        expect(reading.wmClass).toBe('custom_override');
    });

    it('marks hasValidGeometry false when dimensions are zero or negative', () => {
        const zeroWin = {
            get_buffer_rect: () => ({x: 0, y: 0, width: 0, height: 0}),
            get_frame_rect: () => ({x: 0, y: 0, width: 0, height: 0}),
        };
        const reading = readWindow(zeroWin);
        expect(reading).not.toBeNull();
        expect(reading.hasValidGeometry).toBeFalse();
        expect(reading.insets).toBeNull();
    });

    it('handles tearing-down window where properties throw "Object has been finalized"', () => {
        const finalizingWin = {
            get_buffer_rect: () => ({x: 0, y: 0, width: 600, height: 400}),
            get_frame_rect: () => ({x: 0, y: 0, width: 600, height: 400}),
            get decorated() {
                throw new Error('Object has been finalized');
            },
            get appears_focused() {
                throw new Error('Object has been finalized');
            },
            get maximized_horizontally() {
                throw new Error('Object has been finalized');
            },
            get maximized_vertically() {
                throw new Error('Object has been finalized');
            },
            is_fullscreen: () => {
                throw new Error('Object has been finalized');
            },
            get_window_type: () => {
                throw new Error('Object has been finalized');
            },
            get_tile_match: () => {
                throw new Error('Object has been finalized');
            },
            get_pid: () => {
                throw new Error('Object has been finalized');
            },
            get_transient_for: () => {
                throw new Error('Object has been finalized');
            },
            is_attached_dialog: () => {
                throw new Error('Object has been finalized');
            },
            allows_resize: () => {
                throw new Error('Object has been finalized');
            },
        };
        const reading = readWindow(finalizingWin);
        expect(reading).not.toBeNull();
        expect(reading.hasSsd).toBeFalse();
        expect(reading.appearsFocused).toBeFalse();
        expect(reading.isFullscreen).toBeFalse();
        expect(reading.isMaximized).toBeFalse();
        expect(reading.tiled).toBeFalse();
        expect(reading.windowType).toBe(WindowType.NORMAL);
        expect(reading.pid).toBe(-1);
    });

    it('reads nativeLikeCorners and hasGtk4Client from injected classifier', () => {
        const mockWin = {
            get_buffer_rect: () => ({x: 0, y: 0, width: 800, height: 600}),
            get_frame_rect: () => ({x: 0, y: 0, width: 800, height: 600}),
            get_pid: () => 9876,
        };
        const mockClassifier = {
            adwaitaLook: pid => pid === 9876,
            hasGtk4Client: pid => pid === 9876,
        };

        const reading = readWindow(mockWin, {classifier: mockClassifier});
        expect(reading).not.toBeNull();
        expect(reading.nativeLikeCorners).toBeTrue();
        expect(reading.hasGtk4Client).toBeTrue();
    });

    it('passes an unclassified process through as null, not as a default', () => {
        const mockWin = {
            get_buffer_rect: () => ({x: 0, y: 0, width: 800, height: 600}),
            get_frame_rect: () => ({x: 0, y: 0, width: 800, height: 600}),
            get_pid: () => 4242,
        };
        const reading = readWindow(mockWin, {
            classifier: {adwaitaLook: () => null, hasGtk4Client: () => null},
        });
        expect(reading.nativeLikeCorners).toBeNull();
        expect(reading.hasGtk4Client).toBeNull();
    });

    it('carries null while the read is in flight and a boolean once it lands', () => {
        const classifier = new ProcessClassifier();
        try {
            let finish;
            classifier.probeAdwaitaLook(7070, {readMaps: (pid, done) => { finish = done; }});
            const mockWin = {
                get_buffer_rect: () => ({x: 0, y: 0, width: 800, height: 600}),
                get_frame_rect: () => ({x: 0, y: 0, width: 800, height: 600}),
                get_pid: () => 7070,
            };

            const pending = readWindow(mockWin, {classifier});
            expect(pending.nativeLikeCorners).toBeNull();
            expect(pending.hasGtk4Client).toBeNull();

            finish('7f00000-7f01000 r-xp 00000000 00:00 0 /usr/lib/libadwaita-1.so.0\n');
            const landed = readWindow(mockWin, {classifier});
            expect(landed.nativeLikeCorners).toBeTrue();
            expect(landed.hasGtk4Client).toBeTrue();
        } finally {
            classifier.destroy();
        }
    });

    it('defers while the classification has not landed, and the decisions it separates differ', () => {
        const mockWin = {
            get_buffer_rect: () => ({x: 0, y: 0, width: 800, height: 600}),
            get_frame_rect: () => ({x: 0, y: 0, width: 800, height: 600}),
            get_pid: () => 6060,
            get_wm_class: () => 'defer-app',
            decorated: false,
        };
        const readingFor = answer => readWindow(mockWin, {
            classifier: {adwaitaLook: () => answer, hasGtk4Client: () => answer},
        });

        const pending = readingFor(null);
        const nativeLike = readingFor(true);
        const plain = readingFor(false);

        expect(isClassificationPending(pending)).toBeTrue();
        expect(isClassificationPending(nativeLike)).toBeFalse();
        expect(isClassificationPending(plain)).toBeFalse();

        // The manager returns on the pending reading instead of running this; the two landed answers
        // decide differently, so a null folded into either boolean would dress the window the answer
        // had not chosen.
        const nativeActions = evaluateWindowActions({...nativeLike, rules: {}});
        const plainActions = evaluateWindowActions({...plain, rules: {}});
        expect(nativeActions.drawClip).not.toBe(plainActions.drawClip);
    });

    it('handles throwing classifier methods gracefully during teardown', () => {
        const mockWin = {
            get_buffer_rect: () => ({x: 0, y: 0, width: 800, height: 600}),
            get_frame_rect: () => ({x: 0, y: 0, width: 800, height: 600}),
            get_pid: () => 1234,
        };
        const throwingClassifier = {
            adwaitaLook: () => {
                throw new Error('classifier torn down');
            },
            hasGtk4Client: () => {
                throw new Error('classifier torn down');
            },
        };

        const reading = readWindow(mockWin, {classifier: throwingClassifier});
        expect(reading).not.toBeNull();
        // A throw is the same "not known yet" as a read still in flight, and deferring is what the
        // answer landing a frame later would have done anyway.
        expect(reading.nativeLikeCorners).toBeNull();
        expect(reading.hasGtk4Client).toBeNull();
    });

    it('handles throwing identity resolvers while respecting wmClassOverride chaining', () => {
        const throwingIdentityWin = {
            get_buffer_rect: () => ({x: 0, y: 0, width: 500, height: 400}),
            get_frame_rect: () => ({x: 0, y: 0, width: 500, height: 400}),
            get_wm_class: () => {
                throw new Error('invalid UTF-8');
            },
            get_sandboxed_app_id: () => {
                throw new Error('dbus error');
            },
            get_gtk_application_id: () => {
                throw new Error('app gone');
            },
            get_pid: () => {
                throw new Error('pid inaccessible');
            },
        };

        const overrideReading = readWindow(throwingIdentityWin, {wmClassOverride: 'explicit_override'});
        expect(overrideReading).not.toBeNull();
        expect(overrideReading.wmClass).toBe('explicit_override');

        const fallbackReading = readWindow(throwingIdentityWin);
        expect(fallbackReading).not.toBeNull();
        expect(fallbackReading.wmClass).toBe('');
    });

    it('passes pid fallback -1 to classifier.hasGtk4Client when win.get_pid throws', () => {
        let receivedPid = null;
        const throwingPidWin = {
            get_buffer_rect: () => ({x: 0, y: 0, width: 800, height: 600}),
            get_frame_rect: () => ({x: 0, y: 0, width: 800, height: 600}),
            get_pid: () => {
                throw new Error('pid lookup failed');
            },
        };
        const mockClassifier = {
            hasGtk4Client: pid => {
                receivedPid = pid;
                return pid > 0;
            },
        };

        const reading = readWindow(throwingPidWin, {classifier: mockClassifier});
        expect(reading).not.toBeNull();
        expect(reading.pid).toBe(-1);
        expect(receivedPid).toBe(-1);
        expect(reading.hasGtk4Client).toBeFalse();
    });

    it('falls back to true when allows_resize throws', () => {
        const win = {
            get_buffer_rect: () => ({x: 0, y: 0, width: 800, height: 600}),
            get_frame_rect: () => ({x: 0, y: 0, width: 800, height: 600}),
            allows_resize: () => {
                throw new Error('finalized');
            },
        };
        const reading = readWindow(win);
        expect(reading).not.toBeNull();
        expect(reading.allowsResize).toBeTrue();
    });

    it('falls back to NORMAL when get_window_type throws', () => {
        const win = {
            get_buffer_rect: () => ({x: 0, y: 0, width: 800, height: 600}),
            get_frame_rect: () => ({x: 0, y: 0, width: 800, height: 600}),
            get_window_type: () => {
                throw new Error('finalized');
            },
        };
        const reading = readWindow(win);
        expect(reading).not.toBeNull();
        expect(reading.windowType).toBe(WindowType.NORMAL);
    });

    it('falls back to false for throwing tile, fullscreen, maximize, and ring getters', () => {
        const throwingFlagsWin = {
            get_buffer_rect: () => ({x: 0, y: 0, width: 800, height: 600}),
            get_frame_rect: () => ({x: 0, y: 0, width: 800, height: 600}),
            get_tile_match: () => {
                throw new Error('tile error');
            },
            is_fullscreen: () => {
                throw new Error('fullscreen error');
            },
            is_maximized: () => {
                throw new Error('is_maximized error');
            },
            get hasRing() {
                throw new Error('ring error');
            },
        };
        const reading = readWindow(throwingFlagsWin);
        expect(reading).not.toBeNull();
        expect(reading.hasTileMatch).toBeFalse();
        expect(reading.isFullscreen).toBeFalse();
        expect(reading.isMaximized).toBeFalse();
        expect(reading.tiled).toBeFalse();
        expect(reading.hasRing).toBeFalse();
    });

    it('falls back to false when get_maximized throws in isolation', () => {
        const throwingGetMaximizedWin = {
            get_buffer_rect: () => ({x: 0, y: 0, width: 800, height: 600}),
            get_frame_rect: () => ({x: 0, y: 0, width: 800, height: 600}),
            get_maximized: () => {
                throw new Error('get_maximized error');
            },
        };
        const reading = readWindow(throwingGetMaximizedWin);
        expect(reading).not.toBeNull();
        expect(reading.isMaximized).toBeFalse();
        expect(reading.tiled).toBeFalse();
    });
});

describe('readDeclaredIdentity', () => {
    it('picks the first non-blank declared identity', () => {
        const winWithAppId = {
            get_wm_class: () => '',
            get_sandboxed_app_id: () => '   ',
            get_gtk_application_id: () => 'org.gnome.Calculator',
        };
        expect(readDeclaredIdentity(winWithAppId)).toBe('org.gnome.Calculator');
    });

    it('returns empty string when all identity sources are whitespace or throw', () => {
        const invalidWin = {
            get_wm_class: () => {
                throw new Error('invalid utf-8');
            },
            get_sandboxed_app_id: () => '   ',
            get_gtk_application_id: () => null,
        };
        expect(readDeclaredIdentity(invalidWin)).toBe('');
    });
});

describe('getWindowFromActor', () => {
    it('resolves window from meta_window property', () => {
        const win = {};
        expect(getWindowFromActor({meta_window: win})).toBe(win);
    });

    it('resolves window from metaWindow property', () => {
        const win = {};
        expect(getWindowFromActor({metaWindow: win})).toBe(win);
    });

    it('resolves window from get_meta_window() method', () => {
        const win = {};
        expect(getWindowFromActor({get_meta_window: () => win})).toBe(win);
    });

    it('returns null on throwing actor', () => {
        const badActor = {
            get meta_window() {
                throw new Error('Actor deallocated');
            },
        };
        expect(getWindowFromActor(badActor)).toBeNull();
    });
});

describe('readWindowString', () => {
    it('returns string or fallback on throw', () => {
        expect(readWindowString(() => 'hello')).toBe('hello');
        expect(readWindowString(() => {
            throw new Error('utf8 error');
        })).toBe('');
    });
});

describe('safeRead', () => {
    it('returns evaluated value or fallback on throw or nullish', () => {
        expect(safeRead(() => 42, 0)).toBe(42);
        expect(safeRead(() => true, false)).toBeTrue();
        expect(safeRead(() => null, 'fallback')).toBe('fallback');
        expect(safeRead(() => undefined, 'fallback')).toBe('fallback');
        expect(safeRead(() => {
            throw new Error('finalized');
        }, false)).toBeFalse();
    });
});

describe('isWindowReading', () => {
    it('returns true for valid WindowReading objects', () => {
        expect(isWindowReading({
            clientTypeToken: 'wayland',
            frameRect: {x: 0, y: 0, width: 800, height: 600},
        })).toBeTrue();
    });

    it('returns false for raw Meta.Window or non-reading objects', () => {
        expect(isWindowReading(null)).toBeFalse();
        expect(isWindowReading(undefined)).toBeFalse();
        expect(isWindowReading({})).toBeFalse();
        expect(isWindowReading({get_frame_rect: () => ({})})).toBeFalse();
        expect(isWindowReading({clientTypeToken: 123})).toBeFalse();
    });
});

describe('the ring a pick records is the ring the runtime looks up', () => {
    // A window whose frame does not fit inside its buffer is where the two readings used to part: the
    // picker's key answered has_ring=false while the decision fell back to the two-sided totals and
    // read true, so the rule a pick wrote was stored under a key the runtime never asked for. The
    // end-to-end statement of the fix is that such a rule applies.
    const divergent = () => ({
        get_buffer_rect: () => ({x: 0, y: 0, width: 200, height: 500}),
        get_frame_rect: () => ({x: -10, y: 0, width: 180, height: 500}),
        get_pid: () => 4242,
        get_wm_class: () => 'demo',
        allows_resize: () => true,
        get_window_type: () => 0,
        get_client_type: () => 0,
    });

    it('applies a rule picked on the kind where the two readings used to differ', () => {
        const reading = readWindow(divergent());
        const key = buildRuleKeyFromProperties(extractWindowProperties(reading, 'demo'));
        expect(key).not.toBe('');

        const actions = evaluateWindowActions({...reading, focused: true, rules: {[key]: 'corners'}});

        expect(actions.reason).toContain('rule-applied');
    });
});
