/**
 * rule model unit tests: keys, states and resolution (jasmine-gjs).
 * Run: pnpm test
 */

import {
    WindowType,
} from '../src/lib/mutterRules.generated.js';
import {
    RuleAxis, RULE_STATES, parseRuleState,
    buildRuleState, resolveRule, parseRuleKey, buildRuleKey,
    sanitizeWindowRules, withRule,
} from '../src/lib/rules.js';

/** Comparable shape for a resolveRule() result. */
function resolved(result) {
    return result && [...result].sort();
}

describe('rule state vocabulary', () => {
    it('parseRuleState reads each state into the axes that are ours', () => {
        expect([...parseRuleState('both')].sort()).toEqual(['corners', 'shadow']);
        expect([...parseRuleState('none')]).toEqual([]);
        expect([...parseRuleState('corners')]).toEqual([RuleAxis.CORNERS]);
        expect([...parseRuleState('shadow')]).toEqual([RuleAxis.SHADOW]);
    });

    it('parseRuleState rejects an empty string, an axis list and unknown words', () => {
        for (const bad of [
            '', 'shadow,corners', 'corners,shadow', 'corners,shadow,outline',
            'nonsense', null, undefined, 42,
        ])
            expect(parseRuleState(bad)).toBeNull();
    });

    it('buildRuleState renders the state that names exactly these axes', () => {
        expect(buildRuleState(['corners', 'shadow'])).toBe('both');
        expect(buildRuleState(['shadow', 'corners'])).toBe('both');
        expect(buildRuleState([RuleAxis.CORNERS])).toBe('corners');
        expect(buildRuleState([RuleAxis.SHADOW])).toBe('shadow');
        expect(buildRuleState([])).toBe('none');
        expect(buildRuleState(new Set())).toBe('none');
    });

    it('buildRuleState treats an unknown axis as no axis at all', () => {
        expect(buildRuleState(['nonsense'])).toBe('none');
        expect(buildRuleState(['nonsense', RuleAxis.CORNERS])).toBe('corners');
    });

    it('round-trips parseRuleState -> buildRuleState for every state', () => {
        for (const state of RULE_STATES)
            expect(buildRuleState(parseRuleState(state))).toBe(state);
    });

    it('the four states are the whole grammar, in display order', () => {
        expect([...RULE_STATES]).toEqual(['both', 'none', 'corners', 'shadow']);
    });
});

describe('resolveRule', () => {
    const mainKey = buildRuleKey('wechat');
    const fixedChildKey = buildRuleKey('wechat', {hasParent: true, allowsResize: false});

    it('exact fingerprint match, returning the axes that are ours', () => {
        const rules = {
            [mainKey]: 'corners',
            [fixedChildKey]: 'both',
        };
        expect(resolved(resolveRule('wechat', rules)))
            .toEqual(['corners']);
        expect(resolved(resolveRule('wechat', rules, {hasParent: true, allowsResize: false})))
            .toEqual(['corners', 'shadow']);
    });

    it('a none rule resolves to an empty axis set, not to no rule', () => {
        const rules = {[mainKey]: 'none'};
        expect(resolved(resolveRule('wechat', rules)))
            .toEqual([]);
    });

    it('a shadow-only rule leaves the corners axis out', () => {
        const rules = {[mainKey]: 'shadow'};
        expect(resolved(resolveRule('wechat', rules)))
            .toEqual(['shadow']);
    });

    it('does not fall back to the application: a different window kind of the same app does not match', () => {
        const rules = {[fixedChildKey]: 'both'};

        expect(resolveRule('wechat', rules)).toBeNull();
        expect(resolveRule('wechat', rules, {hasParent: true, allowsResize: true})).toBeNull();
        expect(resolveRule('wechat', rules, {clientType: 'x11', hasParent: true, allowsResize: false})).toBeNull();
        expect(resolveRule('wechat', rules, {windowType: WindowType.DIALOG, hasParent: true, allowsResize: false})).toBeNull();
    });

    it('matches an identity whatever case the window spells it in', () => {
        const upperRule = buildRuleKey('WeChat', {hasParent: true, allowsResize: false});
        expect(resolved(resolveRule('wechat', {[upperRule]: 'both'}, {hasParent: true, allowsResize: false})))
            .toEqual(['corners', 'shadow']);

        const lowerRule = buildRuleKey('wechat', {hasParent: true, allowsResize: false});
        expect(resolved(resolveRule('WeChat', {[lowerRule]: 'both'}, {hasParent: true, allowsResize: false})))
            .toEqual(['corners', 'shadow']);
    });

    it('exact size match distinguishes fixed-size windows of the same kind', () => {
        const qrDialogKey = buildRuleKey('wechat', {allowsResize: false, width: 360, height: 420});
        const toolbarKey = buildRuleKey('wechat', {allowsResize: false, width: 240, height: 48});

        const rules = {
            [qrDialogKey]: 'both',
            [toolbarKey]: 'none',
        };

        // QR dialog matches 'both'
        expect(resolved(resolveRule('wechat', rules, {
            allowsResize: false,
            frameWidth: 360,
            frameHeight: 420,
        }))).toEqual(['corners', 'shadow']);

        // Toolbar matches 'none'
        expect(resolved(resolveRule('wechat', rules, {
            allowsResize: false,
            frameWidth: 240,
            frameHeight: 48,
        }))).toEqual([]);

        // Other size of the same kind does not match
        expect(resolveRule('wechat', rules, {
            allowsResize: false,
            frameWidth: 500,
            frameHeight: 300,
        })).toBeNull();
    });

    it('falls back to generic rule without size when exact size rule is absent', () => {
        const genericFixedKey = buildRuleKey('wechat', {allowsResize: false});
        const exactQrKey = buildRuleKey('wechat', {allowsResize: false, width: 360, height: 420});

        const rules = {
            [genericFixedKey]: 'corners',
            [exactQrKey]: 'both',
        };

        // Exact size prefers the exact rule ('both')
        expect(resolved(resolveRule('wechat', rules, {
            allowsResize: false,
            frameWidth: 360,
            frameHeight: 420,
        }))).toEqual(['corners', 'shadow']);

        // Different size falls back to the generic rule ('corners')
        expect(resolved(resolveRule('wechat', rules, {
            allowsResize: false,
            frameWidth: 600,
            frameHeight: 400,
        }))).toEqual(['corners']);
    });

    it('no match returns null', () => {
        expect(resolveRule('unknown-app', {[mainKey]: 'both'})).toBeNull();
        expect(resolveRule(null, {[mainKey]: 'both'})).toBeNull();
        expect(resolveRule('', {[mainKey]: 'both'})).toBeNull();
    });

    it('every fingerprint field participates in matching', () => {
        const base = buildRuleKey('app', {
            clientType: 'wayland', windowType: WindowType.NORMAL,
            hasParent: true, allowsResize: false, isAttachedDialog: false,
        });
        const rules = {[base]: 'both'};

        expect(resolveRule('app', rules, {hasParent: true, allowsResize: false})).not.toBeNull();
        expect(resolveRule('app', rules, {clientType: 'x11', windowType: WindowType.NORMAL, hasParent: true, allowsResize: false, isAttachedDialog: false})).toBeNull();
        expect(resolveRule('app', rules, {windowType: WindowType.DIALOG, hasParent: true, allowsResize: false, isAttachedDialog: false})).toBeNull();
        expect(resolveRule('app', rules, {hasParent: true, allowsResize: true, isAttachedDialog: false})).toBeNull();
        expect(resolveRule('app', rules, {hasParent: true, allowsResize: false, isAttachedDialog: true})).toBeNull();
    });

    it('resolves legacy 5-field rules without has_ring as backward compatibility fallback', () => {
        const legacyKey = 'firefox:client_type=wayland,window_type=0,has_parent=false,allows_resize=true,attached_dialog=false';
        const rules = {[legacyKey]: 'corners'};

        // Both ringed and non-ringed windows fall back to matching the legacy rule when no 6-field rule exists
        const matchedMain = resolveRule('firefox', rules, {hasRing: true});
        const matchedPip = resolveRule('firefox', rules, {hasRing: false});

        expect(matchedMain).not.toBeNull();
        expect(matchedMain.has('corners')).toBeTrue();
        expect(matchedPip).not.toBeNull();
        expect(matchedPip.has('corners')).toBeTrue();

        // But when a specific 6-field rule is added, it takes precedence
        const specificKey = buildRuleKey('firefox', {hasRing: true});
        const updatedRules = {...rules, [specificKey]: 'both'};
        expect(resolveRule('firefox', updatedRules, {hasRing: true}).has('shadow')).toBeTrue();
        // PiP still falls back to legacy corners rule
        expect(resolveRule('firefox', updatedRules, {hasRing: false}).has('shadow')).toBeFalse();
    });

    it('terminates rule resolution when 6-field generic key has invalid state and does not fall back to legacy key', () => {
        const generic6Key = buildRuleKey('firefox', {hasRing: true});
        const legacyGenericKey = buildRuleKey('firefox', {legacy: true});

        // 6-field key exists but contains invalid state; legacy key contains valid state
        const rules = {
            [generic6Key]: 'invalid-state-value',
            [legacyGenericKey]: 'both',
        };

        // Must return null instead of falling through to legacyGenericKey
        expect(resolveRule('firefox', rules, {hasRing: true})).toBeNull();
    });
});

describe('buildRuleKey', () => {
    it('always emits the full window-kind fingerprint', () => {
        expect(buildRuleKey('wechat')).toBe(
            'wechat:client_type=wayland,window_type=0,has_parent=false,allows_resize=true,attached_dialog=false,has_ring=false');
    });

    it('encodes every structural field', () => {
        expect(buildRuleKey('wechat', {
            clientType: 'x11',
            windowType: 3,
            hasParent: true,
            allowsResize: false,
            isAttachedDialog: true,
            hasRing: true,
        })).toBe('wechat:client_type=x11,window_type=3,has_parent=true,allows_resize=false,attached_dialog=true,has_ring=true');
    });

    it('orders has_ring before size in 6-field canonical key', () => {
        const key = buildRuleKey('wechat', {
            clientType: 'wayland',
            windowType: WindowType.NORMAL,
            hasParent: false,
            allowsResize: false,
            isAttachedDialog: false,
            hasRing: true,
            width: 360,
            height: 420,
        });
        expect(key).toBe(
            'wechat:client_type=wayland,window_type=0,has_parent=false,allows_resize=false,attached_dialog=false,has_ring=true,size=360x420'
        );
        expect(key.indexOf('has_ring=true')).toBeLessThan(key.indexOf('size=360x420'));
    });

    it('generates legacy 5-field key byte-identical to pre-has_ring format', () => {
        const waylandLegacy = buildRuleKey('firefox', {
            clientType: 'wayland',
            windowType: WindowType.NORMAL,
            hasParent: false,
            allowsResize: true,
            isAttachedDialog: false,
            legacy: true,
        });
        expect(waylandLegacy).toBe(
            'firefox:client_type=wayland,window_type=0,has_parent=false,allows_resize=true,attached_dialog=false'
        );

        const fixedLegacy = buildRuleKey('wechat', {
            clientType: 'wayland',
            windowType: WindowType.NORMAL,
            hasParent: false,
            allowsResize: false,
            isAttachedDialog: false,
            width: 360,
            height: 420,
            legacy: true,
        });
        expect(fixedLegacy).toBe(
            'wechat:client_type=wayland,window_type=0,has_parent=false,allows_resize=false,attached_dialog=false,size=360x420'
        );
    });

    it('distinguishes Firefox main window and Picture-in-Picture window via has_ring', () => {
        // Main browser window declares shadow margin ring
        const firefoxMain = buildRuleKey('firefox', {hasRing: true});
        // PiP player window is a compact borderless video surface with no shadow margin ring
        const firefoxPip = buildRuleKey('firefox', {hasRing: false});

        expect(firefoxMain).toBe(
            'firefox:client_type=wayland,window_type=0,has_parent=false,allows_resize=true,attached_dialog=false,has_ring=true');
        expect(firefoxPip).toBe(
            'firefox:client_type=wayland,window_type=0,has_parent=false,allows_resize=true,attached_dialog=false,has_ring=false');
        expect(firefoxMain).not.toBe(firefoxPip);

        // Rules for main window do not collide with PiP window
        const userRules = {[firefoxMain]: 'both'};
        expect(resolveRule('firefox', userRules, {hasRing: true})).not.toBeNull();
        expect(resolveRule('firefox', userRules, {hasRing: false})).toBeNull();
    });

    it('encodes size only for fixed-size windows (allowsResize=false)', () => {
        expect(buildRuleKey('wechat', {
            allowsResize: false,
            width: 360,
            height: 420,
        })).toBe('wechat:client_type=wayland,window_type=0,has_parent=false,allows_resize=false,attached_dialog=false,has_ring=false,size=360x420');

        // Resizable windows never encode size
        expect(buildRuleKey('wechat', {
            allowsResize: true,
            width: 800,
            height: 600,
        })).toBe('wechat:client_type=wayland,window_type=0,has_parent=false,allows_resize=true,attached_dialog=false,has_ring=false');

        // Rounds fractional sizes to integers
        expect(buildRuleKey('wechat', {
            allowsResize: false,
            width: 359.8,
            height: 420.2,
        })).toBe('wechat:client_type=wayland,window_type=0,has_parent=false,allows_resize=false,attached_dialog=false,has_ring=false,size=360x420');
    });

    it('never collapses to a bare application key', () => {
        expect(buildRuleKey('wechat', {hasParent: false})).not.toBe('wechat');
        expect(buildRuleKey('wechat', {hasParent: true, allowsResize: false})).not.toBe('wechat');
    });

    it('empty wmClass returns empty string', () => {
        expect(buildRuleKey('')).toBe('');
        expect(buildRuleKey(null)).toBe('');
    });
});

describe('parseRuleKey', () => {
    const key = 'wechat:client_type=wayland,window_type=0,has_parent=true,allows_resize=false,attached_dialog=false';

    it('parses base wmClass, specifier and typed properties', () => {
        expect(parseRuleKey(key)).toEqual({
            baseWmClass: 'wechat',
            specifier: 'client_type=wayland,window_type=0,has_parent=true,allows_resize=false,attached_dialog=false',
            properties: {
                client_type: 'wayland',
                window_type: 0,
                has_parent: true,
                allows_resize: false,
                attached_dialog: false,
            },
        });
    });

    it('parses fixed-size key with dimensions', () => {
        const sizedKey = 'wechat:client_type=wayland,window_type=0,has_parent=false,allows_resize=false,attached_dialog=false,size=360x420';
        expect(parseRuleKey(sizedKey)).toEqual({
            baseWmClass: 'wechat',
            specifier: 'client_type=wayland,window_type=0,has_parent=false,allows_resize=false,attached_dialog=false,size=360x420',
            properties: {
                client_type: 'wayland',
                window_type: 0,
                has_parent: false,
                allows_resize: false,
                attached_dialog: false,
                size: '360x420',
                width: 360,
                height: 420,
            },
        });
    });

    it('empty or null', () => {
        expect(parseRuleKey('')).toEqual({baseWmClass: '', specifier: null, properties: null});
        expect(parseRuleKey(null)).toEqual({baseWmClass: '', specifier: null, properties: null});
    });

    it('rejects bare app keys and legacy specifiers', () => {
        const invalid = [
            'wechat',
            'wechat:dialog',
            'wechat:title=Exit',
            'wechat:has_parent=true,allows_resize=false',
            'wechat:foo=bar',
            'wechat:client_type=macos,window_type=0,has_parent=false,allows_resize=true,attached_dialog=false',
            // Resizable window MUST NOT have size
            'wechat:client_type=wayland,window_type=0,has_parent=false,allows_resize=true,attached_dialog=false,size=800x600',
        ];
        for (const bad of invalid)
            expect(parseRuleKey(bad)).toEqual({baseWmClass: '', specifier: null, properties: null});
    });
});

describe('rule key contract & round-trip', () => {
    it('round-trip: buildRuleKey -> parseRuleKey', () => {
        const keys = [
            buildRuleKey('wechat'),
            buildRuleKey('wechat', {hasParent: true, allowsResize: false}),
            buildRuleKey('wechat', {allowsResize: false, width: 360, height: 420}),
            buildRuleKey('steam', {clientType: 'x11', windowType: WindowType.MODAL_DIALOG, isAttachedDialog: true}),
        ];
        for (const key of keys) {
            const parsed = parseRuleKey(key);
            expect(`${parsed.baseWmClass}:${parsed.specifier}`).toBe(key);
        }
    });

    it('escapes identities the key grammar would otherwise split or drop', () => {
        // A bare 'window:5' used to build a key the validator rejected, so the
        // rule was silently discarded instead of ever matching.
        const colonKey = buildRuleKey('window:5');
        expect(colonKey.startsWith('window%3A5:')).toBeTrue();
        expect(parseRuleKey(colonKey).baseWmClass).toBe('window:5');

        const spacedKey = buildRuleKey('my app');
        expect(parseRuleKey(spacedKey).baseWmClass).toBe('my app');
    });

    it('lowercases an identity but changes nothing else about it', () => {
        expect(buildRuleKey('wechat').startsWith('wechat:')).toBeTrue();
        expect(buildRuleKey('org.gnome.Nautilus').startsWith('org.gnome.nautilus:')).toBeTrue();
    });

    it('prefs-generated keys match resolveRule for the picked kind only', () => {
        const picked = {hasParent: true, allowsResize: false};
        const prefsGeneratedRules = {
            [buildRuleKey('code', picked)]: buildRuleState(parseRuleState('both')),
        };
        expect(resolved(resolveRule('code', prefsGeneratedRules, picked)))
            .toEqual(['corners', 'shadow']);
        expect(resolveRule('code', prefsGeneratedRules, {hasParent: true, allowsResize: true})).toBeNull();
        expect(resolveRule('code', prefsGeneratedRules)).toBeNull();
    });
});

describe('sanitizeWindowRules', () => {
    const mainKey = buildRuleKey('wechat');
    const childKey = buildRuleKey('wechat', {hasParent: true, allowsResize: false});

    it('passes valid fingerprint keys and state values unchanged', () => {
        const input = {
            [mainKey]: 'corners',
            [childKey]: 'both',
        };
        expect(sanitizeWindowRules(input)).toEqual({
            [mainKey]: 'corners',
            [childKey]: 'both',
        });
    });

    it('drops bare app keys, legacy specifiers and malformed keys', () => {
        const input = {
            [mainKey]: 'corners',
            'wechat': 'both',
            'wechat:dialog': 'both',
            'wechat:title=Exit': 'both',
            'wechat:has_parent=true,allows_resize=false': 'both',
            'invalid:key:too:many:colons': 'both',
            'has space:client_type=wayland,window_type=0,has_parent=false,allows_resize=true,attached_dialog=false': 'both',
            'bad:client_type=macos,window_type=0,has_parent=false,allows_resize=true,attached_dialog=false': 'both',
            [buildRuleKey('valid_app')]: 123,
        };
        expect(sanitizeWindowRules(input)).toEqual({[mainKey]: 'corners'});
    });

    it('drops entries naming an invalid or legacy state', () => {
        const input = {
            [mainKey]: 'both',
            [childKey]: 'not-a-valid-mode',
            [buildRuleKey('legacy-all')]: 'all',
            [buildRuleKey('legacy-clip')]: 'clip',
            [buildRuleKey('legacy-disable')]: 'disable-all',
            [buildRuleKey('legacy-axes')]: 'shadow,corners',
        };
        expect(sanitizeWindowRules(input)).toEqual({[mainKey]: 'both'});
    });

    it('canonicalises the identity to lowercase when storing it', () => {
        const canonical = buildRuleKey('wechat');
        const asSpelled = `WeChat:${canonical.slice(canonical.indexOf(':') + 1)}`;

        expect(buildRuleKey('WeChat')).toBe(canonical);
        expect(sanitizeWindowRules({[asSpelled]: 'corners'})).toEqual({
            [canonical]: 'corners',
        });
    });

    it('rejects case-colliding duplicate keys deterministically', () => {
        const canonical = buildRuleKey('wechat');
        const asSpelled = `WeChat:${canonical.slice(canonical.indexOf(':') + 1)}`;
        const input = {
            [asSpelled]: 'corners',
            [canonical]: 'both',
        };
        expect(sanitizeWindowRules(input)).toEqual({
            [canonical]: 'corners',
        });
    });

    it('handles undefined or non-object input as an empty map', () => {
        expect(sanitizeWindowRules(undefined)).toEqual({});
        expect(sanitizeWindowRules(null)).toEqual({});
        expect(sanitizeWindowRules('string')).toEqual({});
        expect(sanitizeWindowRules({})).toEqual({});
    });
});

describe('withRule', () => {
    const key = buildRuleKey('wechat', {hasParent: true});

    it('stores the state it was given', () => {
        expect(withRule({}, key, 'shadow')).toEqual({[key]: 'shadow'});
        expect(withRule({}, key, 'both')).toEqual({[key]: 'both'});
    });

    it('writes none as a rule, not as an absent one', () => {
        expect(withRule({}, key, 'none')).toEqual({[key]: 'none'});
    });

    it('replaces the state already stored for the kind', () => {
        const stored = buildRuleKey('WeChat', {hasParent: true});
        const updated = withRule({[stored]: 'corners'}, key, 'both');
        expect(updated).toEqual({[key]: 'both'});
    });

    it('leaves the rule map it was given untouched', () => {
        const rules = {[key]: 'shadow'};
        withRule(rules, key, 'corners');
        expect(rules).toEqual({[key]: 'shadow'});
    });

    it('refuses anything but the four states', () => {
        expect(() => withRule({}, key, 'shadow,corners')).toThrow();
        expect(() => withRule({}, key, undefined)).toThrow();
    });
});
