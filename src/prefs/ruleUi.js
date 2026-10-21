import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';

import {RuleAxis, RULE_AXES} from '../lib/rules.js';
import {axisName, asMarkup, windowKindSentence, _} from '../lib/rulePresenter.js';

export const AXIS_ICONS = {
    [RuleAxis.CORNERS]: {bundled: 'winnativizer-corners-symbolic', fallback: 'window-restore-symbolic'},
    [RuleAxis.SHADOW]: {bundled: 'winnativizer-shadow-symbolic', fallback: 'edit-copy-symbolic'},
    [RuleAxis.RESIZE]: {bundled: 'winnativizer-resize-symbolic', fallback: 'view-restore-symbolic'},
};

let _cssProviderRegistered = false;

/** Registers the prefs CSS once; safe to call repeatedly. */
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

/** Adds the bundled icons directory to the icon theme's search path; a failure leaves it stock. */
export function registerIconThemePath(iconTheme) {
    try {
        const moduleDir = import.meta.url.slice(0, import.meta.url.lastIndexOf('/') + 1);
        iconTheme.add_search_path(`${decodeURI(moduleDir.replace(/^file:\/\//, ''))}../icons`);
    } catch {
        // Search path stays stock; per-axis fallbacks cover it.
    }
}

/** The axis's bundled symbolic icon, or its stock fallback. */
export function createAxisImage(axis, iconTheme) {
    const {bundled, fallback} = AXIS_ICONS[axis];
    return new Gtk.Image({
        icon_name: iconTheme.has_icon(bundled) ? bundled : fallback,
        pixel_size: 16,
        valign: Gtk.Align.CENTER,
    });
}

/** Replaces a box's children with one icon per corrected axis, or a fallback label if none. */
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

/** An Adw.SwitchRow for one axis: on means the user reversed the automatic decision. */
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

/** The title, subtitle, icon, tooltip and a11y labels shared by the list and conflict rows. */
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
