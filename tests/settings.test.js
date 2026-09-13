/**
 * settings layer unit tests (jasmine-gjs).
 * Run: pnpm test
 */

import {
    buildRuleKey,
} from '../src/lib/rules.js';
import {
    getWindowRules, setWindowRules, SETTINGS_KEY_WINDOW_RULES,
} from '../src/lib/settings.js';

describe('getWindowRules', () => {
    const validKey = buildRuleKey('wechat', {hasParent: true, allowsResize: false});

    it('unpacks and sanitizes the rule map from mock settings', () => {
        const mockSettings = {
            get_value: (key) => {
                if (key === SETTINGS_KEY_WINDOW_RULES) {
                    return {
                        deep_unpack: () => ({
                            [validKey]: 'corners',
                            'bad:foo=bar': 'both',
                            [buildRuleKey('legacy-shape')]: 'shadow,corners',
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
            [buildRuleKey('wechat')]: 'corners',
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
