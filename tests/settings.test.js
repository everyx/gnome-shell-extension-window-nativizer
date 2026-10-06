/**
 * settings layer unit tests (jasmine-gjs).
 * Run: pnpm test
 */

import {kindId, kindFromProperties} from '../src/lib/rules.js';
import {
    getRuleTitles, getWindowRules, readEntries, setWindowRule, setAllRuleEntries,
    exportRulesJson, importRulesJson, applyConflictResolutions,
    SETTINGS_KEY_WINDOW_RULES,
} from '../src/lib/settings.js';

/** A kind with the defaults every case shares. */
function kind(identity, overrides = {}) {
    return {
        identity,
        clientType: 'wayland',
        windowType: 0,
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

/** The flat stored record for a kind. */
function record(identity, state, overrides = {}, title = '') {
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
        title,
    };
}

/** The in-memory entry shape. */
function entry(identity, state, title = '', overrides = {}) {
    return {kind: kind(identity, overrides), state, title};
}

/** A `v` value is wrapped in the stored variant; recursiveUnpack flattens it. */
function unpack(value) {
    if (typeof value.recursiveUnpack === 'function')
        return value.recursiveUnpack();
    return value.deep_unpack();
}

/** GSettings double backed by a plain record array. */
function createMockSettings(initialRecords = []) {
    let stored = initialRecords;
    const writes = [];
    return {
        get_value(key) {
            if (key !== SETTINGS_KEY_WINDOW_RULES)
                return null;
            return {
                deep_unpack: () => stored,
                equal: other => JSON.stringify(unpack(other)) === JSON.stringify(stored),
            };
        },
        set_value(key, value) {
            writes.push(key);
            stored = unpack(value);
        },
        getStored: () => stored,
        getWrites: () => writes,
    };
}

describe('readEntries / getWindowRules', () => {
    it('unpacks and sanitizes the stored record array', () => {
        const mockSettings = createMockSettings([
            record('wechat', 'corners', {hasParent: true, allowsResize: false}, 'Chat'),
            {...record('bad', 'corners'), client_type: 'macos'},
            {...record('legacy-shape', 'shadow,corners')},
        ]);

        expect(getWindowRules(mockSettings)).toEqual([
            entry('wechat', 'corners', 'Chat', {hasParent: true, allowsResize: false}),
        ]);
        expect(Object.keys(readEntries(mockSettings))).toEqual([kindId(kind('wechat', {hasParent: true, allowsResize: false}))]);
    });

    it('reads a client-built kind the same way', () => {
        const properties = {
            wmClass: 'wechat', clientType: 'wayland', windowType: '0',
            hasParent: 'false', allowsResize: 'true', isAttachedDialog: 'false',
            hasRing: 'false', hasSsd: 'false',
        };
        const built = kindFromProperties(properties);
        const mockSettings = createMockSettings([record('wechat', 'corners')]);
        expect(Object.keys(readEntries(mockSettings))).toEqual([kindId(built)]);
    });

    it('returns an empty map on null or throwing settings', () => {
        expect(readEntries(null)).toEqual({});
        expect(readEntries({})).toEqual({});
        expect(readEntries({
            get_value: () => {
                throw new Error('boom');
            },
        })).toEqual({});
    });
});

describe('setWindowRule / setAllRuleEntries', () => {
    it('writes the stored record array under the v2 key', () => {
        const settings = createMockSettings();
        setAllRuleEntries(settings, {
            [kindId(kind('wechat'))]: entry('wechat', 'corners'),
            [kindId(kind('wechat-app'))]: entry('wechat-app', 'corners,shadow'),
        });

        expect(settings.getWrites()).toEqual([SETTINGS_KEY_WINDOW_RULES]);
        expect(settings.getStored()).toEqual([
            record('wechat', 'corners'),
            record('wechat-app', 'corners,shadow'),
        ]);
    });

    it('skips writing when the stored value already matches', () => {
        const settings = createMockSettings([record('wechat', 'corners')]);
        setWindowRule(settings, kind('wechat'), 'corners');
        expect(settings.getWrites()).toEqual([]);
    });

    it('writes when the stored value differs', () => {
        const settings = createMockSettings([record('wechat', 'corners')]);
        setWindowRule(settings, kind('wechat'), 'corners,shadow');
        expect(settings.getWrites().length).toBe(1);
        expect(settings.getStored()).toEqual([record('wechat', 'corners,shadow')]);
    });

    it('stores a rule strictly with kind, state and title', () => {
        const settings = createMockSettings();
        setWindowRule(settings, kind('wechat'), 'corners', 'Local WeChat');
        expect(settings.getStored()).toEqual([record('wechat', 'corners', {}, 'Local WeChat')]);
    });
});

describe('rule titles', () => {
    const stored = record('wechat', 'corners', {}, 'Login');

    it('reads a title beside its state, and only for a valid record', () => {
        const settings = createMockSettings([
            stored,
            {...record('bad', 'corners', {}, 'not a rule'), client_type: 'macos'},
        ]);
        expect(getWindowRules(settings)).toEqual([entry('wechat', 'corners', 'Login')]);
        expect(getRuleTitles(settings)).toEqual({[kindId(kind('wechat'))]: 'Login'});
    });

    it('folds the title to one line on read', () => {
        const settings = createMockSettings([record('wechat', 'corners', {}, '  登录\n对话框  ')]);
        expect(getRuleTitles(settings)).toEqual({[kindId(kind('wechat'))]: '登录 对话框'});
    });

    it('keeps a long title whole: the row ellipsizes it by width, not by length', () => {
        const long = 'y'.repeat(200);
        const settings = createMockSettings([record('wechat', 'corners', {}, long)]);
        expect(getRuleTitles(settings)[kindId(kind('wechat'))]).toBe(long);
    });

    it('writes a title into the same entry, keeping the state', () => {
        const settings = createMockSettings([record('wechat', 'corners')]);
        setWindowRule(settings, kind('wechat'), 'corners', 'Login');
        expect(settings.getStored()).toEqual([record('wechat', 'corners', {}, 'Login')]);
    });

    it('keeps a title across a state-only write of another entry', () => {
        const settings = createMockSettings([
            record('wechat', 'corners', {}, 'Login'),
            record('firefox', 'shadow'),
        ]);
        setAllRuleEntries(settings, {
            [kindId(kind('wechat'))]: entry('wechat', 'corners', 'Login'),
            [kindId(kind('firefox'))]: entry('firefox', 'corners'),
        });
        const stored = settings.getStored();
        expect(stored.find(r => r.identity === 'wechat').title).toBe('Login');
    });

    it('drops a title with its rule, so display metadata cannot outlive it', () => {
        const settings = createMockSettings([
            record('wechat', 'corners', {}, 'Chat'),
            record('wechat-app', 'shadow', {}, 'Old'),
        ]);
        setAllRuleEntries(settings, {[kindId(kind('wechat'))]: entry('wechat', 'corners', 'Chat')});
        expect(settings.getStored()).toEqual([record('wechat', 'corners', {}, 'Chat')]);
    });

    it('returns empty maps on null or throwing settings', () => {
        expect(getRuleTitles(null)).toEqual({});
        expect(getWindowRules(null)).toEqual([]);
    });
});

describe('importRulesJson & exportRulesJson', () => {
    const wechatId = kindId(kind('wechat'));
    const firefoxId = kindId(kind('firefox'));

    it('exports entries as a version 2 record array', () => {
        const entries = {
            [wechatId]: entry('wechat', 'corners', 'WeChat'),
            [firefoxId]: entry('firefox', 'shadow', 'Firefox'),
        };
        const parsed = JSON.parse(exportRulesJson(entries));
        expect(parsed.version).toBe(2);
        expect(parsed.rules).toEqual([
            record('wechat', 'corners', {}, 'WeChat'),
            record('firefox', 'shadow', {}, 'Firefox'),
        ]);
    });

    it('round-trips through import', () => {
        const entries = {[wechatId]: entry('wechat', 'corners', 'WeChat')};
        const res = importRulesJson({}, exportRulesJson(entries));
        expect(res.hasConflicts).toBeFalse();
        expect(res.nextEntries).toEqual(entries);
    });

    it('throws on empty, invalid or ruleless JSON', () => {
        expect(() => importRulesJson({}, '')).toThrowError(/Empty clipboard/);
        expect(() => importRulesJson({}, 'not a json')).toThrowError(/Invalid JSON/);
        expect(() => importRulesJson({}, '{}')).toThrowError(/No rules found/);
        expect(() => importRulesJson({}, '{"version": 2, "rules": []}')).toThrowError(/No rules found/);
    });

    it('refuses the earlier payload shape, by version', () => {
        // The first shape this payload had: string keys over a{sa{ss}} rules.
        const legacy = JSON.stringify({
            version: 1,
            rules: {
                'firefox:client_type=wayland,window_type=0,has_parent=false,allows_resize=true,attached_dialog=false,has_ring=true,has_ssd=false':
                    {state: 'corners', title: 'Firefox'},
            },
        });
        expect(() => importRulesJson({}, legacy)).toThrowError(/Unsupported format version: 1/);
    });

    it('imports new rules into empty entries', () => {
        const payload = JSON.stringify({version: 2, rules: [record('wechat', 'corners', {}, 'WeChat')]});
        const res = importRulesJson({}, payload);
        expect(res.hasConflicts).toBeFalse();
        expect(res.addedCount).toBe(1);
        expect(res.updatedCount).toBe(0);
        expect(res.nextEntries[wechatId]).toEqual(entry('wechat', 'corners', 'WeChat'));
        expect(res.importedKeys).toEqual([wechatId]);
    });

    it('accepts an unversioned record array and a bare array', () => {
        const rules = [record('firefox', 'shadow')];
        for (const payload of [JSON.stringify({rules}), JSON.stringify(rules)]) {
            const res = importRulesJson({}, payload);
            expect(res.addedCount).toBe(1);
            expect(res.nextEntries[firefoxId]).toEqual(entry('firefox', 'shadow'));
        }
    });

    it('detects a conflict when the imported state differs', () => {
        const initial = {[wechatId]: entry('wechat', 'corners', 'My WeChat')};
        const payload = JSON.stringify({
            version: 2,
            rules: [record('wechat', 'corners,shadow', {}, 'Community WeChat')],
        });
        const res = importRulesJson(initial, payload);
        expect(res.hasConflicts).toBeTrue();
        expect(res.conflicts).toEqual([{
            key: wechatId,
            kind: kind('wechat'),
            existingState: 'corners',
            importedState: 'corners,shadow',
            existingTitle: 'My WeChat',
            importedTitle: 'Community WeChat',
        }]);
        expect(res.nonConflictingEntries).toEqual(initial);
        expect(res.cleanImported[wechatId]).toEqual(entry('wechat', 'corners,shadow', 'Community WeChat'));
        expect(res.importedKeys).toEqual([wechatId]);
    });

    it('is idempotent when the imported state matches and the title is set', () => {
        const initial = {[wechatId]: entry('wechat', 'corners', 'My WeChat')};
        const payload = JSON.stringify({version: 2, rules: [record('wechat', 'corners', {}, 'Community WeChat')]});
        const res = importRulesJson(initial, payload);
        expect(res.hasConflicts).toBeFalse();
        expect(res.addedCount).toBe(0);
        expect(res.updatedCount).toBe(0);
        expect(res.nextEntries[wechatId]).toEqual(initial[wechatId]);
        expect(res.importedKeys).toEqual([wechatId]);
    });

    it('supplements a missing existing title and counts it as an update', () => {
        const initial = {[wechatId]: entry('wechat', 'corners', '')};
        const payload = JSON.stringify({version: 2, rules: [record('wechat', 'corners', {}, 'Community Title')]});
        const res = importRulesJson(initial, payload);
        expect(res.hasConflicts).toBeFalse();
        expect(res.updatedCount).toBe(1);
        expect(res.nextEntries[wechatId].title).toBe('Community Title');
    });

    it('handles a compound import with both new and conflicting rules', () => {
        const initial = {[wechatId]: entry('wechat', 'corners', 'Local WeChat')};
        const payload = JSON.stringify({
            version: 2,
            rules: [
                record('wechat', 'corners,shadow', {}, 'Community WeChat'),
                record('firefox', 'shadow', {}, 'Community Firefox'),
            ],
        });
        const res = importRulesJson(initial, payload);
        expect(res.hasConflicts).toBeTrue();
        expect(res.conflicts.length).toBe(1);
        expect(res.nonConflictingEntries[firefoxId]).toEqual(entry('firefox', 'shadow', 'Community Firefox'));
        expect(res.nonConflictingEntries[wechatId]).toEqual(initial[wechatId]);
    });

    it('filters invalid records while keeping valid ones', () => {
        const payload = JSON.stringify({
            version: 2,
            rules: [
                record('firefox', 'shadow', {}, 'Valid'),
                {...record('bad', 'corners'), client_type: 'macos'},
            ],
        });
        const res = importRulesJson({}, payload);
        expect(res.addedCount).toBe(1);
        expect(res.nextEntries[firefoxId]).toBeDefined();
        expect(res.nextEntries[kindId(kind('bad'))]).toBeUndefined();
    });

    it('throws when every provided rule is invalid', () => {
        const payload = JSON.stringify({
            version: 2,
            rules: [
                {...record('bad', 'corners'), client_type: 'macos'},
                {...record('worse', 'corners'), window_type: '0'},
            ],
        });
        expect(() => importRulesJson({}, payload)).toThrowError(/No valid rules found/);
    });
});

describe('applyConflictResolutions', () => {
    const wechatId = kindId(kind('wechat'));
    const firefoxId = kindId(kind('firefox'));

    const existingEntries = {[wechatId]: entry('wechat', 'corners', 'My WeChat')};
    const nonConflicting = {[firefoxId]: entry('firefox', 'shadow', 'Firefox')};
    const cleanImported = {[wechatId]: entry('wechat', 'corners,shadow', 'Imported WeChat')};

    it('applies the imported rule when the choice is imported', () => {
        const res = applyConflictResolutions(existingEntries, nonConflicting, cleanImported, {[wechatId]: 'imported'});
        expect(res.resolvedUpdatedCount).toBe(1);
        expect(res.nextEntries[wechatId]).toEqual(entry('wechat', 'corners,shadow', 'Imported WeChat'));
        expect(res.nextEntries[firefoxId]).toEqual(nonConflicting[firefoxId]);
    });

    it('preserves the existing rule when the choice is existing', () => {
        const res = applyConflictResolutions(existingEntries, nonConflicting, cleanImported, {[wechatId]: 'existing'});
        expect(res.resolvedUpdatedCount).toBe(0);
        expect(res.nextEntries[wechatId]).toEqual(existingEntries[wechatId]);
        expect(res.nextEntries[firefoxId]).toEqual(nonConflicting[firefoxId]);
    });
});
