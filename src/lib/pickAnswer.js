/** Decided here, worded in prefs, which owns the gettext domain the toast is bound to. */

import {buildRuleKeyFromProperties, buildRuleState, parseRuleKey, parseRuleState} from './rules.js';
import {isDecoratableKind} from './rulePresenter.js';

/** Why a pick stores no rule; prefs turns each into its own sentence. */
export const PickRefusal = Object.freeze({
    UNIDENTIFIABLE: 'unidentifiable',
    NEVER_DECORATED: 'never-decorated',
    /** No suggested state: an extension too old to judge, so the pick is refused, not guessed. */
    NO_SUGGESTION: 'no-suggestion',
    NO_EFFECT: 'no-effect',
});

/** The checks run in the order of the answers they need: key, kind, suggestion, then its effect. */
export function pickVerdict(properties = {}) {
    const key = buildKeyFrom(properties);
    if (!key)
        return {refusal: PickRefusal.UNIDENTIFIABLE};

    // The inspector only offers decoratable windows; a caller that does not must still be refused.
    const {properties: picked} = parseRuleKey(key);
    if (picked && !isDecoratableKind(picked))
        return {refusal: PickRefusal.NEVER_DECORATED};

    const suggested = typeof properties?.suggestedState === 'string'
        ? parseRuleState(properties.suggestedState)
        : null;
    if (!suggested)
        return {refusal: PickRefusal.NO_SUGGESTION};

    // Only an explicit 'false' refuses: no answer at all is an older extension, refused above.
    if (properties.suggestedStateWouldChange === 'false')
        return {refusal: PickRefusal.NO_EFFECT};

    return {key, state: buildRuleState(suggested)};
}

/** @returns the key the window kind is stored under, or '' when the reply named no window */
function buildKeyFrom(properties) {
    try {
        return buildRuleKeyFromProperties(properties);
    } catch {
        // A dictionary the builder cannot read is an unidentifiable window, not a crash in prefs.
        return '';
    }
}
