/**
 * rulePresenter unit tests (jasmine-gjs).
 * Verifies rule key property formatting, natural language generation, and axis presentation.
 * Run: pnpm test
 */

import {WindowType} from '../src/lib/mutterRules.generated.js';
import {RuleAxis} from '../src/lib/rules.js';
import {
    axisName,
    isDecoratableKind,
    keyAxisCapabilities,
    neverDecorated,
    axisUnavailableReason,
    ruleSummaryText,
    windowTypeNoun,
    windowKindSentence,
    asMarkup,
} from '../src/lib/rulePresenter.js';

describe('rulePresenter', () => {
    describe('axisName', () => {
        it('returns human-readable names for known axes', () => {
            expect(axisName(RuleAxis.CORNERS)).toBe('Corners');
            expect(axisName(RuleAxis.SHADOW)).toBe('Shadow');
            expect(axisName(RuleAxis.RESIZE)).toBe('Resize');
        });

        it('falls back to the axis identifier for unknown axes', () => {
            expect(axisName('unknown-axis')).toBe('unknown-axis');
        });
    });

    describe('isDecoratableKind', () => {
        it('identifies decoratable normal windows and dialogs', () => {
            expect(isDecoratableKind({windowType: WindowType.NORMAL})).toBeTrue();
            expect(isDecoratableKind({windowType: WindowType.DIALOG})).toBeTrue();
            expect(isDecoratableKind({windowType: WindowType.MODAL_DIALOG})).toBeTrue();
        });

        it('identifies non-decoratable window types or null kind', () => {
            expect(isDecoratableKind(null)).toBeFalse();
            expect(isDecoratableKind(undefined)).toBeFalse();
            // POPUP_MENU / DROPDOWN_MENU are not decoratable
            expect(isDecoratableKind({windowType: WindowType.DROPDOWN_MENU})).toBeFalse();
            expect(isDecoratableKind({windowType: WindowType.POPUP_MENU})).toBeFalse();
        });
    });

    describe('keyAxisCapabilities', () => {
        it('computes default capabilities for resizable normal windows', () => {
            const caps = keyAxisCapabilities({
                windowType: WindowType.NORMAL,
                allowsResize: true,
                hasSsd: false,
            });
            expect(caps).toEqual({
                [RuleAxis.CORNERS]: true,
                [RuleAxis.SHADOW]: true,
                [RuleAxis.RESIZE]: true,
            });
        });

        it('disables resize capability for fixed-size windows or SSD frames', () => {
            const fixedCaps = keyAxisCapabilities({
                windowType: WindowType.NORMAL,
                allowsResize: false,
                hasSsd: false,
            });
            expect(fixedCaps[RuleAxis.RESIZE]).toBeFalse();

            const ssdCaps = keyAxisCapabilities({
                windowType: WindowType.NORMAL,
                allowsResize: true,
                hasSsd: true,
            });
            expect(ssdCaps[RuleAxis.RESIZE]).toBeFalse();
        });
    });

    describe('axisUnavailableReason', () => {
        it('returns neverDecorated when window kind cannot be decorated', () => {
            expect(axisUnavailableReason(RuleAxis.CORNERS, false)).toBe(neverDecorated());
            expect(axisUnavailableReason(RuleAxis.RESIZE, false)).toBe(neverDecorated());
        });

        it('explains resize unavailability for SSD frames', () => {
            const reason = axisUnavailableReason(RuleAxis.RESIZE, true, {hasSsd: true});
            expect(reason).toBe('The window frame can already be resized');
        });

        it('explains resize unavailability for fixed-size windows', () => {
            const reason = axisUnavailableReason(RuleAxis.RESIZE, true, {allowsResize: false});
            expect(reason).toBe('Fixed-size windows have no resize handle');
        });
    });

    describe('ruleSummaryText', () => {
        it('formats active axis states into clean text', () => {
            expect(ruleSummaryText('corners')).toBe('Corners');
            expect(ruleSummaryText('shadow')).toBe('Shadow');
            expect(ruleSummaryText('corners,shadow')).toBe('Corners, Shadow');
            expect(ruleSummaryText('corners,resize')).toBe('Corners, Resize');
        });

        it('returns Automatic when no axis is corrected', () => {
            expect(ruleSummaryText('')).toBe('Automatic');
        });

        it('returns raw state if parsing fails', () => {
            expect(ruleSummaryText('not-a-state')).toBe('not-a-state');
        });
    });

    describe('windowTypeNoun', () => {
        it('maps window types to English nouns', () => {
            expect(windowTypeNoun(WindowType.NORMAL)).toBe('window');
            expect(windowTypeNoun(WindowType.DIALOG)).toBe('dialog');
            expect(windowTypeNoun(WindowType.MODAL_DIALOG)).toBe('modal dialog');
            expect(windowTypeNoun(WindowType.UTILITY)).toBe('utility window');
        });
    });

    describe('windowKindSentence', () => {
        it('returns empty string for null/undefined kind', () => {
            expect(windowKindSentence(null)).toBe('');
            expect(windowKindSentence(undefined)).toBe('');
        });

        it('formats Wayland top-level resizable window without parent', () => {
            const sentence = windowKindSentence({
                clientType: 'wayland',
                windowType: WindowType.NORMAL,
                hasParent: false,
                allowsResize: true,
                attachedDialog: false,
                hasRing: true,
                hasSsd: false,
                width: null,
                height: null,
            });
            expect(sentence).toBe('Wayland window, with no parent, resizable');
        });

        it('formats X11 dialog attached to parent with fixed dimensions', () => {
            const sentence = windowKindSentence({
                clientType: 'x11',
                windowType: WindowType.DIALOG,
                hasParent: true,
                attachedDialog: true,
                allowsResize: false,
                hasRing: true,
                hasSsd: false,
                width: 480,
                height: 320,
            });
            expect(sentence).toBe('X11 dialog, attached to its parent, fixed-size (480×320)');
        });

        it('formats window with system-drawn frame', () => {
            const sentence = windowKindSentence({
                clientType: 'wayland',
                windowType: WindowType.NORMAL,
                hasParent: false,
                attachedDialog: false,
                hasSsd: true,
                hasRing: false,
                allowsResize: false,
                width: null,
                height: null,
            });
            expect(sentence).toBe('Wayland window, with no parent, frame drawn by the system, fixed-size');
        });

        it('formats window with declared zero shadow margins', () => {
            const sentence = windowKindSentence({
                clientType: 'wayland',
                windowType: WindowType.NORMAL,
                hasParent: false,
                attachedDialog: false,
                hasRing: false,
                hasSsd: false,
                allowsResize: true,
                width: null,
                height: null,
            });
            expect(sentence).toBe('Wayland window, with no parent, no shadow margins, resizable');
        });
    });

    describe('asMarkup', () => {
        it('escapes XML/Pango markup special characters', () => {
            expect(asMarkup('A & B <C> "D" \'E\'')).toBe('A &amp; B &lt;C&gt; &quot;D&quot; &apos;E&apos;');
        });
    });
});
