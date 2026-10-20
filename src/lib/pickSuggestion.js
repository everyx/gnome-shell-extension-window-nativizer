/**
 * What a pick should correct: the axes a window kind can be corrected on, the suggestion a pick makes,
 * and whether storing it would change anything (all pure).
 *
 * The suggestion asks the decoration decision what each axis currently answers and reverses every
 * axis the kind can act on, so the two modules agree about a kind by construction rather than by
 * sharing a table.
 */

import {evaluateWindowActions, isDecoratableWindowType} from './detector.js';
import {
    RULE_AXES,
    RuleAxis,
    buildRuleKeyFromProperties,
    buildRuleState,
    withRule,
} from './rules.js';
import {WindowType} from './mutterRules.generated.js';

function ruleWouldChangeActions(params, {key, state}) {
    const before = evaluateWindowActions(params);
    const after = evaluateWindowActions({
        ...params,
        rules: withRule(params.rules, key, state),
    });

    return before.drawShadow !== after.drawShadow ||
        before.drawClip !== after.drawClip ||
        before.drawResize !== after.drawResize;
}

function kindParams(params) {
    return {
        ...params,
        isMaximized: false,
        isFullscreen: false,
        hasTileMatch: false,
        tiled: false,
    };
}

/**
 * Which axes a kind can be corrected on at all - the same answer the preferences window
 * uses to decide whether to offer a switch. Capability, not choice: an axis the runtime
 * cannot act on has no decision to reverse.
 * @returns Keyed by RuleAxis
 */
export function ruleAxisCapabilities({
    windowType = WindowType.NORMAL, allowsResize = true, hasSsd = false,
} = {}) {
    const decoratable = isDecoratableWindowType(windowType);
    return {
        [RuleAxis.CORNERS]: decoratable,
        [RuleAxis.SHADOW]: decoratable,
        [RuleAxis.RESIZE]: decoratable && allowsResize !== false && !hasSsd,
    };
}

/**
 * Picker suggestion: correct every axis this kind can be corrected on. The user picked the window
 * because it looks wrong, so the pick is the whole correction, not the smallest one; an axis the kind
 * cannot be corrected on is left out, because naming it could not take effect.
 */
export function suggestedRuleState(params) {
    const caps = ruleAxisCapabilities(params);
    return buildRuleState(RULE_AXES.filter(axis => caps[axis]));
}

/**
 * @returns Null when the window cannot be identified
 */
export function suggestedRuleWouldChange(properties, params, state) {
    const key = buildRuleKeyFromProperties(properties);
    if (!key)
        return null;

    return ruleWouldChangeActions(kindParams(params), {key, state});
}
