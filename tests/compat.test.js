/**
 * compat unit tests: verifying zero-side-effect ponyfills across GNOME 50–51 (jasmine-gjs).
 * Run: pnpm test
 */

import {CursorShape, setActorCursor, cursorTypeFor} from '../src/compat/actorCursor.js';
import {beginWindowGrabOp, getPointerSprite} from '../src/compat/grabOp.js';
import {resolveUniformLocation} from '../src/compat/uniformLocation.js';
import {coglContextForBake} from '../src/compat/coglContext.js';

describe('compat', () => {
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
                },
            };

            expect(beginWindowGrabOp(mockWin, 10, sprite, 12345, posHint)).toBeTrue();
            expect(callArgs).toEqual([10, sprite, 12345, posHint]);
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
});
