/**
 * settings layer unit tests (jasmine-gjs).
 * Run: pnpm test
 */

import {
    buildRuleKey,
} from '../src/lib/rules.js';
import {
    getRuleTitles, getWindowRules, setWindowRule, setWindowRules,
    exportRulesJson, importRulesJson, applyConflictResolutions,
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

describe('importRulesJson & exportRulesJson', () => {
    const keyWechat = buildRuleKey('wechat');
    const keyFirefox = buildRuleKey('firefox');

    it('exports entries to canonical JSON format', () => {
        const entries = {
            [keyWechat]: {state: 'corners', title: 'WeChat'},
            [keyFirefox]: {state: 'shadow', title: 'Firefox'},
        };
        const json = exportRulesJson(entries);
        const parsed = JSON.parse(json);
        expect(parsed.version).toBe(1);
        expect(parsed.rules[keyWechat]).toEqual({state: 'corners', title: 'WeChat'});
        expect(parsed.rules[keyFirefox]).toEqual({state: 'shadow', title: 'Firefox'});
    });

    it('throws error on empty or invalid JSON', () => {
        expect(() => importRulesJson({}, '')).toThrowError(/Empty clipboard/);
        expect(() => importRulesJson({}, 'not a json')).toThrowError(/Invalid JSON/);
        expect(() => importRulesJson({}, '{}')).toThrowError(/No rules found/);
        expect(() => importRulesJson({}, '{"rules": {}}')).toThrowError(/No rules found/);
    });

    it('imports new rules into empty entries', () => {
        const payload = JSON.stringify({
            version: 1,
            rules: {
                [keyWechat]: {state: 'corners', title: 'WeChat'},
            },
        });
        const res = importRulesJson({}, payload);
        expect(res.hasConflicts).toBeFalse();
        expect(res.addedCount).toBe(1);
        expect(res.updatedCount).toBe(0);
        expect(res.nextEntries[keyWechat]).toEqual({
            state: 'corners',
            title: 'WeChat',
        });
        expect(res.importedKeys).toEqual([keyWechat]);
    });

    it('detects conflict when imported state differs from existing state', () => {
        const initial = {
            [keyWechat]: {state: 'corners', title: 'My WeChat'},
        };
        const payload = JSON.stringify({
            rules: {
                [keyWechat]: {state: 'corners,shadow', title: 'Community WeChat'},
            },
        });
        const res = importRulesJson(initial, payload);
        expect(res.hasConflicts).toBeTrue();
        expect(res.conflicts.length).toBe(1);
        expect(res.conflicts[0]).toEqual({
            key: keyWechat,
            existingState: 'corners',
            importedState: 'corners,shadow',
            existingTitle: 'My WeChat',
            importedTitle: 'Community WeChat',
        });
        expect(res.nonConflictingEntries).toEqual(initial);
        expect(res.cleanImported[keyWechat]).toEqual({
            state: 'corners,shadow',
            title: 'Community WeChat',
        });
        expect(res.importedKeys).toEqual([keyWechat]);
    });

    it('does not detect conflict when imported state matches existing state and respects idempotency', () => {
        const initial = {
            [keyWechat]: {state: 'corners', title: 'My WeChat'},
        };
        const payload = JSON.stringify({
            rules: {
                [keyWechat]: {state: 'corners', title: 'Community WeChat'},
            },
        });
        const res = importRulesJson(initial, payload);
        expect(res.hasConflicts).toBeFalse();
        expect(res.addedCount).toBe(0);
        expect(res.updatedCount).toBe(0); // Idempotent: existing title preserved, no update
        expect(res.nextEntries[keyWechat]).toEqual(initial[keyWechat]);
        expect(res.importedKeys).toEqual([keyWechat]);
    });

    it('supplements missing title on matching existing rule and counts as update', () => {
        const initial = {
            [keyWechat]: {state: 'corners', title: ''},
        };
        const payload = JSON.stringify({
            rules: {
                [keyWechat]: {state: 'corners', title: 'Community Title'},
            },
        });
        const res = importRulesJson(initial, payload);
        expect(res.hasConflicts).toBeFalse();
        expect(res.addedCount).toBe(0);
        expect(res.updatedCount).toBe(1);
        expect(res.nextEntries[keyWechat].title).toBe('Community Title');
    });

    it('handles compound imports with both new rules and conflicting existing rules', () => {
        const initial = {
            [keyWechat]: {state: 'corners', title: 'Local WeChat'},
        };
        const payload = JSON.stringify({
            rules: {
                [keyWechat]: {state: 'corners,shadow', title: 'Community WeChat'},
                [keyFirefox]: {state: 'shadow', title: 'Community Firefox'},
            },
        });
        const res = importRulesJson(initial, payload);
        expect(res.hasConflicts).toBeTrue();
        expect(res.conflicts.length).toBe(1);
        expect(res.conflicts[0].key).toBe(keyWechat);
        expect(res.nonConflictingEntries[keyFirefox]).toEqual({
            state: 'shadow',
            title: 'Community Firefox',
        });
        expect(res.nonConflictingEntries[keyWechat]).toEqual(initial[keyWechat]);
    });

    it('supports flat JSON object and string state shorthand', () => {
        const payload = JSON.stringify({
            [keyFirefox]: 'shadow',
        });
        const res = importRulesJson({}, payload);
        expect(res.hasConflicts).toBeFalse();
        expect(res.addedCount).toBe(1);
        expect(res.nextEntries[keyFirefox]).toEqual({
            state: 'shadow',
            title: '',
        });
    });

    it('filters out invalid rule keys while keeping valid ones', () => {
        const payload = JSON.stringify({
            rules: {
                [keyFirefox]: {state: 'shadow', title: 'Valid'},
                'invalid:key:format': {state: 'corners'},
            },
        });
        const res = importRulesJson({}, payload);
        expect(res.hasConflicts).toBeFalse();
        expect(res.addedCount).toBe(1);
        expect(res.nextEntries[keyFirefox]).toBeDefined();
        expect(res.nextEntries['invalid:key:format']).toBeUndefined();
    });

    it('throws error when all provided rules are invalid', () => {
        const payload = JSON.stringify({
            rules: {
                'invalid:key': {state: 'corners'},
                'another:bad:key': {state: 'shadow'},
            },
        });
        expect(() => importRulesJson({}, payload)).toThrowError(/No valid rules found/);
    });
});

describe('applyConflictResolutions', () => {
    const keyWechat = buildRuleKey('wechat');
    const keyFirefox = buildRuleKey('firefox');

    const existingEntries = {
        [keyWechat]: {state: 'corners', title: 'My WeChat'},
    };
    const nonConflicting = {
        [keyFirefox]: {state: 'shadow', title: 'Firefox'},
    };
    const cleanImported = {
        [keyWechat]: {state: 'corners,shadow', title: 'Imported WeChat'},
    };

    it('applies imported rule when choice is imported', () => {
        const res = applyConflictResolutions(
            existingEntries,
            nonConflicting,
            cleanImported,
            {[keyWechat]: 'imported'}
        );
        expect(res.resolvedUpdatedCount).toBe(1);
        expect(res.nextEntries[keyWechat]).toEqual({
            state: 'corners,shadow',
            title: 'Imported WeChat',
        });
        expect(res.nextEntries[keyFirefox]).toEqual(nonConflicting[keyFirefox]);
    });

    it('preserves existing rule when choice is existing', () => {
        const res = applyConflictResolutions(
            existingEntries,
            nonConflicting,
            cleanImported,
            {[keyWechat]: 'existing'}
        );
        expect(res.resolvedUpdatedCount).toBe(0);
        expect(res.nextEntries[keyWechat]).toEqual(existingEntries[keyWechat]);
        expect(res.nextEntries[keyFirefox]).toEqual(nonConflicting[keyFirefox]);
    });
});

describe('setWindowRule storage purity', () => {
    const key = buildRuleKey('wechat');

    function createMockSettings(initialEntries = {}) {
        let stored = initialEntries;
        return {
            get_value() {
                return {
                    deep_unpack() {
                        const out = {};
                        for (const [k, v] of Object.entries(stored)) {
                            out[k] = {...v};
                        }
                        return out;
                    },
                    equal() {
                        return false;
                    },
                };
            },
            set_value(_k, val) {
                stored = val.deep_unpack();
            },
            getStored() {
                return stored;
            },
        };
    }

    it('stores a rule strictly with state and title (100% clean schema)', () => {
        const settings = createMockSettings();
        setWindowRule(settings, key, 'corners', 'Local WeChat');
        const stored = settings.getStored();
        expect(stored[key]).toEqual({
            state: 'corners',
            title: 'Local WeChat',
        });
    });

    it('updates rule cleanly without extra metadata fields', () => {
        const settings = createMockSettings({
            [key]: {state: 'corners', title: 'Old WeChat'},
        });
        setWindowRule(settings, key, 'corners,shadow', 'New WeChat');
        const stored = settings.getStored();
        expect(stored[key]).toEqual({
            state: 'corners,shadow',
            title: 'New WeChat',
        });
    });
});

