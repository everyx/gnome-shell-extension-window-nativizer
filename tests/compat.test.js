/**
 * compat unit tests: verifying zero-side-effect ponyfills across GNOME 45–51 (jasmine-gjs).
 * Run: pnpm test
 */

import {setActorCursor} from '../src/compat/actorCursor.js';
import {beginWindowGrabOp} from '../src/compat/grabOp.js';

describe('compat', () => {
    describe('setActorCursor', () => {
        it('calls set_cursor_type when supported by actor', () => {
            let receivedCursor = null;
            const actor = {
                set_cursor_type(cursor) {
                    receivedCursor = cursor;
                },
            };

            setActorCursor(actor, 42);
            expect(receivedCursor).toBe(42);
        });

        it('gracefully no-ops when actor does not support set_cursor_type (Clutter < 50)', () => {
            const actor = {};
            expect(() => setActorCursor(actor, 42)).not.toThrow();
        });

        it('gracefully handles null or undefined actor', () => {
            expect(() => setActorCursor(null, 42)).not.toThrow();
            expect(() => setActorCursor(undefined, 42)).not.toThrow();
        });
    });

    describe('beginWindowGrabOp', () => {
        it('invokes modern 4-argument begin_grab_op signature on GNOME 49–51+', () => {
            let callArgs = null;
            const mockWin = {
                begin_grab_op(op, sprite, time, pos) {
                    callArgs = [op, sprite, time, pos];
                },
            };

            const sprite = {isSprite: true};
            const posHint = {x: 100, y: 200};
            beginWindowGrabOp(mockWin, 10, sprite, 12345, posHint);

            expect(callArgs).not.toBeNull();
            expect(callArgs.length).toBe(4);
            expect(callArgs[0]).toBe(10);
            expect(callArgs[1]).toBe(sprite);
            expect(callArgs[2]).toBe(12345);
            expect(callArgs[3]).toBe(posHint);
        });

        it('defaults to modern 4-arg signature when arity is not legacy 5', () => {
            let callArgs = null;
            const mockWin = {
                begin_grab_op(...args) {
                    callArgs = args;
                },
            };
            const sprite = {isSprite: true};
            const posHint = {x: 100, y: 200};
            beginWindowGrabOp(mockWin, 10, sprite, 12345, posHint);
            expect(callArgs.length).toBe(4);
            expect(callArgs[1]).toBe(sprite);
        });

        it('dispatches to 5-argument signature on GNOME 45–48', () => {
            let fallbackArgs = null;
            const mockWin = {
                begin_grab_op(op, dev, seq, time, pos) {
                    fallbackArgs = [op, dev, seq, time, pos];
                },
            };

            const sprite = {isSprite: true};
            const posHint = {x: 100, y: 200};
            beginWindowGrabOp(mockWin, 10, sprite, 12345, posHint);

            expect(fallbackArgs).not.toBeNull();
            expect(fallbackArgs.length).toBe(5);
            expect(fallbackArgs[0]).toBe(10);
            expect(fallbackArgs[2]).toBeNull();
            expect(fallbackArgs[3]).toBe(12345);
            expect(fallbackArgs[4]).toBe(posHint);
        });
    });
});
