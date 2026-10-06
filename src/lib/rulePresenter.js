import GLib from 'gi://GLib';
import * as Gettext from 'gettext';

import {WindowType} from './mutterRules.generated.js';
import {
    RULE_AXES,
    RuleAxis,
    parseRuleState,
} from './rules.js';
import {isDecoratableWindowType, ruleAxisCapabilities} from './detector.js';

const DOMAIN = 'window-nativizer';

/**
 * Translates a message using gettext for the window-nativizer domain.
 * @param {string} msgid
 * @returns {string}
 */
export function _(msgid) {
    return Gettext.dgettext(DOMAIN, msgid);
}

/**
 * Translates a plural message using dngettext for the window-nativizer domain.
 * @param {string} msgid
 * @param {string} msgidPlural
 * @param {number} n
 * @returns {string}
 */
export function ngettext(msgid, msgidPlural, n) {
    return Gettext.dngettext(DOMAIN, msgid, msgidPlural, n);
}

/**
 * Formats a string template using String.prototype.format if available (GNOME Shell environment),
 * or falls back to a regex-based positional substitution (headless unit testing).
 * @param {string} template
 * @param {...any} args
 * @returns {string}
 */
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

/**
 * Whether the window kind can be decorated at all - the fact the axis capabilities
 * and the unavailable reason both turn on.
 * @param {{windowType:number}|null} kind
 * @returns {boolean}
 */
export function isDecoratableKind(kind) {
    return !!kind &&
        isDecoratableWindowType(kind.windowType ?? WindowType.NORMAL);
}

/**
 * The shared capability answer, read straight off the kind's own fields.
 * @param {{windowType:number,allowsResize:boolean,hasSsd:boolean}|null} kind
 * @returns {Record<string, boolean>}
 */
export function keyAxisCapabilities(kind) {
    return ruleAxisCapabilities({
        windowType: kind?.windowType ?? WindowType.NORMAL,
        allowsResize: kind?.allowsResize !== false,
        hasSsd: Boolean(kind?.hasSsd),
    });
}

// Translators: Shown where no rule axis applies at all.
export function neverDecorated() {
    return _('Windows of this kind are never decorated');
}

/**
 * @param {string} axis
 * @param {boolean} decoratable - Whether the kind can be decorated at all
 * @param {{allowsResize:boolean,hasSsd:boolean}|null} kind
 * @returns {string} Why the axis cannot be configured here
 */
export function axisUnavailableReason(axis, decoratable = true, kind = null) {
    // A non-decoratable kind (menus, tooltips) is never about fixed size or a
    // frame, even on the resize row: naming the wrong reason would send the user to
    // fix the wrong thing.
    if (decoratable && axis === RuleAxis.RESIZE) {
        if (kind?.hasSsd) {
            // Translators: Shown where a resize control would be, but cannot be used.
            return _('The window frame can already be resized');
        }
        // Translators: Shown where a resize control would be, but cannot be used.
        return _('Fixed-size windows have no resize handle');
    }
    return neverDecorated();
}

/**
 * The axes a state corrects, for toasts, e.g. "Corners, Shadow".
 * @param {string} state Canonical stored state
 * @returns {string}
 */
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

/**
 * Formats a window kind into a human-readable descriptive sentence.
 * @param {{clientType:string,windowType:number,hasParent:boolean,allowsResize:boolean,attachedDialog:boolean,hasRing?:boolean,hasSsd?:boolean,width?:number|null,height?:number|null}|null} kind
 * @returns {string}
 */
export function windowKindSentence(kind) {
    if (!kind)
        return '';

    const server = kind.clientType === 'x11' ? _('X11') : _('Wayland');
    // Translators: %s is the client type and the window type, e.g. "Wayland window". If your
    // language puts the type first, use the placeholders as %2$s %1$s.
    const entity = formatString(_('%s %s'), server, windowTypeNoun(kind.windowType));

    // Translators: The window has no parent window.
    const noParent = _('with no parent');
    // Translators: The window is attached to its parent window.
    const attachedParent = _('attached to its parent');
    // Translators: The window has a parent window it is not attached to.
    const hasParent = _('with a parent');

    let parent;
    if (!kind.hasParent)
        parent = noParent;
    else if (kind.attachedDialog)
        parent = attachedParent;
    else
        parent = hasParent;

    let size;
    if (kind.allowsResize === false) {
        if (kind.width !== null && kind.width !== undefined &&
            kind.height !== null && kind.height !== undefined) {
            const formattedDimensions = `${kind.width}×${kind.height}`;
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

    // One frame clause carries both ring attributes: the kind cannot describe a window
    // that declares a ring and an SSD frame at once (the picker clears has_ring for it).
    let frame = null;
    if (kind.hasSsd) {
        // Translators: The compositor draws this window's frame, so it owns the resize handles.
        frame = _('frame drawn by the system');
    } else if (kind.hasRing === false) {
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

/**
 * Escape for the Adw properties that parse Pango markup (rows and preference groups); Toast,
 * AlertDialog and a bare Gtk.Label take plain text.
 * @param {string} text
 * @returns {string}
 */
export function asMarkup(text) {
    return GLib.markup_escape_text(String(text), -1);
}
