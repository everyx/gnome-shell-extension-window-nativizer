/** Pure: it reverses whatever the decision module answers, so the two agree by construction. */

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

/** Capability, not choice: prefs offers a switch by it, and an ignored axis has no decision. */
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

/** The whole correction, not the smallest: the user picked it because it already looks wrong. */
export function suggestedRuleState(params) {
    const caps = ruleAxisCapabilities(params);
    return buildRuleState(RULE_AXES.filter(axis => caps[axis]));
}

export function suggestedRuleWouldChange(properties, params, state) {
    const key = buildRuleKeyFromProperties(properties);
    if (!key)
        return null;

    return ruleWouldChangeActions(kindParams(params), {key, state});
}
