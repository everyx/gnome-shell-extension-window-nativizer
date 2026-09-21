/**
 * settings layer unit tests (jasmine-gjs).
 * Run: pnpm test
 */

import {
    buildRuleKey,
} from '../src/lib/rules.js';
import {
    getRuleTitles, getWindowRules, setWindowRule, setWindowRules,
    SETTINGS_KEY_WINDOW_RULES,
} from '../src/lib/settings.js';

describe('getWindowRules', () => {
    const validKey = buildRuleKey('wechat', {hasParent: true, allowsResize: false});

    it('unpacks and sanitizes the rule map from mock settings', () => {
        const mockSettings = {
            get_value: (key) => {
                if (key === SETTINGS_KEY_WINDOW_RULES) {
                    return {
                        deep_unpack: () => ({
                            [validKey]: {state: 'corners', title: 'Chat'},
                            'bad:foo=bar': {state: 'corners'},
                            [buildRuleKey('legacy-shape')]: {state: 'shadow,corners'},
                        }),
                    };
                }
                return null;
            },
        };
        expect(getWindowRules(mockSettings)).toEqual({[validKey]: 'corners'});
    });

    it('returns an empty map on null or throwing settings', () => {
        expect(getWindowRules(null)).toEqual({});
        expect(getWindowRules({})).toEqual({});
        expect(getWindowRules({
            get_value: () => {
                throw new Error('boom');
            },
        })).toEqual({});
    });
});

describe('setWindowRules', () => {
    it('sanitizes and writes the GSettings key', () => {
        const saved = new Map();
        const mockSettings = {
            set_value: (key, val) => {
                saved.set(key, val);
            },
        };
        setWindowRules(mockSettings, {
            [buildRuleKey('wechat')]: 'corners',
            'invalid:key': 'corners',
            [buildRuleKey('wechat-app')]: 'shadow,corners',
        });

        expect(saved.has(SETTINGS_KEY_WINDOW_RULES)).toBeTrue();
        expect(saved.get(SETTINGS_KEY_WINDOW_RULES).deep_unpack()).toEqual({
            [buildRuleKey('wechat')]: {state: 'corners', title: ''},
        });
    });

    it('skips writing when the stored value already matches', () => {
        let writes = 0;
        const mockSettings = {
            get_value: () => ({equal: () => true}),
            set_value: () => { writes++; },
        };
        setWindowRules(mockSettings, {[buildRuleKey('wechat')]: 'corners'});
        expect(writes).toBe(0);
    });

    it('writes when the stored value differs', () => {
        let writes = 0;
        const mockSettings = {
            get_value: () => ({equal: () => false}),
            set_value: () => { writes++; },
        };
        setWindowRules(mockSettings, {[buildRuleKey('wechat')]: 'corners'});
        expect(writes).toBe(1);
    });
});

describe('rule titles', () => {
    const validKey = buildRuleKey('wechat');
    const reading = entries => ({
        get_value: () => ({deep_unpack: () => entries, equal: () => false}),
    });

    it('reads a title beside its state, and only for a key that is a rule key', () => {
        const entries = {
            [validKey]: {state: 'corners', title: '  登录\n对话框  '},
            'bad:foo=bar': {state: 'corners', title: 'not a rule key'},
        };
        expect(getWindowRules(reading(entries))).toEqual({[validKey]: 'corners'});
        expect(getRuleTitles(reading(entries))).toEqual({[validKey]: '登录 对话框'});
    });

    it('keeps a long title whole: the row ellipsizes it by width, not by length', () => {
        const long = 'y'.repeat(200);
        expect(getRuleTitles(reading({[validKey]: {state: 'corners', title: long}}))[validKey])
            .toBe(long);
    });

    it('never lets a title reach the state, so matching cannot see it', () => {
        const titles = getRuleTitles(reading({[validKey]: {state: 'corners', title: 'Login'}}));
        expect(titles[validKey]).toBe('Login');
        expect(JSON.stringify(getWindowRules(reading({
            [validKey]: {state: 'corners', title: 'Login'},
        })))).not.toContain('Login');
    });

    it('writes a title into the same entry, keeping the state', () => {
        const saved = new Map();
        const mockSettings = {
            get_value: () => ({
                deep_unpack: () => ({[validKey]: {state: 'corners', title: ''}}),
                equal: () => false,
            }),
            set_value: (key, val) => saved.set(key, val),
        };
        setWindowRule(mockSettings, validKey, 'corners', 'Login');
        expect(saved.get(SETTINGS_KEY_WINDOW_RULES).deep_unpack())
            .toEqual({[validKey]: {state: 'corners', title: 'Login'}});
    });

    it('keeps a title across a state-only write', () => {
        const saved = new Map();
        const mockSettings = {
            get_value: () => ({
                deep_unpack: () => ({[validKey]: {state: 'corners', title: 'Login'}}),
                equal: () => false,
            }),
            set_value: (key, val) => saved.set(key, val),
        };
        setWindowRules(mockSettings, {[validKey]: 'shadow'});
        expect(saved.get(SETTINGS_KEY_WINDOW_RULES).deep_unpack())
            .toEqual({[validKey]: {state: 'shadow', title: 'Login'}});
    });

    it('drops a title with its rule, so display metadata cannot outlive it', () => {
        const kept = buildRuleKey('wechat');
        const orphan = buildRuleKey('wechat-app');
        const saved = new Map();
        const mockSettings = {
            get_value: () => ({
                deep_unpack: () => ({
                    [kept]: {state: 'corners', title: 'Chat'},
                    [orphan]: {state: 'shadow', title: 'Old'},
                }),
                equal: () => false,
            }),
            set_value: (key, val) => saved.set(key, val),
        };
        setWindowRules(mockSettings, {[kept]: 'corners'});
        expect(saved.get(SETTINGS_KEY_WINDOW_RULES).deep_unpack())
            .toEqual({[kept]: {state: 'corners', title: 'Chat'}});
    });

    it('returns empty maps on null or throwing settings', () => {
        expect(getRuleTitles(null)).toEqual({});
        expect(getWindowRules(null)).toEqual({});
    });
});
