/**
 * What a pick is worth: the answer the preferences process decides on, read from the property
 * dictionary the extension sent back.
 *
 * The decision is here and the words are in the preferences window, because the toast text is bound
 * to the prefs process's gettext domain. Every refusal names its reason, so a caller can say what
 * went wrong instead of reporting a generic failure.
 */

import {buildRuleKeyFromProperties, buildRuleState, parseRuleKey, parseRuleState} from './rules.js';
import {isDecoratableKind} from './rulePresenter.js';

/**
 * Why a pick stores no rule; the preferences window turns each into its own sentence.
 */
export const PickRefusal = Object.freeze({
    /** The reply identified no window, so no rule key can be built from it. */
    UNIDENTIFIABLE: 'unidentifiable',
    /** The kind is never decorated, so there is nothing to correct. */
    NEVER_DECORATED: 'never-decorated',
    /** No suggested state: an extension too old to judge, so the pick is refused, not guessed. */
    NO_SUGGESTION: 'no-suggestion',
    /** Storing the suggestion would leave the decoration as it already is. */
    NO_EFFECT: 'no-effect',
});

/**
 * The rule a pick would store, or why it would store none. The checks run in the order of the answers
 * they need: a key before a kind, a kind before a suggestion, a suggestion before its effect.
 *
 * @param properties - The pick reply's property dictionary
 * @returns `{refusal}` or `{key, state}`, where `state` is the canonical stored form
 */
export function pickVerdict(properties = {}) {
    const key = buildKeyFrom(properties);
    if (!key)
        return {refusal: PickRefusal.UNIDENTIFIABLE};

    // The inspector only offers decoratable windows; this keeps a caller that does not - or a reply
    // from a session whose rules disagree - from storing a correction for a kind nothing acts on.
    const {properties: picked} = parseRuleKey(key);
    if (picked && !isDecoratableKind(picked))
        return {refusal: PickRefusal.NEVER_DECORATED};

    const suggested = typeof properties?.suggestedState === 'string'
        ? parseRuleState(properties.suggestedState)
        : null;
    if (!suggested)
        return {refusal: PickRefusal.NO_SUGGESTION};

    // Only an explicit 'false' refuses: a reply carrying no answer at all is an older extension,
    // which has already been refused above for having no suggestion.
    if (properties.suggestedStateWouldChange === 'false')
        return {refusal: PickRefusal.NO_EFFECT};

    return {key, state: buildRuleState(suggested)};
}

/**
 * @returns The key a reply's window kind is stored under, or '' when it named no window
 */
function buildKeyFrom(properties) {
    try {
        return buildRuleKeyFromProperties(properties);
    } catch {
        // A dictionary the builder cannot read is an unidentifiable window, not a crash in prefs.
        return '';
    }
}
