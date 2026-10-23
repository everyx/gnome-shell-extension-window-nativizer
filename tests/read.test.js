import {readWindowString, safeRead} from '../src/platform/read.js';

describe('safeRead', () => {
    it('returns the value the getter read', () => {
        expect(safeRead(() => 42, -1)).toBe(42);
    });

    it('answers the fallback when the read throws', () => {
        // The throw is the reason the helper exists: Mutter raises it mid-teardown.
        expect(safeRead(() => {
            throw new Error('window is gone');
        }, -1)).toBe(-1);
    });

    it('answers the fallback for null and undefined, but keeps a falsy value', () => {
        expect(safeRead(() => null, 'x')).toBe('x');
        expect(safeRead(() => undefined, 'x')).toBe('x');
        // 0 and '' are answers, not absences: a pid of 0 is not "no pid".
        expect(safeRead(() => 0, -1)).toBe(0);
        expect(safeRead(() => '', 'x')).toBe('');
    });

    it('calls the getter exactly once', () => {
        let calls = 0;
        safeRead(() => {
            calls++;
            return 1;
        }, 0);
        expect(calls).toBe(1);
    });
});

describe('readWindowString', () => {
    it('answers an empty string rather than null for an unreadable value', () => {
        expect(readWindowString(() => null)).toBe('');
        expect(readWindowString(() => {
            throw new Error('non-UTF-8');
        })).toBe('');
    });

    it('returns a readable string unchanged', () => {
        expect(readWindowString(() => 'org.gnome.Nautilus')).toBe('org.gnome.Nautilus');
    });
});
