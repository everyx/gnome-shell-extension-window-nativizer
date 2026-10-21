import GLib from 'gi://GLib';
import * as Gettext from 'gettext';

import {WindowType} from './mutterRules.generated.js';
import {
    RULE_AXES,
    RuleAxis,
    parseRuleState,
} from './rules.js';
import {isDecoratableWindowType} from './detector.js';
import {ruleAxisCapabilities} from './pickSuggestion.js';

const DOMAIN = 'window-nativizer';

export function _(msgid) {
    return Gettext.dgettext(DOMAIN, msgid);
}

export function ngettext(msgid, msgidPlural, n) {
    return Gettext.dngettext(DOMAIN, msgid, msgidPlural, n);
}

/** `String.prototype.format` when present, else a regex `%s` substitution for headless tests. */
export function formatString(template, ...args) {
    if (typeof template.format === 'function')
        return template.format(...args);

    let sequentialIdx = 0;
    return template.replace(/%(\d+\$)?s/g, (match, pos) => {
        if (pos) {
            const idx = parseInt(pos, 10) - 1;
            return args[idx] !== undefined ? String(args[idx]) : match;
        }
        const val = args[sequentialIdx++];
        return val !== undefined ? String(val) : match;
    });
}

// Thunked: built at import time before prefs binds gettext, plain _() would capture untranslated.
const AXIS_NAMES = Object.freeze({
    // Translators: One of the three rule axes: rounded window corners.
    [RuleAxis.CORNERS]: () => _('Corners'),
    // Translators: One of the three rule axes: the window shadow.
    [RuleAxis.SHADOW]: () => _('Shadow'),
    // Translators: One of the three rule axes: the resize band around the window.
    [RuleAxis.RESIZE]: () => _('Resize'),
});

export function axisName(axis) {
    return (AXIS_NAMES[axis] ?? (() => axis))();
}

/** Whether the kind can be decorated at all; both the capabilities and the reason hinge on it. */
export function isDecoratableKind(properties) {
    return !!properties &&
        isDecoratableWindowType(Number(properties.window_type ?? WindowType.NORMAL));
}

/** The shared capability answer, read through a rule key's own field names. */
export function keyAxisCapabilities(properties) {
    return ruleAxisCapabilities({
        windowType: Number(properties?.window_type ?? WindowType.NORMAL),
        allowsResize: properties?.allows_resize !== false,
        hasSsd: Boolean(properties?.has_ssd),
    });
}

export function neverDecorated() {
    return _('Windows of this kind are never decorated');
}

/** Why the axis cannot be configured here; the fixed-size reasons need a decoratable kind. */
export function axisUnavailableReason(axis, decoratable = true, properties = null) {
    // A non-decoratable kind (menus, tooltips) is never about size or frame, even on resize.
    if (decoratable && axis === RuleAxis.RESIZE) {
        if (properties?.has_ssd) {
            // Translators: Shown where a resize control would be, but cannot be used.
            return _('The window frame can already be resized');
        }
        // Translators: Shown where a resize control would be, but cannot be used.
        return _('Fixed-size windows have no resize handle');
    }
    return neverDecorated();
}

/** Axes the state corrects, for toasts, e.g. "Corners, Shadow"; "Automatic" when none survive. */
export function ruleSummaryText(state) {
    const corrected = parseRuleState(state);
    if (!corrected)
        return state;
    const names = RULE_AXES
        .filter(axis => corrected.has(axis))
        .map(axis => axisName(axis));
    return names.length > 0 ? names.join(', ') : _('Automatic');
}

// Same thunk reason as above.
const WINDOW_TYPE_NOUNS = Object.freeze({
    // Translators: A dialog window.
    [WindowType.DIALOG]: () => _('dialog'),
    // Translators: A dialog that blocks its parent window.
    [WindowType.MODAL_DIALOG]: () => _('modal dialog'),
    // Translators: A small utility window, such as a palette or a toolbar.
    [WindowType.UTILITY]: () => _('utility window'),
});

export function windowTypeNoun(windowType) {
    // Translators: A normal, top-level window.
    return (WINDOW_TYPE_NOUNS[windowType] ?? (() => _('window')))();
}

export function windowKindSentence(properties) {
    if (!properties)
        return '';

    const server = properties.client_type === 'x11' ? _('XWayland') : _('Wayland');
    // Translators: %s is client type then window type ("Wayland window"); reorder with %2$s %1$s.
    const entity = formatString(_('%s %s'), server, windowTypeNoun(properties.window_type));

    // Translators: The window has no parent window.
    const noParent = _('with no parent');
    // Translators: The window is attached to its parent window.
    const attachedParent = _('attached to its parent');
    // Translators: The window has a parent window it is not attached to.
    const hasParent = _('with a parent');

    let parent;
    if (!properties.has_parent)
        parent = noParent;
    else if (properties.attached_dialog)
        parent = attachedParent;
    else
        parent = hasParent;

    let size;
    if (properties.allows_resize === false) {
        if (properties.size) {
            const formattedDimensions = String(properties.size).replace('x', '×');
            // Translators: %s is the width and height of the window, e.g. "fixed-size (360×420)".
            size = formatString(_('fixed-size (%s)'), formattedDimensions);
        } else {
            // Translators: A window the user cannot resize.
            size = _('fixed-size');
        }
    } else {
        // Translators: A window the user can resize.
        size = _('resizable');
    }

    // One frame clause for both ring attributes: no key declares a ring and an SSD frame at once.
    let frame = null;
    if (properties.has_ssd) {
        // Translators: The compositor draws this window's frame, so it owns the resize handles.
        frame = _('frame drawn by the system');
    } else if (properties.has_ring === false) {
        // Translators: The window declares no shadow margin ring of its own.
        frame = _('no shadow margins');
    }

    if (frame) {
        // Translators: %s is the entity, parent, frame clause, and size, in that order.
        return formatString(_('%s, %s, %s, %s'), entity, parent, frame, size);
    }

    // Translators: %s is the entity, parent, and size, in that order.
    return formatString(_('%s, %s, %s'), entity, parent, size);
}

/** Escape for Adw rows that parse Pango markup; Toast, AlertDialog and Gtk.Label take text. */
export function asMarkup(text) {
    return GLib.markup_escape_text(String(text), -1);
}
