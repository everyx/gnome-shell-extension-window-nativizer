/**
 * The pick verdict: which reply stores a rule, and which stores none and says why. These branches
 * used to live inside the preferences window's clicked callback, where only a live GTK session could
 * reach them.
 * Run: pnpm test
 */

import {PickRefusal, pickVerdict} from '../src/lib/pickAnswer.js';
import {buildRuleKey, buildRuleKeyFromProperties} from '../src/lib/rules.js';
import {WindowType} from '../src/lib/mutterRules.generated.js';

/**
 * A reply dictionary as the inspector sends it: every value is a string.
 */
function reply(overrides = {}) {
    return {
        wmClass: 'wechat',
        clientType: 'wayland',
        windowType: String(WindowType.NORMAL),
        hasParent: 'false',
        allowsResize: 'true',
        isAttachedDialog: 'false',
        hasRing: 'false',
        hasSsd: 'false',
        isMaximized: 'false',
        isFullscreen: 'false',
        hasTileMatch: 'false',
        suggestedState: 'corners,shadow,resize',
        suggestedStateWouldChange: 'true',
        ...overrides,
    };
}

describe('pickVerdict — refusals', () => {
    it('refuses a reply that identified no window', () => {
        expect(pickVerdict({})).toEqual({refusal: PickRefusal.UNIDENTIFIABLE});
        expect(pickVerdict(reply({wmClass: ''}))).toEqual({refusal: PickRefusal.UNIDENTIFIABLE});
        expect(pickVerdict(reply({wmClass: '   '}))).toEqual({refusal: PickRefusal.UNIDENTIFIABLE});
        expect(pickVerdict()).toEqual({refusal: PickRefusal.UNIDENTIFIABLE});
    });

    it('refuses a kind that is never decorated, whatever the suggestion says', () => {
        const menu = reply({windowType: String(WindowType.MENU)});
        expect(pickVerdict(menu)).toEqual({refusal: PickRefusal.NEVER_DECORATED});
        expect(pickVerdict(reply({windowType: String(WindowType.TOOLTIP), suggestedState: ''})))
            .toEqual({refusal: PickRefusal.NEVER_DECORATED});
    });

    it('refuses a reply with no suggested state, rather than guessing one', () => {
        const noSuggestion = reply();
        delete noSuggestion.suggestedState;
        expect(pickVerdict(noSuggestion)).toEqual({refusal: PickRefusal.NO_SUGGESTION});
        expect(pickVerdict(reply({suggestedState: null})))
            .toEqual({refusal: PickRefusal.NO_SUGGESTION});
        // Stored grammar that cannot be read is no suggestion either: an extension too old to judge.
        expect(pickVerdict(reply({suggestedState: 'shadow,corners'})))
            .toEqual({refusal: PickRefusal.NO_SUGGESTION});
    });

    it('refuses a suggestion the extension itself says would change nothing', () => {
        expect(pickVerdict(reply({suggestedStateWouldChange: 'false'})))
            .toEqual({refusal: PickRefusal.NO_EFFECT});
    });
});

describe('pickVerdict — admitted picks', () => {
    it('carries the key the reply identifies and the canonical stored state', () => {
        const properties = reply();
        expect(pickVerdict(properties)).toEqual({
            key: buildRuleKeyFromProperties(properties),
            state: 'corners,shadow,resize',
        });
    });

    it('stores the canonical form of a single-axis suggestion', () => {
        expect(pickVerdict(reply({suggestedState: 'shadow'})).state).toBe('shadow');
    });

    it('admits a suggestion that says nothing, which is what a kind with no axis to correct sends', () => {
        expect(pickVerdict(reply({suggestedState: ''})))
            .toEqual({key: buildRuleKeyFromProperties(reply({suggestedState: ''})), state: ''});
    });

    it('admits a reply that carries no answer about the effect, as an older extension does', () => {
        const properties = reply();
        delete properties.suggestedStateWouldChange;
        expect(pickVerdict(properties).refusal).toBeUndefined();
    });

    it('keys a fixed-size window exactly as the shell would', () => {
        const properties = reply({
            wmClass: 'wechat',
            allowsResize: 'false',
            width: '360',
            height: '420',
        });
        expect(pickVerdict(properties).key).toBe(buildRuleKey('wechat', {
            allowsResize: false, width: 360, height: 420,
        }));
    });
});

describe('pickVerdict — the order the answers are needed in', () => {
    it('reports the first reason a pick cannot be stored, not a later one', () => {
        // Unidentifiable outranks everything: there is no kind to judge without a key.
        expect(pickVerdict({windowType: String(WindowType.MENU)}))
            .toEqual({refusal: PickRefusal.UNIDENTIFIABLE});
        // A never-decorated kind outranks a missing suggestion.
        expect(pickVerdict(reply({windowType: String(WindowType.DOCK), suggestedState: undefined})))
            .toEqual({refusal: PickRefusal.NEVER_DECORATED});
        // A missing suggestion outranks an effect answer, which is about that missing suggestion.
        expect(pickVerdict(reply({suggestedState: undefined, suggestedStateWouldChange: 'false'})))
            .toEqual({refusal: PickRefusal.NO_SUGGESTION});
    });

    it('answers an unreadable dictionary as unidentified instead of throwing', () => {
        const hostile = new Proxy({}, {
            get() {
                throw new Error('unreadable');
            },
        });
        expect(pickVerdict(hostile)).toEqual({refusal: PickRefusal.UNIDENTIFIABLE});
    });
});
