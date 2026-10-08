/**
 * rule model unit tests: keys, states and resolution (jasmine-gjs).
 * Run: pnpm test
 */

import {
    WindowType,
} from '../src/lib/mutterRules.generated.js';
import {
    RuleAxis, RULE_AXES, parseRuleState, buildRuleState,
    resolveRule, parseRuleKey, buildRuleKey, buildRuleKeyFromProperties,
    FINGERPRINT_FIELDS,
    sanitizeWindowRules, sanitizeRuleTitles, withRule,
    CLIENT_TYPE_TOKEN_WAYLAND, CLIENT_TYPE_TOKEN_X11,
} from '../src/lib/rules.js';

/** Comparable shape for a resolveRule() result: canonical stored form. */
function resolved(result) {
    return result && buildRuleState(result);
}

describe('rule state vocabulary', () => {
    it('parseRuleState reads the reversed axes; an unnamed axis follows the decision', () => {
        expect([...parseRuleState('corners')]).toEqual(['corners']);
        expect([...parseRuleState('corners,resize')]).toEqual(['corners', 'resize']);
        expect([...parseRuleState('corners,shadow,resize')]).toEqual(['corners', 'shadow', 'resize']);
        expect([...parseRuleState('')]).toEqual([]);
    });

    it('rejects the old axis=value grammar, duplicates, wrong order and unknown words', () => {
        for (const bad of [
            'corners=on', 'corners=off', 'both', 'none',
            'shadow,corners', 'corners,corners', 'corners,outline', 'outline',
            'corners,', ',corners', 'nonsense', null, undefined, 42,
        ])
            expect(parseRuleState(bad)).toBeNull();
    });

    it('buildRuleState renders canonical order', () => {
        expect(buildRuleState(['corners', 'shadow'])).toBe('corners,shadow');
        expect(buildRuleState(['resize', 'corners'])).toBe('corners,resize');
        expect(buildRuleState(new Set(['resize']))).toBe('resize');
        expect(buildRuleState(['resize', 'shadow', 'corners', 'resize']))
            .toBe('corners,shadow,resize');
    });

    it('buildRuleState renders "nothing reversed" as empty: no rule', () => {
        expect(buildRuleState([])).toBe('');
        expect(buildRuleState()).toBe('');
        expect(buildRuleState(null)).toBe('');
    });

    it('round-trips parseRuleState -> buildRuleState', () => {
        for (const state of ['corners', 'shadow,resize', 'corners,shadow,resize', '']) {
            const canonical = buildRuleState(parseRuleState(state));
            expect(buildRuleState(parseRuleState(canonical))).toBe(canonical);
        }
    });

    it('round-trips an axis set with no separate normalisation: empty and multiple axes', () => {
        expect(buildRuleState([])).toBe('');
        expect(buildRuleState(new Set(['resize', 'corners']))).toBe('corners,resize');
        expect([...parseRuleState('corners,shadow,resize')]).toEqual(['corners', 'shadow', 'resize']);
        expect([...parseRuleState(buildRuleState(['shadow']))]).toEqual(['shadow']);
    });

    it('the three axes are the whole grammar, in canonical order', () => {
        expect([...RULE_AXES]).toEqual(['corners', 'shadow', 'resize']);
        expect(RuleAxis.CORNERS).toBe('corners');
        expect(RuleAxis.SHADOW).toBe('shadow');
        expect(RuleAxis.RESIZE).toBe('resize');
    });
});

describe('resolveRule', () => {
    const mainKey = buildRuleKey('wechat');
    const fixedChildKey = buildRuleKey('wechat', {hasParent: true, allowsResize: false});

    it('exact fingerprint match, returning the reversed axes', () => {
        const rules = {
            [mainKey]: 'corners',
            [fixedChildKey]: 'corners,shadow',
        };
        expect(resolved(resolveRule('wechat', rules))).toBe('corners');
        expect(resolved(resolveRule('wechat', rules, {hasParent: true, allowsResize: false})))
            .toBe('corners,shadow');
    });

    it('an unnamed axis is not in the result: it follows the decision', () => {
        const rules = {[mainKey]: 'shadow'};
        expect([...resolveRule('wechat', rules)]).toEqual(['shadow']);
    });

    it('does not fall back to the application: a different window kind of the same app does not match', () => {
        const rules = {[fixedChildKey]: 'corners,shadow'};

        expect(resolveRule('wechat', rules)).toBeNull();
        expect(resolveRule('wechat', rules, {hasParent: true, allowsResize: true})).toBeNull();
        expect(resolveRule('wechat', rules, {clientType: CLIENT_TYPE_TOKEN_X11, hasParent: true, allowsResize: false})).toBeNull();
        expect(resolveRule('wechat', rules, {windowType: WindowType.DIALOG, hasParent: true, allowsResize: false})).toBeNull();
    });

    it('matches an identity whatever case the window spells it in', () => {
        const upperRule = buildRuleKey('WeChat', {hasParent: true, allowsResize: false});
        expect(resolved(resolveRule('wechat', {[upperRule]: 'corners,shadow'}, {hasParent: true, allowsResize: false})))
            .toBe('corners,shadow');

        const lowerRule = buildRuleKey('wechat', {hasParent: true, allowsResize: false});
        expect(resolved(resolveRule('WeChat', {[lowerRule]: 'corners,shadow'}, {hasParent: true, allowsResize: false})))
            .toBe('corners,shadow');
    });

    it('exact size match distinguishes fixed-size windows of the same kind', () => {
        const qrDialogKey = buildRuleKey('wechat', {allowsResize: false, width: 360, height: 420});
        const toolbarKey = buildRuleKey('wechat', {allowsResize: false, width: 240, height: 48});

        const rules = {
            [qrDialogKey]: 'corners,shadow',
            [toolbarKey]: 'corners,shadow,resize',
        };

        expect(resolved(resolveRule('wechat', rules, {
            allowsResize: false,
            frameWidth: 360,
            frameHeight: 420,
        }))).toBe('corners,shadow');

        expect(resolved(resolveRule('wechat', rules, {
            allowsResize: false,
            frameWidth: 240,
            frameHeight: 48,
        }))).toBe('corners,shadow,resize');

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
            [exactQrKey]: 'corners,shadow',
        };

        expect(resolved(resolveRule('wechat', rules, {
            allowsResize: false,
            frameWidth: 360,
            frameHeight: 420,
        }))).toBe('corners,shadow');

        expect(resolved(resolveRule('wechat', rules, {
            allowsResize: false,
            frameWidth: 600,
            frameHeight: 400,
        }))).toBe('corners');
    });

    it('no match returns null', () => {
        expect(resolveRule('unknown-app', {[mainKey]: 'corners'})).toBeNull();
        expect(resolveRule(null, {[mainKey]: 'corners'})).toBeNull();
        expect(resolveRule('', {[mainKey]: 'corners'})).toBeNull();
    });

    it('every fingerprint field participates in matching', () => {
        const base = buildRuleKey('app', {
            clientType: CLIENT_TYPE_TOKEN_WAYLAND, windowType: WindowType.NORMAL,
            hasParent: true, allowsResize: false, isAttachedDialog: false, hasSsd: false,
        });
        const rules = {[base]: 'corners'};

        expect(resolveRule('app', rules, {hasParent: true, allowsResize: false})).not.toBeNull();
        expect(resolveRule('app', rules, {clientType: CLIENT_TYPE_TOKEN_X11, windowType: WindowType.NORMAL, hasParent: true, allowsResize: false, isAttachedDialog: false})).toBeNull();
        expect(resolveRule('app', rules, {windowType: WindowType.DIALOG, hasParent: true, allowsResize: false, isAttachedDialog: false})).toBeNull();
        expect(resolveRule('app', rules, {hasParent: true, allowsResize: true, isAttachedDialog: false})).toBeNull();
        expect(resolveRule('app', rules, {hasParent: true, allowsResize: false, isAttachedDialog: true})).toBeNull();
        // has_ssd is part of the kind: an SSD window is a different kind.
        expect(resolveRule('app', rules, {hasParent: true, allowsResize: false, hasSsd: true})).toBeNull();
    });
});

describe('buildRuleKey', () => {
    it('always emits the full window-kind fingerprint', () => {
        expect(buildRuleKey('wechat')).toBe(
            `wechat:client_type=${CLIENT_TYPE_TOKEN_WAYLAND},window_type=${WindowType.NORMAL},has_parent=false,allows_resize=true,attached_dialog=false,has_ring=false,has_ssd=false`);
    });

    it('encodes every structural field', () => {
        expect(buildRuleKey('wechat', {
            clientType: CLIENT_TYPE_TOKEN_X11,
            windowType: WindowType.DIALOG,
            hasParent: true,
            allowsResize: false,
            isAttachedDialog: true,
            hasRing: true,
            hasSsd: true,
        })).toBe(`wechat:client_type=${CLIENT_TYPE_TOKEN_X11},window_type=${WindowType.DIALOG},has_parent=true,allows_resize=false,attached_dialog=true,has_ring=true,has_ssd=true`);
    });

    it('orders has_ring and has_ssd before size in the canonical key', () => {
        const key = buildRuleKey('wechat', {
            clientType: CLIENT_TYPE_TOKEN_WAYLAND,
            windowType: WindowType.NORMAL,
            hasParent: false,
            allowsResize: false,
            isAttachedDialog: false,
            hasRing: true,
            hasSsd: false,
            width: 360,
            height: 420,
        });
        expect(key).toBe(
            `wechat:client_type=${CLIENT_TYPE_TOKEN_WAYLAND},window_type=${WindowType.NORMAL},has_parent=false,allows_resize=false,attached_dialog=false,has_ring=true,has_ssd=false,size=360x420`
        );
        expect(key.indexOf('has_ring=true')).toBeLessThan(key.indexOf('has_ssd=false'));
        expect(key.indexOf('has_ssd=false')).toBeLessThan(key.indexOf('size=360x420'));
    });

    it('distinguishes Firefox main window and Picture-in-Picture window via has_ring', () => {
        const firefoxMain = buildRuleKey('firefox', {hasRing: true});
        const firefoxPip = buildRuleKey('firefox', {hasRing: false});

        expect(firefoxMain).toBe(
            `firefox:client_type=${CLIENT_TYPE_TOKEN_WAYLAND},window_type=${WindowType.NORMAL},has_parent=false,allows_resize=true,attached_dialog=false,has_ring=true,has_ssd=false`);
        expect(firefoxPip).toBe(
            `firefox:client_type=${CLIENT_TYPE_TOKEN_WAYLAND},window_type=${WindowType.NORMAL},has_parent=false,allows_resize=true,attached_dialog=false,has_ring=false,has_ssd=false`);
        expect(firefoxMain).not.toBe(firefoxPip);

        const userRules = {[firefoxMain]: 'corners,shadow'};
        expect(resolveRule('firefox', userRules, {hasRing: true})).not.toBeNull();
        expect(resolveRule('firefox', userRules, {hasRing: false})).toBeNull();
    });

    it('distinguishes an SSD window from a bare one via has_ssd', () => {
        const bare = buildRuleKey('wps', {hasSsd: false});
        const ssd = buildRuleKey('wps', {hasSsd: true});

        expect(bare).toBe(
            `wps:client_type=${CLIENT_TYPE_TOKEN_WAYLAND},window_type=${WindowType.NORMAL},has_parent=false,allows_resize=true,attached_dialog=false,has_ring=false,has_ssd=false`);
        expect(ssd).toBe(
            `wps:client_type=${CLIENT_TYPE_TOKEN_WAYLAND},window_type=${WindowType.NORMAL},has_parent=false,allows_resize=true,attached_dialog=false,has_ring=false,has_ssd=true`);
        expect(bare).not.toBe(ssd);
    });

    it('encodes size only for fixed-size windows (allowsResize=false)', () => {
        expect(buildRuleKey('wechat', {
            allowsResize: false,
            width: 360,
            height: 420,
        })).toBe(`wechat:client_type=${CLIENT_TYPE_TOKEN_WAYLAND},window_type=${WindowType.NORMAL},has_parent=false,allows_resize=false,attached_dialog=false,has_ring=false,has_ssd=false,size=360x420`);

        // Resizable windows never encode size
        expect(buildRuleKey('wechat', {
            allowsResize: true,
            width: 800,
            height: 600,
        })).toBe(`wechat:client_type=${CLIENT_TYPE_TOKEN_WAYLAND},window_type=${WindowType.NORMAL},has_parent=false,allows_resize=true,attached_dialog=false,has_ring=false,has_ssd=false`);

        // Rounds fractional sizes to integers
        expect(buildRuleKey('wechat', {
            allowsResize: false,
            width: 359.8,
            height: 420.2,
        })).toBe(`wechat:client_type=${CLIENT_TYPE_TOKEN_WAYLAND},window_type=${WindowType.NORMAL},has_parent=false,allows_resize=false,attached_dialog=false,has_ring=false,has_ssd=false,size=360x420`);
    });

    it('never collapses to a bare application key', () => {
        expect(buildRuleKey('wechat', {hasParent: false})).not.toBe('wechat');
        expect(buildRuleKey('wechat', {hasParent: true, allowsResize: false})).not.toBe('wechat');
    });

    it('empty or whitespace-only wmClass returns empty string', () => {
        expect(buildRuleKey('')).toBe('');
        expect(buildRuleKey(null)).toBe('');
        expect(buildRuleKey('   ')).toBe('');
        expect(buildRuleKey('\t\n')).toBe('');
    });
});

describe('parseRuleKey', () => {
    const key = `wechat:client_type=${CLIENT_TYPE_TOKEN_WAYLAND},window_type=${WindowType.NORMAL},has_parent=true,allows_resize=false,attached_dialog=false,has_ring=false,has_ssd=false`;

    it('parses base wmClass, specifier and typed properties', () => {
        expect(parseRuleKey(key)).toEqual({
            baseWmClass: 'wechat',
            specifier: `client_type=${CLIENT_TYPE_TOKEN_WAYLAND},window_type=${WindowType.NORMAL},has_parent=true,allows_resize=false,attached_dialog=false,has_ring=false,has_ssd=false`,
            properties: {
                client_type: CLIENT_TYPE_TOKEN_WAYLAND,
                window_type: WindowType.NORMAL,
                has_parent: true,
                allows_resize: false,
                attached_dialog: false,
                has_ring: false,
                has_ssd: false,
            },
        });
    });

    it('parses fixed-size key with dimensions', () => {
        const sizedKey = `wechat:client_type=${CLIENT_TYPE_TOKEN_WAYLAND},window_type=${WindowType.NORMAL},has_parent=false,allows_resize=false,attached_dialog=false,has_ring=false,has_ssd=false,size=360x420`;
        expect(parseRuleKey(sizedKey)).toEqual({
            baseWmClass: 'wechat',
            specifier: `client_type=${CLIENT_TYPE_TOKEN_WAYLAND},window_type=${WindowType.NORMAL},has_parent=false,allows_resize=false,attached_dialog=false,has_ring=false,has_ssd=false,size=360x420`,
            properties: {
                client_type: CLIENT_TYPE_TOKEN_WAYLAND,
                window_type: WindowType.NORMAL,
                has_parent: false,
                allows_resize: false,
                attached_dialog: false,
                has_ring: false,
                has_ssd: false,
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

    it('rejects bare app keys, truncated specifiers and unknown fields', () => {
        const invalid = [
            'wechat',
            'wechat:dialog',
            'wechat:title=Exit',
            'wechat:has_parent=true,allows_resize=false',
            'wechat:foo=bar',
            // A 6-field key from before has_ssd is no longer a kind.
            `wechat:client_type=${CLIENT_TYPE_TOKEN_WAYLAND},window_type=${WindowType.NORMAL},has_parent=false,allows_resize=true,attached_dialog=false,has_ring=false`,
            `wechat:client_type=macos,window_type=${WindowType.NORMAL},has_parent=false,allows_resize=true,attached_dialog=false,has_ring=false,has_ssd=false`,
            // Resizable window MUST NOT have size
            `wechat:client_type=${CLIENT_TYPE_TOKEN_WAYLAND},window_type=${WindowType.NORMAL},has_parent=false,allows_resize=true,attached_dialog=false,has_ring=false,has_ssd=false,size=800x600`,
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
            buildRuleKey('steam', {clientType: CLIENT_TYPE_TOKEN_X11, windowType: WindowType.MODAL_DIALOG, isAttachedDialog: true, hasSsd: true}),
        ];
        for (const key of keys) {
            const parsed = parseRuleKey(key);
            expect(`${parsed.baseWmClass}:${parsed.specifier}`).toBe(key);
        }
    });

    it('keeps every identity verbatim, splitting at the last colon', () => {
        const spec = 'client_type=wayland,window_type=0,has_parent=false,allows_resize=true,attached_dialog=false,has_ring=false,has_ssd=false';
        const identities = [
            'wechat',
            'window:1234',
            'a::b',
            'trailing:',
            '%3A',
            '应用',
            'my app',
            'comma,name',
            'equals=sign',
            'a:b=c,d:e',
        ];
        for (const identity of identities) {
            const lower = identity.toLowerCase();
            const key = buildRuleKey(identity);
            expect(key).toBe(`${lower}:${spec}`);
            expect(parseRuleKey(key).baseWmClass).toBe(lower);
        }
    });

    it('renders a non-ASCII identity as text, never percent-escaped', () => {
        const key = buildRuleKey('应用');
        expect(key.startsWith('应用:')).toBeTrue();
        expect(key).not.toContain('%');
    });

    it('lowercases an identity but changes nothing else about it', () => {
        expect(buildRuleKey('wechat').startsWith('wechat:')).toBeTrue();
        expect(buildRuleKey('org.gnome.Nautilus').startsWith('org.gnome.nautilus:')).toBeTrue();
    });

    it('prefs-generated keys match resolveRule for the picked kind only', () => {
        const picked = {hasParent: true, allowsResize: false};
        const prefsGeneratedRules = {
            [buildRuleKey('code', picked)]: 'corners,shadow',
        };
        expect(resolved(resolveRule('code', prefsGeneratedRules, picked)))
            .toBe('corners,shadow');
        expect(resolveRule('code', prefsGeneratedRules, {hasParent: true, allowsResize: true})).toBeNull();
        expect(resolveRule('code', prefsGeneratedRules)).toBeNull();
    });
});

describe('rule key invariant', () => {
    it('every value the field table renders is colon-free', () => {
        const fields = {
            clientType: 'wayland',
            windowType: 0,
            hasParent: false,
            allowsResize: true,
            isAttachedDialog: false,
            hasRing: false,
            hasSsd: false,
        };
        for (const field of FINGERPRINT_FIELDS)
            expect(String(field.render(fields))).not.toContain(':');
    });

    it('refuses a specifier carrying a colon rather than mis-splitting it', () => {
        expect(() => buildRuleKey('app', {clientType: 'wayland:x11'})).toThrow();
    });
});

describe('rule key casing and order', () => {
    it('lowercases with toLowerCase, never a locale variant', () => {
        const dottedI = '\u0130'; // İ: toLowerCase gives 'i' + U+0307, Turkish toLocaleLowerCase gives 'i'.
        expect(dottedI.toLowerCase()).toBe('i\u0307');
        const turkish = dottedI.toLocaleLowerCase('tr');
        expect(turkish).not.toBe(dottedI.toLowerCase());

        const original = String.prototype.toLocaleLowerCase;
        String.prototype.toLocaleLowerCase = () => {
            throw new Error('a rule key must not lowercase through the locale');
        };
        try {
            const key = buildRuleKey(dottedI);
            expect(key.startsWith(`${dottedI.toLowerCase()}:`)).toBeTrue();
            expect(key).not.toBe(buildRuleKey(turkish));
        } finally {
            String.prototype.toLocaleLowerCase = original;
        }
    });

    it('sorts by code point with the identity first, never by locale collation', () => {
        const a = buildRuleKey('Ärger'); // 'Ä' = U+00C4
        const z = buildRuleKey('Zulu');  // 'Z' = U+005A
        expect(z < a).toBeTrue();
        expect([a, z].sort()).toEqual([z, a]);
        // German collation puts 'Ä' with 'A', before 'Z' - the opposite order. The key's order
        // is the code-point one, so nothing in the chain may use localeCompare.
        expect(a.localeCompare(z, 'de')).toBeLessThan(0);
    });
});

describe('one canonical key per kind', () => {
    it('picker, prefs and import agree, and sanitising is idempotent', () => {
        const props = {
            wmClass: 'WeChat',
            clientType: 'wayland',
            windowType: '0',
            hasParent: 'false',
            allowsResize: 'false',
            isAttachedDialog: 'false',
            hasRing: 'false',
            hasSsd: 'false',
            width: '360',
            height: '420',
        };
        const expected = buildRuleKey('wechat', {allowsResize: false, width: 360, height: 420});
        expect(buildRuleKeyFromProperties(props)).toBe(expected);

        const sep = expected.lastIndexOf(':');
        const handSpelled = `${expected.slice(0, sep).toUpperCase()}:${expected.slice(sep + 1)}`;
        const sanitized = sanitizeWindowRules({[handSpelled]: 'corners'});
        expect(sanitized).toEqual({[expected]: 'corners'});
        expect(sanitizeWindowRules(sanitized)).toEqual(sanitized);
    });
});

describe('sanitizeWindowRules', () => {
    const mainKey = buildRuleKey('wechat');
    const childKey = buildRuleKey('wechat', {hasParent: true, allowsResize: false});

    it('canonicalises the axis order of a stored state', () => {
        const input = {
            [mainKey]: 'corners',
            [childKey]: 'corners,shadow',
            [buildRuleKey('resize-app')]: 'shadow,resize',
        };
        expect(sanitizeWindowRules(input)).toEqual({
            [mainKey]: 'corners',
            [childKey]: 'corners,shadow',
            [buildRuleKey('resize-app')]: 'shadow,resize',
        });
    });

    it('drops bare app keys, truncated specifiers and malformed keys', () => {
        const input = {
            [mainKey]: 'corners',
            'wechat': 'corners',
            'wechat:dialog': 'corners',
            'wechat:title=Exit': 'corners',
            'wechat:has_parent=true,allows_resize=false': 'corners',
            'invalid:key:too:many:colons': 'corners',
            // #99: an identity with a space is no longer a reason to drop a key, so that entry is
            // gone from this input; the derived window_type below is #100's change.
            [`bad:client_type=macos,window_type=${WindowType.NORMAL},has_parent=false,allows_resize=true,attached_dialog=false,has_ring=false,has_ssd=false`]: 'corners',
            [buildRuleKey('valid_app')]: 123,
        };
        expect(sanitizeWindowRules(input)).toEqual({[mainKey]: 'corners'});
    });

    it('keeps identities the old grammar escaped, verbatim', () => {
        const spaced = buildRuleKey('my app');
        const colon = buildRuleKey('window:5');
        expect(sanitizeWindowRules({[spaced]: 'corners', [colon]: 'shadow'}))
            .toEqual({[spaced]: 'corners', [colon]: 'shadow'});
    });

    it('drops entries naming an invalid state, including "nothing reversed"', () => {
        const input = {
            [mainKey]: 'corners',
            [childKey]: 'not-a-valid-mode',
            [buildRuleKey('legacy-all')]: 'both',
            [buildRuleKey('legacy-axes')]: 'corners=on',
            [buildRuleKey('empty')]: '',
        };
        expect(sanitizeWindowRules(input)).toEqual({[mainKey]: 'corners'});
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
            [canonical]: 'corners,shadow',
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

describe('sanitizeRuleTitles', () => {
    const key = buildRuleKey('wechat', {});
    const specifier = key.slice(key.indexOf(':') + 1);

    it('canonicalises the key the same way the states are', () => {
        // A hand-edited or legacy mixed-case identity must land under the lowercased key, or
        // readEntries() pairs it with the canonical state and loses the title on the next write.
        expect(sanitizeRuleTitles({[`WeChat:${specifier}`]: 'WeChat'})).toEqual({[key]: 'WeChat'});
    });

    it('drops one of a case-colliding pair', () => {
        const titles = sanitizeRuleTitles({
            [`WeChat:${specifier}`]: 'A',
            [`wechat:${specifier}`]: 'B',
        });
        expect(Object.keys(titles)).toEqual([key]);
    });

    it('still rejects a malformed key or a blank title', () => {
        expect(sanitizeRuleTitles({'not a key': 'x'})).toEqual({});
        expect(sanitizeRuleTitles({[key]: '   '})).toEqual({});
    });
});

describe('withRule', () => {
    const key = buildRuleKey('wechat', {hasParent: true});

    it('stores the canonical form of the state it was given', () => {
        expect(withRule({}, key, 'corners')).toEqual({[key]: 'corners'});
        expect(withRule({}, key, 'corners,shadow')).toEqual({[key]: 'corners,shadow'});
        expect(withRule({}, key, 'shadow,resize')).toEqual({[key]: 'shadow,resize'});
    });

    it('removes the key when nothing is reversed: no rule', () => {
        expect(withRule({[key]: 'corners'}, key, '')).toEqual({});
    });

    it('replaces the state already stored for the kind', () => {
        const stored = buildRuleKey('WeChat', {hasParent: true});
        const updated = withRule({[stored]: 'corners'}, key, 'corners,shadow');
        expect(updated).toEqual({[key]: 'corners,shadow'});
    });

    it('leaves the rule map it was given untouched', () => {
        const rules = {[key]: 'shadow'};
        withRule(rules, key, 'corners');
        expect(rules).toEqual({[key]: 'shadow'});
    });

    it('refuses anything outside the axis grammar', () => {
        expect(() => withRule({}, key, 'shadow,corners')).toThrow();
        expect(() => withRule({}, key, 'corners=on')).toThrow();
        expect(() => withRule({}, key, 'both')).toThrow();
        expect(() => withRule({}, key, undefined)).toThrow();
    });
});
