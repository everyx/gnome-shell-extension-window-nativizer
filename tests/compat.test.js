/**
 * compat unit tests: verifying zero-side-effect ponyfills across GNOME 45–51 (jasmine-gjs).
 * Run: pnpm test
 */

import {CursorShape, setActorCursor, cursorTypeFor} from '../src/compat/actorCursor.js';
import {beginWindowGrabOp, getPointerSprite} from '../src/compat/grabOp.js';
import {resolveUniformLocation} from '../src/compat/uniformLocation.js';

describe('compat', () => {
    describe('cursorTypeFor', () => {
        it('resolves a name against the enum this line has', () => {
            expect(cursorTypeFor(CursorShape.NORTH, {N_RESIZE: 10, DEFAULT: 0})).toBe(10);
            expect(cursorTypeFor(CursorShape.DEFAULT, {N_RESIZE: 10, DEFAULT: 0})).toBe(0);
        });

        it('answers null where the enum does not exist (Clutter < 50)', () => {
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

        it('gracefully no-ops where the cursor API does not exist (Clutter < 50)', () => {
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
        let originalGlobal;

        // The dispatch reads two things only the shell can answer: whether the backend can produce
        // a pointer sprite (49+), and, when it cannot, the pointer device (45-48). Both live on the
        // same backend, and both are stubbed per case, which is what lets one machine cover all
        // three signatures. Nothing is put on globalThis.Clutter: the shell never defines such a
        // global, so a test that stubs one passes even when the code reads a name that is not there.
        function useShell({spriteApi}) {
            const device = {id: 'pointer-device'};
            const backend = {
                get_default_seat: () => ({get_pointer: () => device}),
                ...(spriteApi ? {get_sprite: () => null, get_pointer_sprite: () => null} : {}),
            };
            globalThis.global = {
                display: {},
                stage: {get_context: () => ({get_backend: () => backend})},
                backend,
            };
            return device;
        }

        beforeEach(() => {
            originalGlobal = globalThis.global;
        });

        afterEach(() => {
            globalThis.global = originalGlobal;
        });

        it('calls the 4-argument sprite signature on GNOME 49–51', () => {
            useShell({spriteApi: true});
            const sprite = {isSprite: true};
            const posHint = {x: 100, y: 200};
            let callArgs = null;
            const mockWin = {
                begin_grab_op(op, spriteArg, time, pos) {
                    callArgs = [op, spriteArg, time, pos];
                },
            };

            expect(beginWindowGrabOp(mockWin, 10, sprite, 12345, posHint)).toBeTrue();
            expect(callArgs).toEqual([10, sprite, 12345, posHint]);
        });

        it('calls the 4-argument device signature on GNOME 45', () => {
            // 45 and 49-51 both declare four parameters, so arity cannot tell them apart. What
            // separates them is that 45 has no get_sprite to hand the grab: it takes a device and
            // a sequence instead, and pos_hint did not arrive until 46.
            const device = useShell({spriteApi: false});
            let callArgs = null;
            const mockWin = {
                begin_grab_op(op, dev, seq, time) {
                    callArgs = [op, dev, seq, time];
                },
            };

            expect(beginWindowGrabOp(mockWin, 10, null, 12345, {x: 0, y: 0})).toBeTrue();
            expect(callArgs).toEqual([10, device, null, 12345]);
        });

        it('calls the 5-argument device signature on GNOME 46–48', () => {
            const device = useShell({spriteApi: false});
            const posHint = {x: 100, y: 200};
            let callArgs = null;
            const mockWin = {
                begin_grab_op(op, dev, seq, time, pos) {
                    callArgs = [op, dev, seq, time, pos];
                },
            };

            expect(beginWindowGrabOp(mockWin, 10, null, 12345, posHint)).toBeTrue();
            expect(callArgs).toEqual([10, device, null, 12345, posHint]);
        });

        it('returns false on 49–51 when the sprite is missing', () => {
            useShell({spriteApi: true});
            let called = false;
            const mockWin = {
                begin_grab_op() {
                    called = true;
                },
            };

            expect(beginWindowGrabOp(mockWin, 10, null, 12345, {x: 0, y: 0})).toBeFalse();
            expect(called).toBeFalse();
        });

        it('returns false on 45–48 when no pointer device can be resolved', () => {
            // A backend with no seat to hand one out, and no backend at all: on 45-48 the backend
            // is the only place a pointer device can come from.
            globalThis.global = {display: {}, stage: {get_context: () => ({get_backend: () => ({})})}};
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
            useShell({spriteApi: true});
            expect(beginWindowGrabOp(null, 10, null, 0, null)).toBeFalse();
            expect(beginWindowGrabOp({}, 10, null, 0, null)).toBeFalse();
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
            globalThis.global = {
                stage: {
                    get_context() {
                        return {
                            get_backend() {
                                return {
                                    get_sprite(_stage, event) {
                                        return event === mockEvent ? expectedSprite : null;
                                    },
                                };
                            },
                        };
                    },
                },
            };

            expect(getPointerSprite(mockEvent)).toBe(expectedSprite);
        });

        it('falls back to get_pointer_sprite when get_sprite is unavailable', () => {
            const fallbackSprite = {id: 'pointer-sprite'};
            globalThis.global = {
                stage: {
                    get_context() {
                        return {
                            get_backend() {
                                return {
                                    get_pointer_sprite() {
                                        return fallbackSprite;
                                    },
                                };
                            },
                        };
                    },
                },
            };

            expect(getPointerSprite({})).toBe(fallbackSprite);
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
});
