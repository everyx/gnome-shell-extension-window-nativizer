import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';

import {RuleAxis, RULE_AXES} from '../lib/rules.js';
import {axisName, asMarkup, windowKindSentence, _} from '../lib/rulePresenter.js';

// Bundled symbolic icons per axis with fallback stock icons.
export const AXIS_ICONS = {
    [RuleAxis.CORNERS]: {bundled: 'winnativizer-corners-symbolic', fallback: 'window-restore-symbolic'},
    [RuleAxis.SHADOW]: {bundled: 'winnativizer-shadow-symbolic', fallback: 'edit-copy-symbolic'},
    [RuleAxis.RESIZE]: {bundled: 'winnativizer-resize-symbolic', fallback: 'view-restore-symbolic'},
};

let _cssProviderRegistered = false;

/**
 * Registers custom CSS styling for recently imported rows and conflict dialog headings.
 * Safe and idempotent to call multiple times.
 */
export function ensureCustomStyles() {
    if (_cssProviderRegistered)
        return;
    const display = Gdk.Display.get_default();
    if (!display)
        return;
    const provider = new Gtk.CssProvider();
    provider.load_from_string(`
        row.recently-imported {
            background-color: alpha(@accent_color, 0.08);
        }
        preferencesgroup.conflict-group label.heading {
            font-weight: normal;
            font-size: 1rem;
        }
    `);
    Gtk.StyleContext.add_provider_for_display(
        display,
        provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
    );
    _cssProviderRegistered = true;
}

/**
 * Adds the bundled icons directory to the GTK IconTheme search path.
 * @param {Gtk.IconTheme} iconTheme
 */
export function registerIconThemePath(iconTheme) {
    try {
        const moduleDir = import.meta.url.slice(0, import.meta.url.lastIndexOf('/') + 1);
        iconTheme.add_search_path(`${decodeURI(moduleDir.replace(/^file:\/\//, ''))}../icons`);
    } catch {
        // Search path stays stock; per-axis fallbacks cover it.
    }
}

/**
 * Creates a Gtk.Image displaying the symbolic icon for the specified axis.
 * @param {string} axis
 * @param {Gtk.IconTheme} iconTheme
 * @returns {Gtk.Image}
 */
export function createAxisImage(axis, iconTheme) {
    const {bundled, fallback} = AXIS_ICONS[axis];
    return new Gtk.Image({
        icon_name: iconTheme.has_icon(bundled) ? bundled : fallback,
        pixel_size: 16,
        valign: Gtk.Align.CENTER,
    });
}

/**
 * Populates a Gtk.Box with axis icons or a fallback label with clean tooltips.
 * @param {Gtk.Box} box
 * @param {Set<string>} correctedAxes
 * @param {Record<string, boolean>} caps
 * @param {Gtk.IconTheme} iconTheme
 * @param {string|null} [fallbackLabel=null]
 */
export function populateAxisIcons(box, correctedAxes, caps, iconTheme, fallbackLabel = null) {
    let child = box.get_first_child();
    while (child) {
        const next = child.get_next_sibling();
        box.remove(child);
        child = next;
    }
    const tips = [];
    for (const axis of RULE_AXES) {
        if (!caps[axis] || !correctedAxes.has(axis))
            continue;
        const word = axisName(axis);
        const icon = createAxisImage(axis, iconTheme);
        icon.set_tooltip_text(word);
        icon.update_property([Gtk.AccessibleProperty.LABEL], [word]);
        box.append(icon);
        tips.push(word);
    }
    if (tips.length === 0 && fallbackLabel) {
        const label = new Gtk.Label({
            label: fallbackLabel,
            css_classes: ['dim-label'],
        });
        box.append(label);
        box.set_tooltip_text(fallbackLabel);
    } else {
        box.set_tooltip_text(tips.join(' · '));
    }
}

/**
 * Builds an Adw.SwitchRow for configuring an individual rule axis.
 * @param {string} axis
 * @param {Set<string>} corrected
 * @param {(axis: string, active: boolean) => void} onChange
 * @returns {Adw.SwitchRow}
 */
export function buildAxisSwitch(axis, corrected, onChange) {
    const name = axisName(axis);
    // Translators: Tooltip on a correction switch: turning it on reverses the automatic decision.
    const hint = _('Turn on to correct the automatic decision for this window kind');
    const switchRow = new Adw.SwitchRow({
        title: asMarkup(name),
        tooltip_text: hint,
        active: corrected.has(axis),
    });
    switchRow.update_property([Gtk.AccessibleProperty.LABEL], [name]);
    // The same text, for assistive technology.
    switchRow.update_property([Gtk.AccessibleProperty.DESCRIPTION], [hint]);
    switchRow.connect('notify::active', () => onChange(axis, switchRow.active));
    return switchRow;
}

/**
 * Configures the standard header presentation (title, subtitle, icon, tooltip, accessibility)
 * for a rule row, shared across the main preferences list and the conflict dialog.
 * @param {Adw.PreferencesRow} row
 * @param {{
 *   name: string,
 *   sampleTitle?: string|null,
 *   properties: object,
 *   appInfo?: object|null,
 * }} options
 */
export function setupRuleRowHeader(row, options) {
    const {name, sampleTitle, properties, appInfo} = options;

    let titleMarkup = asMarkup(name);
    if (sampleTitle && sampleTitle !== name)
        titleMarkup += ` <span alpha="55%">${asMarkup(sampleTitle)}</span>`;
    row.title = titleMarkup;

    row.subtitle = asMarkup(windowKindSentence(properties));
    row.title_lines = 1;
    row.subtitle_lines = 2;

    row.update_property([Gtk.AccessibleProperty.LABEL], [name]);

    if (sampleTitle && sampleTitle !== name)
        row.set_tooltip_text(_('Picked from the window “%s”').format(sampleTitle));

    row.add_prefix(appInfo?.icon
        ? new Gtk.Image({gicon: appInfo.icon, pixel_size: 32})
        : new Gtk.Image({icon_name: 'window-new-symbolic', pixel_size: 24}));
}
