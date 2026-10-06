/**
 * rule model unit tests: kinds, states and resolution (jasmine-gjs).
 * Run: pnpm test
 */

import {
    WindowType,
} from '../src/lib/mutterRules.generated.js';
import {
    RuleAxis, RULE_AXES, parseRuleState, buildRuleState,
    resolveRule, kindFromProperties, kindId, sameKind, sanitizeRules,
} from '../src/lib/rules.js';

/** Comparable shape for a resolveRule() result: canonical stored form. */
function resolved(result) {
    return result && buildRuleState(result);
}

/** A kind with the defaults every case shares, overridden as needed. */
function kind(identity, overrides = {}) {
    return {
        identity,
        clientType: 'wayland',
        windowType: WindowType.NORMAL,
        hasParent: false,
        allowsResize: true,
        attachedDialog: false,
        hasRing: false,
        hasSsd: false,
        width: null,
        height: null,
        ...overrides,
    };
}

/** One stored record, using the flat field names the settings layer writes. */
function record(identity, state, overrides = {}) {
    const k = kind(identity, overrides);
    return {
        identity: k.identity,
        client_type: k.clientType,
        window_type: k.windowType,
        has_parent: k.hasParent,
        allows_resize: k.allowsResize,
        attached_dialog: k.attachedDialog,
        has_ring: k.hasRing,
        has_ssd: k.hasSsd,
        width: k.width ?? 0,
        height: k.height ?? 0,
        state,
        title: '',
    };
}

/** The sanitized array resolveRule consumes. */
function rulesOf(...records) {
    return sanitizeRules(records);
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

    it('the three axes are the whole grammar, in canonical order', () => {
        expect([...RULE_AXES]).toEqual(['corners', 'shadow', 'resize']);
        expect(RuleAxis.CORNERS).toBe('corners');
        expect(RuleAxis.SHADOW).toBe('shadow');
        expect(RuleAxis.RESIZE).toBe('resize');
    });
});

describe('kindFromProperties', () => {
    it('builds the full kind from the picker wire map', () => {
        expect(kindFromProperties({
            wmClass: 'wechat',
            clientType: 'x11',
            windowType: String(WindowType.MODAL_DIALOG),
            hasParent: 'true',
            allowsResize: 'true',
            isAttachedDialog: 'true',
            hasRing: 'true',
            hasSsd: 'true',
        })).toEqual({
            identity: 'wechat',
            clientType: 'x11',
            windowType: WindowType.MODAL_DIALOG,
            hasParent: true,
            allowsResize: true,
            attachedDialog: true,
            hasRing: true,
            hasSsd: true,
            width: null,
            height: null,
        });
    });

    it('defaults a missing client type to Wayland and a missing type to normal', () => {
        expect(kindFromProperties({wmClass: 'wechat'})).toEqual({
            identity: 'wechat',
            clientType: 'wayland',
            windowType: WindowType.NORMAL,
            hasParent: false,
            allowsResize: false,
            attachedDialog: false,
            hasRing: false,
            hasSsd: false,
            width: null,
            height: null,
        });
    });

    it('carries width/height only for fixed-size windows', () => {
        expect(kindFromProperties({
            wmClass: 'wechat', allowsResize: 'false', width: '360', height: '420',
        }).width).toBe(360);
        expect(kindFromProperties({
            wmClass: 'wechat', allowsResize: 'false', width: '360', height: '420',
        }).height).toBe(420);
        // A resizable window's size is not stable, so it is not part of the kind.
        const resizable = kindFromProperties({
            wmClass: 'wechat', allowsResize: 'true', width: '800', height: '600',
        });
        expect(resizable.width).toBeNull();
        expect(resizable.height).toBeNull();
    });

    it('returns null when nothing identifies the window', () => {
        expect(kindFromProperties({})).toBeNull();
        expect(kindFromProperties({wmClass: ''})).toBeNull();
        expect(kindFromProperties({wmClass: '   '})).toBeNull();
        expect(kindFromProperties({wmClass: 42})).toBeNull();
    });
});

describe('kindId and sameKind', () => {
    it('kindId is a stable UI key that ignores identity case', () => {
        expect(kindId(kind('wechat'))).toBe(kindId(kind('wechat')));
        expect(kindId(kind('WeChat'))).toBe(kindId(kind('wechat')));
        expect(kindId(kind('wechat'))).not.toBe(kindId(kind('firefox')));
        expect(kindId(kind('wechat'))).not.toBe(kindId(kind('wechat', {hasRing: true})));
        expect(kindId(null)).toBe('');
    });

    it('sameKind compares every field, identity case-insensitively', () => {
        expect(sameKind(kind('WeChat'), kind('wechat'))).toBeTrue();
        expect(sameKind(kind('wechat'), kind('wechat', {allowsResize: false}))).toBeFalse();
        expect(sameKind(kind('wechat'), kind('wechat', {hasSsd: true}))).toBeFalse();
        expect(sameKind(kind('wechat', {width: 1, height: 2}), kind('wechat', {width: 1, height: 3}))).toBeFalse();
        expect(sameKind(null, kind('wechat'))).toBeFalse();
        expect(sameKind(kind('wechat'), null)).toBeFalse();
    });
});

describe('resolveRule', () => {
    it('matches the exact kind and returns the reversed axes', () => {
        const rules = rulesOf(
            record('wechat', 'corners'),
            record('wechat', 'corners,shadow', {hasParent: true, allowsResize: false}),
        );
        expect(resolved(resolveRule(kind('wechat'), rules))).toBe('corners');
        expect(resolved(resolveRule(kind('wechat', {hasParent: true, allowsResize: false}), rules)))
            .toBe('corners,shadow');
    });

    it('an unnamed axis is not in the result: it follows the decision', () => {
        const rules = rulesOf(record('wechat', 'shadow'));
        expect([...resolveRule(kind('wechat'), rules)]).toEqual(['shadow']);
    });

    it('does not fall back to the application: a different window kind of the same app does not match', () => {
        const rules = rulesOf(record('wechat', 'corners,shadow', {hasParent: true, allowsResize: false}));

        expect(resolveRule(kind('wechat'), rules)).toBeNull();
        expect(resolveRule(kind('wechat', {hasParent: true, allowsResize: true}), rules)).toBeNull();
        expect(resolveRule(kind('wechat', {clientType: 'x11', hasParent: true, allowsResize: false}), rules)).toBeNull();
        expect(resolveRule(kind('wechat', {windowType: WindowType.DIALOG, hasParent: true, allowsResize: false}), rules)).toBeNull();
    });

    it('matches an identity whatever case the window spells it in', () => {
        const upper = rulesOf(record('WeChat', 'corners,shadow', {hasParent: true, allowsResize: false}));
        expect(resolved(resolveRule(kind('wechat', {hasParent: true, allowsResize: false}), upper)))
            .toBe('corners,shadow');

        const lower = rulesOf(record('wechat', 'corners,shadow', {hasParent: true, allowsResize: false}));
        expect(resolved(resolveRule(kind('WeChat', {hasParent: true, allowsResize: false}), lower)))
            .toBe('corners,shadow');
    });

    it('exact size match distinguishes fixed-size windows of the same kind', () => {
        const rules = rulesOf(
            record('wechat', 'corners,shadow', {allowsResize: false, width: 360, height: 420}),
            record('wechat', 'corners,shadow,resize', {allowsResize: false, width: 240, height: 48}),
        );

        expect(resolved(resolveRule(kind('wechat', {allowsResize: false, width: 360, height: 420}), rules)))
            .toBe('corners,shadow');
        expect(resolved(resolveRule(kind('wechat', {allowsResize: false, width: 240, height: 48}), rules)))
            .toBe('corners,shadow,resize');
        // Another size of the same kind does not match an exact-size rule.
        expect(resolveRule(kind('wechat', {allowsResize: false, width: 500, height: 300}), rules)).toBeNull();
    });

    it('falls back to a size-less rule when the exact size is absent', () => {
        const rules = rulesOf(
            record('wechat', 'corners', {allowsResize: false}),
            record('wechat', 'corners,shadow', {allowsResize: false, width: 360, height: 420}),
        );

        expect(resolved(resolveRule(kind('wechat', {allowsResize: false, width: 360, height: 420}), rules)))
            .toBe('corners,shadow');
        expect(resolved(resolveRule(kind('wechat', {allowsResize: false, width: 600, height: 400}), rules)))
            .toBe('corners');
    });

    it('no match returns null', () => {
        const rules = rulesOf(record('wechat', 'corners'));
        expect(resolveRule(kind('unknown-app'), rules)).toBeNull();
        expect(resolveRule(kind(''), rules)).toBeNull();
        expect(resolveRule(null, rules)).toBeNull();
        expect(resolveRule(kind('wechat'), [])).toBeNull();
    });

    it('every kind field participates in matching', () => {
        const rules = rulesOf(record('app', 'corners', {hasParent: true, allowsResize: false}));
        const base = {hasParent: true, allowsResize: false};

        expect(resolveRule(kind('app', base), rules)).not.toBeNull();
        expect(resolveRule(kind('app', {...base, clientType: 'x11'}), rules)).toBeNull();
        expect(resolveRule(kind('app', {...base, windowType: WindowType.DIALOG}), rules)).toBeNull();
        expect(resolveRule(kind('app', {...base, allowsResize: true}), rules)).toBeNull();
        expect(resolveRule(kind('app', {...base, attachedDialog: true}), rules)).toBeNull();
        expect(resolveRule(kind('app', {...base, hasRing: true}), rules)).toBeNull();
        // has_ssd is part of the kind: an SSD window is a different kind.
        expect(resolveRule(kind('app', {...base, hasSsd: true}), rules)).toBeNull();
    });
});

describe('sanitizeRules', () => {
    it('canonicalises the axis order and keeps the kind', () => {
        const rules = sanitizeRules([
            record('wechat', 'corners'),
            record('wechat', 'corners,shadow', {hasParent: true, allowsResize: false}),
            record('resize-app', 'shadow,resize'),
        ]);
        expect(rules).toEqual([
            {kind: kind('wechat'), state: 'corners', title: ''},
            {kind: kind('wechat', {hasParent: true, allowsResize: false}), state: 'corners,shadow', title: ''},
            {kind: kind('resize-app'), state: 'shadow,resize', title: ''},
        ]);
    });

    it('drops records that cannot describe a kind', () => {
        const good = record('valid_app', 'corners');
        const bad = [
            null,
            'not a record',
            {...good, identity: ''},
            {...good, client_type: 'macos'},
            {...good, window_type: '0'},
            {...good, has_parent: 'true'},
            {...good, width: 'wide'},
            // width/height may only be a pair, and only on a fixed-size window.
            {...good, allows_resize: true, width: 360, height: 420},
            {...good, allows_resize: false, width: 360, height: 0},
        ];
        expect(sanitizeRules([good, ...bad])).toEqual([{kind: kind('valid_app'), state: 'corners', title: ''}]);
    });

    it('drops a state that reverses nothing, and an invalid one', () => {
        const rules = sanitizeRules([
            record('wechat', 'corners'),
            record('empty', ''),
            record('legacy-all', 'both'),
            record('legacy-axes', 'corners=on'),
            record('misordered', 'shadow,corners'),
        ]);
        expect(rules).toEqual([{kind: kind('wechat'), state: 'corners', title: ''}]);
    });

    it('deduplicates on the kind, first wins, identity case-insensitively', () => {
        const rules = sanitizeRules([
            record('WeChat', 'corners'),
            record('wechat', 'corners,shadow'),
        ]);
        expect(rules).toEqual([{kind: kind('WeChat'), state: 'corners', title: ''}]);
    });

    it('folds the sample title to one line', () => {
        const rules = sanitizeRules([{...record('wechat', 'corners'), title: '  登录\n对话框  '}]);
        expect(rules[0].title).toBe('登录 对话框');
    });

    it('handles non-array input as an empty list', () => {
        expect(sanitizeRules(undefined)).toEqual([]);
        expect(sanitizeRules(null)).toEqual([]);
        expect(sanitizeRules('string')).toEqual([]);
        expect(sanitizeRules({})).toEqual([]);
        expect(sanitizeRules([])).toEqual([]);
    });
});

describe('kind contract & round-trip', () => {
    it('a valid kind survives sanitize -> resolve', () => {
        const stored = record('wechat', 'corners,shadow', {allowsResize: false, width: 360, height: 420});
        const rules = sanitizeRules([stored]);
        expect(rules.length).toBe(1);
        expect(resolved(resolveRule(rules[0].kind, rules))).toBe('corners,shadow');
        // The identity the picker sent resolves from the kind the store kept.
        expect(resolved(resolveRule(kind('wechat', {allowsResize: false, width: 360, height: 420}), rules)))
            .toBe('corners,shadow');
    });

    it('prefs-generated kinds match resolveRule for the picked kind only', () => {
        const picked = {hasParent: true, allowsResize: false};
        const prefsGenerated = sanitizeRules([record('code', 'corners,shadow', picked)]);

        expect(resolved(resolveRule(kind('code', picked), prefsGenerated))).toBe('corners,shadow');
        expect(resolveRule(kind('code', {hasParent: true, allowsResize: true}), prefsGenerated)).toBeNull();
        expect(resolveRule(kind('code'), prefsGenerated)).toBeNull();
    });
});
