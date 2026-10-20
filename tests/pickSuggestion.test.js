/**
 * The pick suggestion: which axes a kind can be corrected on, what a pick suggests, and whether
 * storing it would change anything (jasmine-gjs).
 * Run: pnpm test
 */

import {WindowType} from '../src/lib/mutterRules.generated.js';
import {buildRuleKey, buildRuleKeyFromProperties} from '../src/lib/rules.js';
import {suggestedRuleState, suggestedRuleWouldChange} from '../src/lib/pickSuggestion.js';

describe('the pick heuristic', () => {
    // What a window we decorate looks like: the client declares no margin at all.
    const plainWindow = {
        bufferWidth: 400, bufferHeight: 300,
        frameWidth: 400, frameHeight: 300,
        monitorScale: 1,
        windowType: WindowType.NORMAL,
        wmClass: 'plain-app',
    };
    // A client that declares its own margins, so the heuristic stands down.
    const csdWindow = {
        ...plainWindow,
        bufferWidth: 460, bufferHeight: 360,
        wmClass: 'csd-app',
    };
    // A client that already looks like us and paints its own shadow: no axis of ours.
    const nativeWindow = {...csdWindow, nativeLikeCorners: true, wmClass: 'adw-app'};
    const propertiesFor = win => ({
        wmClass: win.wmClass,
        clientType: 'wayland',
        windowType: String(win.windowType),
        hasParent: 'false',
        allowsResize: 'true',
        isAttachedDialog: 'false',
        hasRing: String(!win.hasSsd && (win.bufferWidth > win.frameWidth || win.bufferHeight > win.frameHeight)),
        hasSsd: String(Boolean(win.hasSsd)),
    });

    describe('suggestedRuleState', () => {
        it('corrects every axis the kind can be corrected on', () => {
            // Both are ordinary resizable windows: all three axes can be acted on.
            expect(suggestedRuleState(plainWindow)).toBe('corners,shadow,resize');
            expect(suggestedRuleState(csdWindow)).toBe('corners,shadow,resize');
        });

        it('corrects the axes of a window that already looks right too', () => {
            // nativeWindow looks like us and paints its own shadow, and Firefox's PiP is
            // deliberately left native-like: the heuristic draws no clip of ours on either.
            // The pick still proposes the full correction - the user picked the window
            // because it looks wrong, and correcting corners is how it gets rounded.
            expect(suggestedRuleState(nativeWindow)).toBe('corners,shadow,resize');
            expect(suggestedRuleState({...nativeWindow, wmClass: 'firefox'})).toBe('corners,shadow,resize');
        });

        it('leaves out an axis the runtime could not act on', () => {
            // The compositor's own frame owns the handles of an SSD window, so the resize
            // axis has no decision to reverse - a rule naming it could not take effect.
            const ssdNative = {...plainWindow, hasSsd: true, wmClass: 'ssd-adw-app'};
            expect(suggestedRuleState(ssdNative)).toBe('corners,shadow');
            // Same for a window that cannot be resized at all.
            expect(suggestedRuleState({...plainWindow, allowsResize: false, wmClass: 'fixed-app'}))
                .toBe('corners,shadow');
        });

        it('suggests nothing for a kind we never decorate', () => {
            expect(suggestedRuleState({...plainWindow, windowType: WindowType.MENU})).toBe('');
        });

        it('judges the kind, not the transient state the window is in', () => {
            // A maximized or tiled window is not decorated while it is in that state, but
            // the rule outlives it, and the axes are the kind's either way.
            expect(suggestedRuleState({...plainWindow, isMaximized: true})).toBe('corners,shadow,resize');
            expect(suggestedRuleState({...plainWindow, hasTileMatch: true, tiled: true})).toBe('corners,shadow,resize');
        });

        it('proposes the same correction for a kind that already has a rule', () => {
            // The suggestion answers for the kind's capability, so a stored rule neither
            // adds nor removes an axis; prefs separately refuses a pick that changes nothing.
            const decorated = {
                ...nativeWindow,
                rules: {[buildRuleKey('adw-app', {hasRing: true})]: 'corners'},
            };
            expect(suggestedRuleState(decorated)).toBe('corners,shadow,resize');
        });
    });

    describe('suggestedRuleWouldChange', () => {
        it('reports no effect when the state reverses nothing', () => {
            // '' names no axis, so the automatic decisions stand and the rule is a no-op.
            expect(suggestedRuleWouldChange(propertiesFor(plainWindow), plainWindow, '')).toBeFalse();
        });

        it('reports an effect when reversing the shadow retracts the ring takeover', () => {
            // csdWindow's automatic shadow is ours (the corner takeover drew it), so
            // reversing the shadow axis retracts it - a real change.
            expect(suggestedRuleWouldChange(propertiesFor(csdWindow), csdWindow, 'shadow')).toBeTrue();
        });

        it('reports an effect when reversing all three axes on a window we decorate', () => {
            expect(suggestedRuleWouldChange(propertiesFor(plainWindow), plainWindow, 'corners,shadow,resize')).toBeTrue();
        });

        it('reports an effect when storing corners only for a window that draws its own shadow', () => {
            // The rule lets the client keep its shadow, so the takeover no longer fires.
            expect(suggestedRuleWouldChange(propertiesFor(csdWindow), csdWindow, 'corners')).toBeTrue();
        });

        it('reports no effect when the state names an axis the structure gates', () => {
            // An SSD window has no band whatever the rule says, so reversing resize is inert.
            const ssdNative = {...nativeWindow, hasSsd: true, wmClass: 'ssd-native'};
            expect(suggestedRuleWouldChange(propertiesFor(ssdNative), ssdNative, 'resize')).toBeFalse();
        });

        it('reports an effect when reversing the band retracts it', () => {
            // Reversing resize turns the heuristic's band off.
            expect(suggestedRuleWouldChange(propertiesFor(nativeWindow), nativeWindow, 'resize')).toBeTrue();
        });

        it('reports no effect for a window type we never decorate', () => {
            const menu = {...plainWindow, windowType: WindowType.MENU};

            expect(suggestedRuleWouldChange(propertiesFor(menu), menu, 'corners,shadow')).toBeFalse();
            expect(suggestedRuleWouldChange(propertiesFor(menu), menu, 'corners,shadow,resize')).toBeFalse();
        });

        it('judges the rule against the kind, not the state the window is in', () => {
            // A maximized window is never decorated, but the rule outlives the state.
            const maximized = {...plainWindow, isMaximized: true};
            expect(suggestedRuleWouldChange(propertiesFor(maximized), maximized, 'corners,shadow,resize')).toBeTrue();
        });

        it('preserves the hasSsd / nativeLikeCorners kind attributes while normalizing transient state', () => {
            // Maximized (transient) is normalized away, but hasSsd (kind) is kept: the
            // proposal is judged against the SSD kind's own key.
            const ssd = {...plainWindow, hasSsd: true, isMaximized: true, wmClass: 'xclock'};
            expect(propertiesFor(ssd).hasSsd).toBe('true');
            expect(suggestedRuleWouldChange(propertiesFor(ssd), ssd, 'corners,shadow,resize')).toBeTrue();
            // Corners that already look like ours are left alone - but reversing all three
            // also retracts the heuristic band, so it still changes the outcome.
            const nativeLike = {...csdWindow, nativeLikeCorners: true, isMaximized: true, wmClass: 'adw-app'};
            expect(suggestedRuleWouldChange(propertiesFor(nativeLike), nativeLike, 'corners,shadow,resize')).toBeTrue();
            expect(suggestedRuleWouldChange(propertiesFor(nativeLike), nativeLike, '')).toBeFalse();
        });

        it('suggests nothing for a structurally ineligible window, and any rule is inert', () => {
            // A menu is never decorated, so there is nothing to correct - and a state
            // stored for it would have no effect, which is what the pre-flight reports.
            const menu = {...plainWindow, windowType: WindowType.MENU};
            expect(suggestedRuleState(menu)).toBe('');
            expect(suggestedRuleWouldChange(propertiesFor(menu), menu, 'corners,shadow')).toBeFalse();
        });

        it('returns null when the window declares no identity', () => {
            const anonymous = {...plainWindow, wmClass: ''};
            expect(suggestedRuleWouldChange(propertiesFor(anonymous), anonymous, 'corners,shadow')).toBeNull();
        });

        it('reports an effect on a window the visual floor abstained from', () => {
            // The floor is a reading, so naming an axis is a real correction - which is what makes
            // the known boundary (a window mapped tiny) recoverable by a pick.
            const floored = {
                ...plainWindow, wmClass: 'tiny-tool',
                bufferWidth: 38, bufferHeight: 38, frameWidth: 38, frameHeight: 38,
                initialFrameWidth: 38, initialFrameHeight: 38,
            };
            expect(suggestedRuleWouldChange(propertiesFor(floored), floored, 'corners')).toBeTrue();
            expect(suggestedRuleWouldChange(propertiesFor(floored), floored, 'shadow')).toBeTrue();
        });

        it('keys the rule the way the runtime looks it up', () => {
            expect(buildRuleKeyFromProperties(propertiesFor(plainWindow))).toBe(buildRuleKey('plain-app'));
        });
    });
});
