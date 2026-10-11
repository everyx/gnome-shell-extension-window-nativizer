/**
 * Window picker hit-test unit tests (jasmine-gjs).
 * Run: pnpm test
 */

import {pickTarget} from '../src/lib/pickTarget.js';

const rect = (x, y, width, height) => ({x, y, width, height});

/** @returns {object} A candidate that matches unless a field is overridden */
function candidate(window, overrides = {}) {
    return {
        window,
        minimized: false,
        hidden: false,
        mapped: true,
        onAllWorkspaces: false,
        onWorkspace: true,
        decoratable: true,
        frame: rect(0, 0, 100, 100),
        ...overrides,
    };
}

describe('pickTarget', () => {
    const workspace = {};
    const winA = {name: 'A'};
    const winB = {name: 'B'};

    it('picks the window whose frame rect contains the point', () => {
        expect(pickTarget([candidate(winA)], workspace, 50, 50)).toBe(winA);
        // Half-open, like the frame containment it replaces: the far edge belongs to the next window.
        expect(pickTarget([candidate(winA)], workspace, 99, 99)).toBe(winA);
        expect(pickTarget([candidate(winA)], workspace, 100, 50)).toBeNull();
        expect(pickTarget([candidate(winA)], workspace, 50, 100)).toBeNull();
    });

    it('does not pick a window on another workspace', () => {
        expect(pickTarget([candidate(winA, {onWorkspace: false})], workspace, 50, 50)).toBeNull();
        // A window on all workspaces is on this one too.
        expect(pickTarget([candidate(winA, {onWorkspace: false, onAllWorkspaces: true})], workspace, 50, 50))
            .toBe(winA);
        // With no active workspace the filter is skipped entirely.
        expect(pickTarget([candidate(winA, {onWorkspace: false})], null, 50, 50)).toBe(winA);
    });

    it('returns null over empty space', () => {
        expect(pickTarget([candidate(winA)], workspace, 150, 150)).toBeNull();
        expect(pickTarget([], workspace, 50, 50)).toBeNull();
    });

    it('picks the topmost of overlapping windows', () => {
        // Candidates are bottom-to-top; the last one wins.
        const bottom = candidate(winA, {frame: rect(0, 0, 100, 100)});
        const top = candidate(winB, {frame: rect(50, 50, 100, 100)});
        expect(pickTarget([bottom, top], workspace, 60, 60)).toBe(winB);
        // Outside the topmost, the one below still picks.
        expect(pickTarget([bottom, top], workspace, 10, 10)).toBe(winA);
    });

    it('skips minimized, hidden, unmapped and non-decoratable windows', () => {
        expect(pickTarget([candidate(winA, {minimized: true})], workspace, 50, 50)).toBeNull();
        expect(pickTarget([candidate(winA, {hidden: true})], workspace, 50, 50)).toBeNull();
        expect(pickTarget([candidate(winA, {mapped: false})], workspace, 50, 50)).toBeNull();
        expect(pickTarget([candidate(winA, {decoratable: false})], workspace, 50, 50)).toBeNull();
    });

    it('skips a null candidate left by a torn-down actor', () => {
        expect(pickTarget([null, candidate(winA)], workspace, 50, 50)).toBe(winA);
        expect(pickTarget([candidate(winA), null], workspace, 50, 50)).toBe(winA);
    });
});
