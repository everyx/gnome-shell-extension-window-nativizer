/**
 * platform unit tests: verifying zero-side-effect platform library and ponyfills across GNOME 50–51 (jasmine-gjs).
 * Run: pnpm test
 */

import {CursorShape, setActorCursor, cursorTypeFor} from '../src/platform/actorCursor.js';
import {beginWindowGrabOp, getPointerSprite, getResizeGrabOp} from '../src/platform/grabOp.js';
import {resolveUniformLocation} from '../src/platform/uniformLocation.js';
import {coglContextForBake} from '../src/platform/coglContext.js';
import {
    isWindowMaximized,
    isWindowFullscreen,
    isWindowTiled,
    isWindowMinimized,
    isWindowDecorated,
    isWindowMaximizedHorizontally,
    isWindowMaximizedVertically,
    isWindowAppearsFocused,
    getWindowTileMatch,
    getWindowFrameRect,
    getWindowBufferRect,
    getWindowActor,
    getWindowClientType,
    getWindowType,
    getWindowPid,
    getWindowTransientFor,
    isWindowAttachedDialog,
    isWindowAllowsResize,
    isWindowHidden,
    isWindowOnAllWorkspaces,
    isWindowLocatedOnWorkspace,
    getWindowDisplayTitle,
    getWindowFromActor,
    findMetaWindow,
    getSurfaceContainer,
    getWindowSubpixelOffset
} from '../src/platform/window.js';
import {
    getDisplay,
    getFocusWindow,
    getWindowGroup,
    getMonitorManager,
    getMonitorCount,
    getMonitorScale,
    getMonitorGeometry,
    getPhysicalMonitorScale,
    resolveMonitorBounds,
    getTabList,
    focusWindow,
    setActorAboveSibling,
    setActorBelowSibling,
    getWindowActors,
    getActiveWorkspaceIndex,
    getActiveWorkspace,
    getStage,
    getStageDimensions
} from '../src/platform/display.js';

describe('platform', () => {
    describe('coglContextForBake', () => {
        it('takes the context from paintContext framebuffer', () => {
            const context = {};
            const paintContext = {get_framebuffer: () => ({get_context: () => context})};
            expect(coglContextForBake(paintContext)).toBe(context);
        });

        it('returns null when paintContext is null or invalid', () => {
            expect(coglContextForBake(null)).toBeNull();
            expect(coglContextForBake({})).toBeNull();
        });
    });

    describe('cursorTypeFor', () => {
        it('resolves a name against the enum this line has', () => {
            expect(cursorTypeFor(CursorShape.NORTH, {N_RESIZE: 10, DEFAULT: 0})).toBe(10);
            expect(cursorTypeFor(CursorShape.DEFAULT, {N_RESIZE: 10, DEFAULT: 0})).toBe(0);
        });

        it('answers null where the enum does not exist', () => {
            expect(cursorTypeFor(CursorShape.NORTH, null)).toBeNull();
            expect(cursorTypeFor(CursorShape.NORTH, {})).toBeNull();
        });

        it('refuses a shape it does not know, rather than leaving the pointer alone', () => {
            // A misspelt string used to resolve to nothing, which is the same outcome as a line that
            // has no enum at all - two different things, so they are told apart here.
            expect(() => cursorTypeFor('sideways', {N_RESIZE: 10})).toThrowError(/unknown cursor shape/);
        });

        it('answers null for a shape this line has no member for', () => {
            expect(cursorTypeFor(CursorShape.NORTH, {DEFAULT: 0})).toBeNull();
        });
    });

    describe('setActorCursor', () => {
        it('calls set_cursor_type when the actor and the enum are both there', () => {
            let receivedCursor = null;
            const actor = {
                set_cursor_type(cursor) {
                    receivedCursor = cursor;
                },
            };

            expect(setActorCursor(actor, CursorShape.DEFAULT, {DEFAULT: 0})).toBeTrue();
            expect(receivedCursor).toBe(0);
        });

        it('gracefully no-ops where the cursor API is absent', () => {
            const actor = {};
            expect(() => setActorCursor(actor, CursorShape.DEFAULT)).not.toThrow();
            expect(setActorCursor(actor, CursorShape.DEFAULT, null)).toBeFalse();
        });

        it('gracefully handles null or undefined actor', () => {
            expect(() => setActorCursor(null, CursorShape.DEFAULT)).not.toThrow();
            expect(() => setActorCursor(undefined, CursorShape.DEFAULT)).not.toThrow();
        });
    });

    describe('beginWindowGrabOp', () => {
        it('calls the 4-argument sprite signature on GNOME 50+', () => {
            const sprite = {isSprite: true};
            const posHint = {x: 100, y: 200};
            let callArgs = null;
            const mockWin = {
                begin_grab_op(op, spriteArg, time, pos) {
                    callArgs = [op, spriteArg, time, pos];
                    return true;
                },
            };

            expect(beginWindowGrabOp(mockWin, 10, sprite, 12345, posHint)).toBeTrue();
            expect(callArgs).toEqual([10, sprite, 12345, posHint]);
        });

        it('propagates a false return from the compositor', () => {
            const sprite = {isSprite: true};
            const mockWin = {
                begin_grab_op() {
                    return false;
                },
            };

            expect(beginWindowGrabOp(mockWin, 10, sprite, 0, null)).toBeFalse();
        });

        it('returns false when the sprite is missing', () => {
            let called = false;
            const mockWin = {
                begin_grab_op() {
                    called = true;
                },
            };

            expect(beginWindowGrabOp(mockWin, 10, null, 12345, {x: 0, y: 0})).toBeFalse();
            expect(called).toBeFalse();
        });

        it('returns false when the window has no begin_grab_op method', () => {
            const sprite = {isSprite: true};
            expect(beginWindowGrabOp(null, 10, sprite, 0, null)).toBeFalse();
            expect(beginWindowGrabOp({}, 10, sprite, 0, null)).toBeFalse();
        });

        it('returns false when the op is null or the dispatch throws', () => {
            const sprite = {isSprite: true};
            let called = false;
            const mockWin = {
                begin_grab_op() {
                    called = true;
                },
            };

            expect(beginWindowGrabOp(mockWin, null, sprite, 0, null)).toBeFalse();
            expect(beginWindowGrabOp(mockWin, undefined, sprite, 0, null)).toBeFalse();
            expect(called).toBeFalse();

            const throwingWin = {
                begin_grab_op() {
                    throw new Error('disposed');
                },
            };
            expect(beginWindowGrabOp(throwingWin, 10, sprite, 0, null)).toBeFalse();
        });
    });

    describe('getResizeGrabOp', () => {
        const mockMeta = {
            GrabOp: {
                RESIZING_N: 101,
                RESIZING_NE: 102,
                RESIZING_E: 103,
                RESIZING_SE: 104,
                RESIZING_S: 105,
                RESIZING_SW: 106,
                RESIZING_W: 107,
                RESIZING_NW: 108,
            },
        };

        it('maps directional edges to corresponding Meta.GrabOp constants', () => {
            expect(getResizeGrabOp('n', mockMeta)).toBe(101);
            expect(getResizeGrabOp('ne', mockMeta)).toBe(102);
            expect(getResizeGrabOp('e', mockMeta)).toBe(103);
            expect(getResizeGrabOp('se', mockMeta)).toBe(104);
            expect(getResizeGrabOp('s', mockMeta)).toBe(105);
            expect(getResizeGrabOp('sw', mockMeta)).toBe(106);
            expect(getResizeGrabOp('w', mockMeta)).toBe(107);
            expect(getResizeGrabOp('nw', mockMeta)).toBe(108);
        });

        it('returns null for unknown edge or missing meta namespace', () => {
            expect(getResizeGrabOp('invalid', mockMeta)).toBeNull();
            expect(getResizeGrabOp('n', null)).toBeNull();
            expect(getResizeGrabOp('n', {})).toBeNull();
        });
    });

    describe('getPointerSprite', () => {
        let originalGlobal;

        beforeEach(() => {
            originalGlobal = globalThis.global;
        });

        afterEach(() => {
            globalThis.global = originalGlobal;
        });

        it('extracts sprite from stage backend get_sprite', () => {
            const expectedSprite = {id: 'event-sprite'};
            const mockEvent = {};
            let passedStage = null;
            let passedEvent = null;
            const mockStage = {
                get_context() {
                    return {
                        get_backend() {
                            return {
                                get_sprite(stage, event) {
                                    passedStage = stage;
                                    passedEvent = event;
                                    return event === mockEvent ? expectedSprite : null;
                                },
                            };
                        },
                    };
                },
            };
            globalThis.global = {
                stage: mockStage,
            };

            expect(getPointerSprite(mockEvent)).toBe(expectedSprite);
            expect(passedStage).toBe(mockStage);
            expect(passedEvent).toBe(mockEvent);
        });

        it('falls back to get_pointer_sprite when get_sprite is unavailable', () => {
            const fallbackSprite = {id: 'pointer-sprite'};
            let passedStage = null;
            const mockStage = {
                get_context() {
                    return {
                        get_backend() {
                            return {
                                get_pointer_sprite(stage) {
                                    passedStage = stage;
                                    return fallbackSprite;
                                },
                            };
                        },
                    };
                },
            };
            globalThis.global = {
                stage: mockStage,
            };

            expect(getPointerSprite({})).toBe(fallbackSprite);
            expect(passedStage).toBe(mockStage);
        });

        it('returns null when no sprite can be resolved', () => {
            globalThis.global = {};
            expect(getPointerSprite(null)).toBeNull();
        });
    });

    describe('resolveUniformLocation', () => {
        it('does not cache a miss and re-queries until the pipeline resolves it', () => {
            const cache = new Map();
            let ready = false;
            const getLocation = name => {
                expect(name).toBe('uRadius');
                return ready ? 7 : -1;
            };

            expect(resolveUniformLocation(cache, 'uRadius', getLocation)).toBe(-1);
            expect(cache.has('uRadius')).toBeFalse();

            ready = true;
            expect(resolveUniformLocation(cache, 'uRadius', getLocation)).toBe(7);
            expect(cache.get('uRadius')).toBe(7);
        });

        it('reuses a cached hit without querying again', () => {
            const cache = new Map([['uScale', 3]]);
            let calls = 0;
            const loc = resolveUniformLocation(cache, 'uScale', () => {
                calls++;
                return 9;
            });

            expect(loc).toBe(3);
            expect(calls).toBe(0);
        });

        it('re-queries and repairs a cache that somehow holds a poisoned negative', () => {
            const cache = new Map([['uRadius', -1]]);
            const loc = resolveUniformLocation(cache, 'uRadius', () => 5);
            expect(loc).toBe(5);
            expect(cache.get('uRadius')).toBe(5);
        });
    });

    describe('window helpers', () => {
        it('checks isWindowMaximized correctly', () => {
            expect(isWindowMaximized(null)).toBeFalse();
            expect(isWindowMaximized({})).toBeFalse();
            expect(isWindowMaximized({is_maximized: () => true})).toBeTrue();
            expect(isWindowMaximized({is_maximized: () => false})).toBeFalse();
            expect(isWindowMaximized({
                is_maximized: () => {
                    throw new Error('C object disposed');
                },
            })).toBeFalse();
        });

        it('checks isWindowFullscreen correctly', () => {
            expect(isWindowFullscreen(null)).toBeFalse();
            expect(isWindowFullscreen({})).toBeFalse();
            expect(isWindowFullscreen({is_fullscreen: () => true})).toBeTrue();
            expect(isWindowFullscreen({
                is_fullscreen: () => {
                    throw new Error('C object disposed');
                },
            })).toBeFalse();
        });

        it('checks isWindowMinimized correctly', () => {
            expect(isWindowMinimized(null)).toBeFalse();
            expect(isWindowMinimized({})).toBeFalse();
            expect(isWindowMinimized({minimized: true})).toBeTrue();
            expect(isWindowMinimized({minimized: false})).toBeFalse();
            expect(isWindowMinimized({
                get minimized() {
                    throw new Error('C object disposed');
                },
            })).toBeFalse();
        });

        it('checks isWindowTiled correctly', () => {
            expect(isWindowTiled(null)).toBeFalse();
            expect(isWindowTiled({})).toBeFalse();
            // Fully maximized is not tiled
            expect(isWindowTiled({
                is_maximized: () => true,
                maximized_horizontally: true,
                maximized_vertically: true,
            })).toBeFalse();
            // One-axis maximized is tiled
            expect(isWindowTiled({
                is_maximized: () => false,
                maximized_horizontally: true,
                maximized_vertically: false,
            })).toBeTrue();
            // Tile match is tiled
            expect(isWindowTiled({
                is_maximized: () => false,
                maximized_horizontally: false,
                maximized_vertically: false,
                get_tile_match: () => ({}),
            })).toBeTrue();
            // Absorbs C-boundary exceptions
            expect(isWindowTiled({
                is_maximized: () => {
                    throw new Error('C object disposed');
                },
            })).toBeFalse();
        });

        it('checks isWindowDecorated, isWindowMaximizedHorizontally, isWindowMaximizedVertically, isWindowAppearsFocused, and getWindowTileMatch safely', () => {
            expect(isWindowDecorated(null)).toBeFalse();
            expect(isWindowDecorated({})).toBeFalse();
            expect(isWindowDecorated({decorated: true})).toBeTrue();
            expect(isWindowDecorated({
                get decorated() {
                    throw new Error('disposed');
                },
            })).toBeFalse();

            expect(isWindowMaximizedHorizontally(null)).toBeFalse();
            expect(isWindowMaximizedHorizontally({})).toBeFalse();
            expect(isWindowMaximizedHorizontally({maximized_horizontally: true})).toBeTrue();
            expect(isWindowMaximizedHorizontally({
                get maximized_horizontally() {
                    throw new Error('disposed');
                },
            })).toBeFalse();

            expect(isWindowMaximizedVertically(null)).toBeFalse();
            expect(isWindowMaximizedVertically({})).toBeFalse();
            expect(isWindowMaximizedVertically({maximized_vertically: true})).toBeTrue();
            expect(isWindowMaximizedVertically({
                get maximized_vertically() {
                    throw new Error('disposed');
                },
            })).toBeFalse();

            expect(isWindowAppearsFocused(null)).toBeFalse();
            expect(isWindowAppearsFocused({})).toBeFalse();
            expect(isWindowAppearsFocused({appears_focused: true})).toBeTrue();
            expect(isWindowAppearsFocused({
                get appears_focused() {
                    throw new Error('disposed');
                },
            })).toBeFalse();

            const matchWin = {id: 'tile-match'};
            expect(getWindowTileMatch(null)).toBeNull();
            expect(getWindowTileMatch({})).toBeNull();
            expect(getWindowTileMatch({get_tile_match: () => matchWin})).toBe(matchWin);
            expect(getWindowTileMatch({
                get_tile_match: () => {
                    throw new Error('disposed');
                },
            })).toBeNull();
        });

        it('extracts geometry rects cleanly with throwOnError control', () => {
            const rect = {x: 10, y: 20, width: 300, height: 400};
            const mockWin = {
                get_frame_rect: () => rect,
                get_buffer_rect: () => rect,
            };
            expect(getWindowFrameRect(mockWin)).toBe(rect);
            expect(getWindowBufferRect(mockWin)).toBe(rect);
            expect(getWindowFrameRect(null)).toBeNull();
            expect(getWindowBufferRect(null)).toBeNull();

            const throwingWin = {
                get_frame_rect: () => {
                    throw new Error('Frame teardown');
                },
                get_buffer_rect: () => {
                    throw new Error('Buffer teardown');
                },
            };
            // Default: quiet null
            expect(getWindowFrameRect(throwingWin)).toBeNull();
            expect(getWindowBufferRect(throwingWin)).toBeNull();
            // Explicit throwOnError: true
            expect(() => getWindowFrameRect(throwingWin, {throwOnError: true})).toThrowError(/Frame teardown/);
            expect(() => getWindowBufferRect(throwingWin, {throwOnError: true})).toThrowError(/Buffer teardown/);
        });

        it('resolves window actor and finds enclosing MetaWindow', () => {
            const actor = {actorId: 'test-actor'};
            expect(getWindowActor(null)).toBeNull();
            expect(getWindowActor({get_compositor_private: () => actor})).toBe(actor);
            expect(getWindowActor({
                get_compositor_private: () => {
                    throw new Error('Deallocated');
                },
            })).toBeNull();

            const mockWin = {id: 'win1', get_monitor: () => 0};
            expect(getWindowFromActor(null)).toBeNull();
            expect(getWindowFromActor({meta_window: mockWin})).toBe(mockWin);
            expect(getWindowFromActor({metaWindow: mockWin})).toBe(mockWin);
            expect(getWindowFromActor({get_meta_window: () => mockWin})).toBe(mockWin);

            // Directly a MetaWindow
            expect(findMetaWindow(mockWin)).toBe(mockWin);
            // From a child surface actor walking up
            const rootActor = {meta_window: mockWin};
            const childActor = {
                get_parent: () => rootActor,
            };
            expect(findMetaWindow(childActor)).toBe(mockWin);
            expect(findMetaWindow(null)).toBeNull();
        });

        it('safely extracts metadata and state flags', () => {
            const mockWin = {
                get_client_type: () => 1,
                get_window_type: () => 0,
                get_pid: () => 4321,
                get_transient_for: () => ({isParent: true}),
                is_attached_dialog: () => true,
                allows_resize: () => false,
                is_hidden: () => true,
                is_on_all_workspaces: () => true,
                located_on_workspace: ws => ws?.id === 1,
                get_title: () => 'Test Window',
            };

            expect(getWindowClientType(mockWin)).toBe(1);
            expect(getWindowType(mockWin)).toBe(0);
            expect(getWindowPid(mockWin)).toBe(4321);
            expect(getWindowTransientFor(mockWin)).toEqual({isParent: true});
            expect(isWindowAttachedDialog(mockWin)).toBeTrue();
            expect(isWindowAllowsResize(mockWin)).toBeFalse();
            expect(isWindowHidden(mockWin)).toBeTrue();
            expect(isWindowOnAllWorkspaces(mockWin)).toBeTrue();
            expect(isWindowLocatedOnWorkspace(mockWin, {id: 1})).toBeTrue();
            expect(isWindowLocatedOnWorkspace(mockWin, {id: 2})).toBeFalse();
            expect(getWindowDisplayTitle(mockWin)).toBe('Test Window');
        });

        it('falls back safely when window is null, empty object, or methods throw', () => {
            // Null case
            expect(getWindowClientType(null)).toBeNull();
            expect(getWindowType(null)).toBe(0);
            expect(getWindowPid(null)).toBe(-1);
            expect(getWindowTransientFor(null)).toBeNull();
            expect(isWindowAttachedDialog(null)).toBeFalse();
            expect(isWindowAllowsResize(null)).toBeTrue();
            expect(isWindowHidden(null)).toBeFalse();
            expect(isWindowOnAllWorkspaces(null)).toBeFalse();
            expect(isWindowLocatedOnWorkspace(null, null)).toBeFalse();
            expect(getWindowDisplayTitle(null)).toBe('');

            // Empty object case (methods missing)
            expect(getWindowClientType({})).toBeNull();
            expect(getWindowType({})).toBe(0);
            expect(getWindowPid({})).toBe(-1);
            expect(getWindowTransientFor({})).toBeNull();
            expect(isWindowAttachedDialog({})).toBeFalse();
            expect(isWindowAllowsResize({})).toBeTrue();
            expect(isWindowHidden({})).toBeFalse();
            expect(isWindowOnAllWorkspaces({})).toBeFalse();
            expect(isWindowLocatedOnWorkspace({}, {})).toBeFalse();
            expect(getWindowDisplayTitle({})).toBe('');

            // Throwing methods case (C object deallocated)
            const throwingWin = {
                get_client_type: () => {
                    throw new Error('Deallocated');
                },
                get_window_type: () => {
                    throw new Error('Deallocated');
                },
                get_pid: () => {
                    throw new Error('Deallocated');
                },
                get_transient_for: () => {
                    throw new Error('Deallocated');
                },
                is_attached_dialog: () => {
                    throw new Error('Deallocated');
                },
                allows_resize: () => {
                    throw new Error('Deallocated');
                },
                is_hidden: () => {
                    throw new Error('Deallocated');
                },
                is_on_all_workspaces: () => {
                    throw new Error('Deallocated');
                },
                located_on_workspace: () => {
                    throw new Error('Deallocated');
                },
                get_title: () => {
                    throw new Error('Deallocated');
                },
            };
            expect(getWindowClientType(throwingWin)).toBeNull();
            expect(getWindowType(throwingWin)).toBe(0);
            expect(getWindowPid(throwingWin)).toBe(-1);
            expect(getWindowTransientFor(throwingWin)).toBeNull();
            expect(isWindowAttachedDialog(throwingWin)).toBeFalse();
            expect(isWindowAllowsResize(throwingWin)).toBeTrue();
            expect(isWindowHidden(throwingWin)).toBeFalse();
            expect(isWindowOnAllWorkspaces(throwingWin)).toBeFalse();
            expect(isWindowLocatedOnWorkspace(throwingWin, {})).toBeFalse();
            expect(getWindowDisplayTitle(throwingWin)).toBe('');
        });

        it('preserves an explicit boolean allows_resize property', () => {
            expect(isWindowAllowsResize({allows_resize: true})).toBeTrue();
            expect(isWindowAllowsResize({allows_resize: false})).toBeFalse();
        });
    });

    describe('display helpers', () => {
        let originalGlobal;

        beforeEach(() => {
            originalGlobal = globalThis.global;
        });

        afterEach(() => {
            globalThis.global = originalGlobal;
        });

        it('resolves display and window group with custom overrides or global', () => {
            const customDisplay = {name: 'custom-display'};
            const customGroup = {name: 'custom-group'};
            expect(getDisplay(customDisplay)).toBe(customDisplay);
            expect(getWindowGroup(customGroup)).toBe(customGroup);

            globalThis.global = {
                display: {name: 'global-display'},
                window_group: {name: 'global-group'},
            };
            expect(getDisplay()).toEqual({name: 'global-display'});
            expect(getWindowGroup()).toEqual({name: 'global-group'});
        });

        it('resolves focused window safely', () => {
            const focusedWin = {id: 'win1'};
            expect(getFocusWindow(null)).toBeNull();
            expect(getFocusWindow({focus_window: focusedWin})).toBe(focusedWin);

            globalThis.global = {
                display: {focus_window: focusedWin},
            };
            expect(getFocusWindow()).toBe(focusedWin);

            const throwingDisplay = {
                get focus_window() {
                    throw new Error('Display teardown');
                },
            };
            expect(getFocusWindow(throwingDisplay)).toBeNull();
        });

        it('resolves monitor manager from display or backend safely', () => {
            const mm = {id: 'mm'};
            globalThis.global = {
                display: {get_monitor_manager: () => mm},
            };
            expect(getMonitorManager()).toBe(mm);

            globalThis.global = {
                display: {},
                backend: {get_monitor_manager: () => mm},
            };
            expect(getMonitorManager()).toBe(mm);

            globalThis.global = {
                backend: {
                    get_monitor_manager: () => {
                        throw new Error('Backend teardown');
                    },
                },
            };
            expect(getMonitorManager()).toBeNull();
        });

        it('queries monitor count, scale and geometry with bounds checking', () => {
            const geom = {x: 0, y: 0, width: 1920, height: 1080};
            globalThis.global = {
                display: {
                    get_n_monitors: () => 2,
                    get_monitor_scale: idx => (idx === 0 ? 1 : 2),
                    get_monitor_geometry: idx => (idx === 0 ? geom : null),
                },
            };

            expect(getMonitorCount()).toBe(2);
            expect(getMonitorScale(0)).toBe(1);
            expect(getMonitorScale(1)).toBe(2);
            expect(getMonitorGeometry(0)).toBe(geom);

            // Out-of-bounds guards: strictly prevent calls to C macros with invalid indices
            expect(getMonitorScale(-1)).toBe(1.0);
            expect(getMonitorScale(2)).toBe(1.0);
            expect(getMonitorScale(10)).toBe(1.0);
            expect(getMonitorGeometry(-1)).toBeNull();
            expect(getMonitorGeometry(2)).toBeNull();
        });

        it('resolves monitor bounds and physical scales', () => {
            const mockDisplay = {
                get_n_monitors: () => 1,
                get_monitor_geometry: () => ({x: 10, y: 20, width: 100, height: 200}),
                get_monitor_scale: () => 1.5,
            };
            const mockWin = {
                get_monitor: () => 0,
            };
            const bounds = resolveMonitorBounds(mockDisplay, mockWin);
            expect(bounds).toEqual({x: 10, y: 20, width: 100, height: 200});

            globalThis.global = {
                display: mockDisplay,
            };
            expect(getPhysicalMonitorScale(mockWin)).toBe(1.5);
            // Out of bounds window monitor index
            expect(resolveMonitorBounds(mockDisplay, {get_monitor: () => 5})).toBeNull();
        });

        it('handles window focusing and actor layering with null guards', () => {
            let focused = null;
            const mockDisplay = {
                focus_window: (win, ts) => {
                    focused = {win, ts};
                },
            };
            focusWindow({id: 'win1'}, 123, mockDisplay);
            expect(focused).toEqual({win: {id: 'win1'}, ts: 123});

            let raised = null;
            let above = null;
            let lowered = null;
            let below = null;
            const mockGroup = {
                set_child_above_sibling: (c, s) => {
                    raised = c;
                    above = s;
                },
                set_child_below_sibling: (c, s) => {
                    lowered = c;
                    below = s;
                },
            };
            setActorAboveSibling({id: 'child'}, {id: 'sibling'}, mockGroup);
            expect(raised).toEqual({id: 'child'});
            expect(above).toEqual({id: 'sibling'});

            setActorBelowSibling({id: 'child2'}, {id: 'sibling2'}, mockGroup);
            expect(lowered).toEqual({id: 'child2'});
            expect(below).toEqual({id: 'sibling2'});

            // Null child/sibling guards: must no-op without calling container methods
            let called = false;
            const guardedGroup = {
                set_child_above_sibling: () => {
                    called = true;
                },
                set_child_below_sibling: () => {
                    called = true;
                },
            };
            setActorAboveSibling(null, {id: 'sibling'}, guardedGroup);
            setActorAboveSibling({id: 'child'}, null, guardedGroup);
            setActorBelowSibling(null, {id: 'sibling'}, guardedGroup);
            setActorBelowSibling({id: 'child'}, null, guardedGroup);
            expect(called).toBeFalse();
        });

        it('queries tab list via display with default type', () => {
            const tabs = [{id: 'w1'}, {id: 'w2'}];
            let requestedType = null;
            globalThis.global = {
                display: {
                    get_tab_list: type => {
                        requestedType = type;
                        return tabs;
                    },
                },
            };
            expect(getTabList()).toBe(tabs);
            expect(requestedType).toBe(3); // Meta.TabList.NORMAL_ALL
        });

        it('lists window actors and active workspace', () => {
            const actors = [{id: 'act1'}, {id: 'act2'}];
            const ws = {id: 'ws0'};
            globalThis.global = {
                get_window_actors: () => actors,
                workspace_manager: {
                    get_active_workspace: () => ws,
                    get_active_workspace_index: () => 0,
                },
            };

            expect(getWindowActors()).toBe(actors);
            expect(getActiveWorkspace()).toBe(ws);
            expect(getActiveWorkspaceIndex()).toBe(0);
        });

        it('queries stage and stage dimensions safely', () => {
            const mockStage = {
                width: 1920,
                height: 1080,
            };
            globalThis.global = {stage: mockStage};
            expect(getStage()).toBe(mockStage);
            expect(getStageDimensions()).toEqual({width: 1920, height: 1080});

            globalThis.global = {
                stage: {
                    get width() {
                        throw new Error('Stage deallocated');
                    },
                },
            };
            expect(getStageDimensions()).toEqual({width: 0, height: 0});
        });
    });

    describe('getSurfaceContainer', () => {
        const St = {Widget: class {}};

        it('returns the only non-foreign child', () => {
            const container = {x: 3, y: -2, width: 800, height: 600};
            expect(getSurfaceContainer({get_children: () => [container]}, St)).toBe(container);
        });

        it('excludes an injected foreign St.Widget', () => {
            const foreign = new St.Widget();
            const container = {x: 0, y: 0, width: 800, height: 600};
            expect(getSurfaceContainer({get_children: () => [foreign, container]}, St)).toBe(container);
        });

        it('answers null when the tree is ambiguous, so the caller keeps a zero container offset', () => {
            const background = {x: 0, y: 0, width: 800, height: 600};
            const container = {x: 3, y: 0, width: 800, height: 600};
            expect(getSurfaceContainer({get_children: () => [background, container]}, St)).toBeNull();
        });
    });

    describe('getWindowSubpixelOffset', () => {
        let originalGlobal;

        beforeEach(() => {
            originalGlobal = globalThis.global;
        });

        afterEach(() => {
            globalThis.global = originalGlobal;
        });

        // The phase belongs to the window's compositor actor, so every fake window points at the
        // one it owns: a caller can no longer hand in a different actor and derive a different edge.
        // The frame defaults to the full monitor so the arithmetic specs exercise the monitor scan;
        // only a spec that supplies a frame tests the degenerate/unreadable case.
        const waylandWin = (actor, monitorIndex = 0, frame = null) => ({
            get_client_type: () => 0, // WAYLAND
            get_monitor: () => monitorIndex,
            get_compositor_private: () => actor,
            get_frame_rect: () => frame ?? {x: 0, y: 0, width: 1920, height: 1080},
        });

        const displayFor = monitors => ({
            display: {
                get_n_monitors: () => monitors.length,
                get_monitor_scale: index => monitors[index].scale,
                get_monitor_geometry: index => monitors[index].geometry,
            },
        });

        const monitor = scale => displayFor([
            {scale, geometry: {x: 0, y: 0, width: 1920, height: 1080}},
        ]);

        // Two monitors side by side: a 1.0 monitor on the left, a fractional-scale one on the
        // right. Exercises both the highest-scale pick and the round rule at the shared edge.
        const mixedScaleDisplay = scale => displayFor([
            {scale: 1.0, geometry: {x: 0, y: 0, width: 1920, height: 1080}},
            {scale, geometry: {x: 1920, y: 0, width: 1920, height: 1080}},
        ]);

        it('returns zero offset on a null window', () => {
            expect(getWindowSubpixelOffset(null)).toEqual({x: 0, y: 0});
            expect(getWindowSubpixelOffset(undefined)).toEqual({x: 0, y: 0});
        });

        it('returns zero offset for non-Wayland windows', () => {
            const x11Win = {
                get_client_type: () => 1, // X11
                get_monitor: () => 0,
                get_compositor_private: () => ({x: 242, y: 200}),
            };
            expect(getWindowSubpixelOffset(x11Win)).toEqual({x: 0, y: 0});
        });

        it('returns zero offset when the window has no compositor actor', () => {
            expect(getWindowSubpixelOffset(waylandWin(null))).toEqual({x: 0, y: 0});
        });

        it('returns zero offset on invalid monitor index', () => {
            expect(getWindowSubpixelOffset(waylandWin({x: 242, y: 200}, -1))).toEqual({x: 0, y: 0});
        });

        // The fallback to win.get_monitor() is gone, so a frame the scan cannot read resolves to
        // -1, and a valid frame whose scan finds no monitor does the same. Both must stay {0,0} and
        // must not reach for the window's own monitor index.
        it('returns zero offset for a degenerate frame, without the monitor fallback', () => {
            globalThis.global = monitor(4 / 3);
            let monitorAsked = false;
            const win = {
                get_client_type: () => 0, // WAYLAND
                get_monitor: () => { monitorAsked = true; return 0; },
                get_compositor_private: () => ({x: 242, y: 200}),
                get_frame_rect: () => ({x: 0, y: 0, width: 0, height: 0}),
            };
            expect(getWindowSubpixelOffset(win)).toEqual({x: 0, y: 0});
            expect(monitorAsked).toBeFalse();
        });

        it('returns zero offset when the frame rect is unreadable, without the monitor fallback', () => {
            globalThis.global = monitor(4 / 3);
            let monitorAsked = false;
            const win = {
                get_client_type: () => 0, // WAYLAND
                get_monitor: () => { monitorAsked = true; return 0; },
                get_compositor_private: () => ({x: 242, y: 200}),
                get_frame_rect: () => { throw new Error('window destroyed'); },
            };
            expect(getWindowSubpixelOffset(win)).toEqual({x: 0, y: 0});
            expect(monitorAsked).toBeFalse();
        });

        it('returns zero offset on integer scale factors', () => {
            const actor = {x: 242, y: 200};
            const win = waylandWin(actor);
            globalThis.global = monitor(1.0);
            expect(getWindowSubpixelOffset(win)).toEqual({x: 0, y: 0});

            globalThis.global = monitor(2.0);
            expect(getWindowSubpixelOffset(win)).toEqual({x: 0, y: 0});
        });

        it('calculates subpixel grid offset correctly across 4 phases under 1.33x scale', () => {
            const actor = {x: 240, y: 200};
            const win = waylandWin(actor);
            globalThis.global = monitor(4 / 3); // 1.3333333333333333

            // Phase x=240: 240 * 4/3 = 320.0 -> offset = 0
            expect(Math.abs(getWindowSubpixelOffset(win).x)).toBeLessThan(0.001);

            // Phase x=241: 241 * 4/3 = 321.333 -> round = 321 -> adj = 240.75 -> offset = -0.25
            actor.x = 241;
            expect(Math.abs(getWindowSubpixelOffset(win).x - (-0.25))).toBeLessThan(0.001);

            // Phase x=242: 242 * 4/3 = 322.667 -> round = 323 -> adj = 242.25 -> offset = +0.25
            actor.x = 242;
            expect(Math.abs(getWindowSubpixelOffset(win).x - 0.25)).toBeLessThan(0.001);

            // Phase x=243: 243 * 4/3 = 324.0 -> offset = 0
            actor.x = 243;
            expect(Math.abs(getWindowSubpixelOffset(win).x)).toBeLessThan(0.001);
        });

        it('ignores actor translation, matching the layout-coordinate phase in Mutter', () => {
            const scale = 4 / 3;
            globalThis.global = monitor(scale);
            const plain = getWindowSubpixelOffset(waylandWin({x: 240, y: 200}));
            const translated = getWindowSubpixelOffset(
                waylandWin({x: 240, y: 200, translation_x: 2, translation_y: 2}));

            // Mutter applies the translation outside this term, so an animation moving the actor
            // must not move the phase we cut on. x=240 -> 320.0 -> 0; y=200 -> 266.667 -> +0.25.
            expect(translated).toEqual(plain);
            expect(plain.x).toBeCloseTo(0, 6);
            expect(plain.y).toBeCloseTo(0.25, 6);
        });

        it('equals Mutter arithmetic over the window actor plus the surface container', () => {
            const scale = 4 / 3;
            globalThis.global = monitor(scale);
            const container = {x: 3, y: -2, width: 800, height: 600};
            const actor = {x: 238, y: 202, get_children: () => [container]};
            const win = waylandWin(actor);

            // abs = layout(windowActor) + layout(surfaceContainer); no translation term.
            const rel = {x: actor.x + container.x, y: actor.y + container.y};
            const expected = {
                x: Math.round(rel.x * scale) / scale - rel.x,
                y: Math.round(rel.y * scale) / scale - rel.y,
            };
            expect(getWindowSubpixelOffset(win)).toEqual(expected);
            // 241 * 4/3 = 321.333 -> -0.25; 200 * 4/3 = 266.667 -> +0.25. Both axes exercised.
            expect(expected.x).toBeCloseTo(-0.25, 6);
            expect(expected.y).toBeCloseTo(0.25, 6);
        });

        it('moves the phase when the surface container offset moves', () => {
            const scale = 4 / 3;
            globalThis.global = monitor(scale);
            const at = containerX => getWindowSubpixelOffset(waylandWin({
                x: 238, y: 200, get_children: () => [{x: containerX, y: 0}],
            }));
            // window 238 + container 3 = 241 -> -0.25; 238 + 4 = 242 -> +0.25. The container is
            // part of the layout sum, so its offset changes the phase.
            expect(at(3).x).toBeCloseTo(-0.25, 6);
            expect(at(4).x).toBeCloseTo(0.25, 6);
        });

        it('picks the highest-scale monitor intersecting the frame, not the main monitor', () => {
            globalThis.global = mixedScaleDisplay(1.5);
            // The frame straddles both monitors; get_monitor() reports main monitor 0, whose
            // scale is 1.0 and whose phase is zero. The highest-scale intersecting one is 1.
            const actor = {x: 1921, y: 0};
            const win = waylandWin(actor, 0, {x: 1900, y: 0, width: 200, height: 100});

            // rel = 1921 - 1920 = 1; 1 * 1.5 = 1.5 -> round 2 -> 2/1.5 - 1 = 1/3.
            expect(getWindowSubpixelOffset(win).x).toBeCloseTo(1 / 3, 6);
        });

        it('rounds negative halves away from zero, matching roundf rather than Math.round', () => {
            globalThis.global = mixedScaleDisplay(1.25);
            // A window straddling the shared edge: the frame intersects both monitors, so the
            // higher-scale (right) monitor wins. The actor at x=1910 puts relX at 1910 - 1920
            // = -10, and -10 * 1.25 = -12.5 is an exact half. roundf snaps to -13, so the offset
            // is -13/1.25 - (-10) = -0.4; Math.round would snap to -12 and return +0.4.
            const straddle = {x: 1900, y: -10, width: 200, height: 100};
            const negative = waylandWin({x: 1910, y: -2}, 0, straddle);
            expect(getWindowSubpixelOffset(negative).x).toBeCloseTo(-0.4, 6);
            expect(getWindowSubpixelOffset(negative).y).toBeCloseTo(-0.4, 6);
            expect(getWindowSubpixelOffset(negative).x).not.toBeCloseTo(0.4, 6);

            // The positive mirror is unchanged: relX = +10 -> +12.5 -> roundf 13 -> +0.4, the
            // same value Math.round produces, so positive coordinates keep their output.
            const positive = waylandWin(
                {x: 1930, y: 2}, 0, {x: 1925, y: -10, width: 200, height: 100});
            expect(getWindowSubpixelOffset(positive).x).toBeCloseTo(0.4, 6);
            expect(getWindowSubpixelOffset(positive).y).toBeCloseTo(0.4, 6);
        });

        it('agrees with Math.round on the 4/3 path, where no product lands on a half', () => {
            const scale = 4 / 3;
            globalThis.global = monitor(scale);
            // relX = -1 -> -4/3 = -1.333...; roundf and Math.round both snap to -1, so the
            // helper leaves the verified 4/3 path untouched.
            const win = waylandWin({x: -1, y: 0});
            const mathRoundOffset = Math.round(-1 * scale) / scale - (-1);
            expect(getWindowSubpixelOffset(win).x).toBeCloseTo(mathRoundOffset, 6);
            expect(getWindowSubpixelOffset(win).x).toBeCloseTo(0.25, 6);
        });

        it('defends against exceptions and returns zero offset', () => {
            const throwingWin = {
                get_client_type: () => {
                    throw new Error('Compositor window destroyed');
                },
            };
            expect(getWindowSubpixelOffset(throwingWin)).toEqual({x: 0, y: 0});
        });
    });
});

