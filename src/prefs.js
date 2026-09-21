import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {WindowType} from './lib/mutterRules.generated.js';
import {
    RULE_AXES,
    RuleAxis,
    buildRuleState,
    parseRuleKey,
    parseRuleState,
    withRule,
} from './lib/rules.js';
import {hasUnclearableShadow, isDecoratableWindowType} from './lib/detector.js';
import {
    INSPECTOR_DBUS_NAME,
    INSPECTOR_DBUS_PATH,
    buildRuleKeyFromProperties,
} from './lib/pick.js';
import {
    getWindowRules,
    setWindowRules,
} from './lib/settings.js';

// Thunked: built at import time before prefs binds gettext, plain _() would capture untranslated.
const AXIS_NAMES = new Map([
    // Translators: One of the three rule axes: rounded window corners.
    [RuleAxis.CORNERS, () => _('Corners')],
    // Translators: One of the three rule axes: the window shadow.
    [RuleAxis.SHADOW, () => _('Shadow')],
    // Translators: One of the three rule axes: the resize band around the window.
    [RuleAxis.RESIZE, () => _('Resize')],
]);

function axisName(axis) {
    return (AXIS_NAMES.get(axis) ?? (() => axis))();
}

// The two positions of an axis control: follow the extension's own decision, or
// reverse it. A rule exists to say "this judgement is wrong for this kind".
const AXIS_MODE = Object.freeze({
    AUTOMATIC: 'automatic',
    REVERSE: 'reverse',
});

const AXIS_MODE_NAMES = new Map([
    // Translators: A rule axis follows the extension's own decision.
    [AXIS_MODE.AUTOMATIC, () => _('Automatic')],
    // Translators: A rule axis does the opposite of the extension's own decision.
    [AXIS_MODE.REVERSE, () => _('Reverse')],
]);

function axisModeName(mode) {
    return (AXIS_MODE_NAMES.get(mode) ?? (() => mode))();
}

// CJK words take no space; Latin ones do. A format string cannot serve both
// ('%s %s' is already the kind sentence), so the separator is chosen from the locale.
const WORD_JOINER = (GLib.get_language_names()[0] ?? '').match(/^(zh|ja|ko)/) ? '' : ' ';

/**
 * @param {string} axis
 * @returns {string} e.g. "Corners reversed" (no space in CJK locales)
 */
function reversedAxisWord(axis) {
    return `${axisName(axis)}${WORD_JOINER}${axisModeName(AXIS_MODE.REVERSE)}`;
}

/**
 * Whether the window kind can be decorated at all - the fact the axis capabilities
 * and the unavailable reason both turn on.
 * @param {{window_type:number}|null} properties
 * @returns {boolean}
 */
function isDecoratableKind(properties) {
    return !!properties &&
        isDecoratableWindowType(Number(properties.window_type ?? WindowType.NORMAL));
}

/**
 * Which axes a window kind can even configure. Capability, not choice: a rule only
 * reverses a decision the runtime could act on, so an axis we are powerless on is
 * not offered at all.
 * @param {{window_type:number,allows_resize:boolean,has_ssd:boolean}|null} properties
 * @returns {Record<string, boolean>}
 */
function ruleAxisCapabilities(properties) {
    const caps = {[RuleAxis.CORNERS]: false, [RuleAxis.SHADOW]: false, [RuleAxis.RESIZE]: false};
    if (!isDecoratableKind(properties))
        return caps;
    caps[RuleAxis.CORNERS] = true;
    caps[RuleAxis.SHADOW] = true;
    // The compositor's own frame already owns the handles of an SSD window, so
    // there is nothing here for the resize axis to reverse.
    caps[RuleAxis.RESIZE] = properties.allows_resize !== false && !properties.has_ssd;
    return caps;
}

// Translators: Shown where no rule axis applies at all.
function neverDecorated() {
    return _('Windows of this type are never decorated');
}

/**
 * @param {string} axis
 * @param {boolean} decoratable - Whether the kind can be decorated at all
 * @param {{allows_resize:boolean,has_ssd:boolean}|null} properties
 * @returns {string} Why the axis cannot be configured here
 */
function axisUnavailableReason(axis, decoratable = true, properties = null) {
    // A non-decoratable kind (menus, tooltips) is never about fixed size or a
    // frame, even on the resize row: naming the wrong reason would send the user to
    // fix the wrong thing.
    if (decoratable && axis === RuleAxis.RESIZE) {
        if (properties?.has_ssd) {
            // Translators: Shown where a resize control would be, but cannot be used.
            return _('The window frame already handles resizing');
        }
        // Translators: Shown where a resize control would be, but cannot be used.
        return _('No resize handle on fixed-size windows');
    }
    return neverDecorated();
}

/**
 * Compact per-axis state for toasts, e.g. "Corners reversed, Shadow reversed".
 * @param {string} state Canonical stored state
 * @returns {string}
 */
function ruleSummaryText(state) {
    const reversed = parseRuleState(state);
    if (!reversed)
        return state;
    return RULE_AXES
        .filter(axis => reversed.has(axis))
        .map(axis => reversedAxisWord(axis))
        .join(', ');
}

// Same thunk reason as above.
const WINDOW_TYPE_NOUNS = new Map([
    // Translators: A dialog window.
    [WindowType.DIALOG, () => _('dialog')],
    // Translators: A dialog that blocks its parent window.
    [WindowType.MODAL_DIALOG, () => _('modal dialog')],
    // Translators: A small utility window, such as a palette or a toolbar.
    [WindowType.UTILITY, () => _('utility window')],
]);

function windowTypeNoun(windowType) {
    // Translators: A normal, top-level window.
    return (WINDOW_TYPE_NOUNS.get(windowType) ?? (() => _('window')))();
}

/**
 * @param {{client_type:string,window_type:number,has_parent:boolean,allows_resize:boolean,attached_dialog:boolean,has_ring?:boolean,has_ssd?:boolean,size?:string}|null} properties
 * @returns {string}
 */
function windowKindSentence(properties) {
    if (!properties)
        return '';

    const server = properties.client_type === 'x11' ? _('X11') : _('Wayland');
    // Translators: %s is the client type and the window type, e.g. "Wayland window".
    const entity = _('%s %s').format(server, windowTypeNoun(properties.window_type));

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
            size = _('fixed-size (%s)').format(formattedDimensions);
        } else {
            // Translators: A window the user cannot resize.
            size = _('fixed-size');
        }
    } else {
        // Translators: A window the user can resize.
        size = _('resizable');
    }

    // One frame clause carries both ring attributes: the key cannot describe a window
    // that declares a ring and an SSD frame at once (the picker clears has_ring for it).
    let frame = null;
    if (properties.has_ssd) {
        // Translators: The compositor draws this window's frame, so it owns the resize handles.
        frame = _('framed by the system');
    } else if (properties.has_ring === false) {
        // Translators: The window declares no shadow margin ring of its own.
        frame = _('without shadow margins');
    }

    if (frame) {
        // Translators: %s is the entity, parent, frame clause, and size, in that order.
        return _('%s, %s, %s, %s').format(entity, parent, frame, size);
    }

    // Translators: %s is the entity, parent, and size, in that order.
    return _('%s, %s, %s').format(entity, parent, size);
}

/**
 * Escape for Adw rows (Pango markup); Toast/AlertDialog and Gtk.Label are plain text.
 * @param {string} text
 * @returns {string}
 */
function asMarkup(text) {
    return GLib.markup_escape_text(String(text), -1);
}

// 'org.gnome.Nautilus.desktop' -> 'org.gnome.Nautilus'
function stripDesktopSuffix(id) {
    return id.endsWith('.desktop') ? id.slice(0, -8) : id;
}

/**
 * @returns {Array<{app:Gio.AppInfo,name:string,id:string,wmClass:string,icon:Gio.Icon|null}>}
 */
function getInstalledApps() {
    const apps = Gio.AppInfo.get_all();
    const result = [];
    for (const app of apps) {
        if (!app.should_show())
            continue;

        const name = app.get_name() || '';
        const id = app.get_id() || '';
        const startupWmClass = app.get_startup_wm_class ? app.get_startup_wm_class() : null;
        const executable = app.get_executable ? app.get_executable() : null;
        const icon = app.get_icon();

        let wmClass = startupWmClass;
        if (!wmClass && id)
            wmClass = stripDesktopSuffix(id);
        if (!wmClass && executable)
            wmClass = executable.split('/').pop();

        result.push({
            app,
            name,
            id,
            wmClass: wmClass || id,
            icon,
        });
    }
    return result;
}

function findAppInfoByWmClass(wmClass, appsList) {
    if (!wmClass)
        return null;
    const lower = wmClass.toLowerCase();
    return appsList.find(a =>
        a.wmClass.toLowerCase() === lower ||
        a.id.toLowerCase() === lower ||
        (a.id.endsWith('.desktop') && stripDesktopSuffix(a.id).toLowerCase() === lower) ||
        (a.app.get_startup_wm_class && a.app.get_startup_wm_class()?.toLowerCase() === lower)
    ) || null;
}

function inspectWindow(callback) {
    Gio.DBus.session.call(
        INSPECTOR_DBUS_NAME,
        INSPECTOR_DBUS_PATH,
        INSPECTOR_DBUS_NAME,
        'PickWindow',
        null,
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        (conn, res) => {
            try {
                const reply = conn.call_finish(res);
                const [props] = reply.deep_unpack();
                callback(null, props);
            } catch (e) {
                callback(e, null);
            }
        }
    );
}

function showError(parentWindow, heading, body) {
    const dialog = new Adw.AlertDialog({heading, body});
    // Translators: Closes the error dialog.
    dialog.add_response('ok', _('Close'));
    dialog.present(parentWindow);
}


export default class WindowNativizerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const installedApps = getInstalledApps();

        // Icon theme registration runs once per prefs session, not per row: the
        // maps are constant and add_search_path appends duplicates otherwise.
        // One bundled icon per axis, plus the stock icon that stands in when the
        // bundle is missing; see src/icons/NOTICE.
        const AXIS_ICONS = {
            [RuleAxis.CORNERS]: {bundled: 'winnativizer-corners-symbolic', fallback: 'window-restore-symbolic'},
            [RuleAxis.SHADOW]: {bundled: 'winnativizer-shadow-symbolic', fallback: 'edit-copy-symbolic'},
            [RuleAxis.RESIZE]: {bundled: 'winnativizer-resize-symbolic', fallback: 'view-restore-symbolic'},
        };
        const iconTheme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        try {
            const moduleDir = import.meta.url.slice(0, import.meta.url.lastIndexOf('/') + 1);
            iconTheme.add_search_path(`${decodeURI(moduleDir.replace(/^file:\/\//, ''))}icons`);
        } catch {
            // Search path stays stock; per-axis fallbacks cover it.
        }
        // Picker hides prefs window; reply may arrive after prefs closed — guard UI touches.
        let windowAlive = true;
        window.connect('destroy', () => {
            windowAlive = false;
        });

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const renderGroup = new Adw.PreferencesGroup({
            title: asMarkup(_('Display & Rendering')),
            description: asMarkup(_('Control window decoration behavior across screen scales')),
        });
        page.add(renderGroup);

        const crispRow = new Adw.SwitchRow({
            title: asMarkup(_('Prioritize Crisp Text')),
            subtitle: asMarkup(_('Skip rounded corners on fractional scale monitors (retaining shadow) to avoid text blur and resampling overhead')),
        });
        settings.bind('prefer-crisp-text', crispRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        renderGroup.add(crispRow);

        // See docs/rule-model.md - a rule names the axes to reverse.
        const pickButton = new Gtk.Button({
            icon_name: 'find-location-symbolic',
            tooltip_text: _('Pick a window to add a rule'),
            valign: Gtk.Align.CENTER,
            margin_start: 18,
        });
        pickButton.update_property([Gtk.AccessibleProperty.LABEL], [_('Pick a window to add a rule')]);

        const rulesGroup = new Adw.PreferencesGroup({
            title: asMarkup(_('Window Rules')),
            description: asMarkup(_('Per-window-kind rules that reverse the automatic decoration')),
            header_suffix: pickButton,
        });
        page.add(rulesGroup);

        const rows = [];

        const renderRules = highlightKey => {
            for (const row of rows)
                rulesGroup.remove(row);
            rows.length = 0;

            const rules = getWindowRules(settings);
            const entries = Object.entries(rules);

            // Count in header avoids opening group to see if it has items.
            rulesGroup.title = entries.length > 0
                ? `${asMarkup(_('Window Rules'))} <span size="small" alpha="55%">· ${entries.length}</span>`
                : asMarkup(_('Window Rules'));

            if (entries.length === 0) {
                const emptyRow = new Adw.ActionRow({
                    title: asMarkup(_('Use the button above to pick a window and add a rule')),
                    sensitive: false,
                });
                rulesGroup.add(emptyRow);
                rows.push(emptyRow);
                return;
            }

            let focusedRow = null;
            for (const [ruleKey, state] of entries) {
                const row = buildRuleRow(ruleKey, state);
                rulesGroup.add(row);
                rows.push(row);
                if (highlightKey && ruleKey === highlightKey) {
                    focusedRow = row;
                    row.set_expanded(true);
                }
            }

            if (focusedRow) {
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    if (windowAlive && focusedRow)
                        focusedRow.grab_focus();
                    return GLib.SOURCE_REMOVE;
                });
            }
        };

        // Destroyed from own signal: defer rebuild to idle. One pending is enough.
        let renderScheduled = false;
        const scheduleRenderRules = () => {
            if (renderScheduled)
                return;
            renderScheduled = true;
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                renderScheduled = false;
                if (windowAlive)
                    renderRules();
                return GLib.SOURCE_REMOVE;
            });
        };

        // Adwaita toggle group with labels: the platform's own segmented control.
        // A rule only reverses the automatic decision, so an axis has two positions.
        const buildAxisSegment = (axis, reversed, onChange) => {
            const group = new Adw.ToggleGroup({
                homogeneous: true,
                valign: Gtk.Align.CENTER,
            });
            for (const mode of [AXIS_MODE.AUTOMATIC, AXIS_MODE.REVERSE])
                group.add(new Adw.Toggle({name: mode, label: axisModeName(mode)}));
            group.set_active_name(reversed.has(axis) ? AXIS_MODE.REVERSE : AXIS_MODE.AUTOMATIC);
            // Translators: %s is the axis name, e.g. "Corners".
            group.update_property([Gtk.AccessibleProperty.LABEL], [_('%s setting').format(axisName(axis))]);
            group.connect('notify::active-name', () => {
                const active = group.get_active_name();
                if (active)
                    onChange(axis, active === AXIS_MODE.REVERSE);
            });
            return group;
        };

        const buildRuleRow = (ruleKey, state) => {
            const {baseWmClass, properties} = parseRuleKey(ruleKey);
            const appInfo = findAppInfoByWmClass(baseWmClass, installedApps);
            const name = appInfo?.name || baseWmClass || ruleKey;
            const reversed = parseRuleState(state) ?? new Set();
            const caps = ruleAxisCapabilities(properties);
            const decoratable = isDecoratableKind(properties);

            // The suffix shows one icon per reversed axis, and nothing for an axis that
            // still follows the decision: presence is the whole state, so the icon wears
            // no colour of its own. Tooltips state the same in words, so the channel is
            // never colour alone.
            const axisImage = axis => {
                const {bundled, fallback} = AXIS_ICONS[axis];
                return new Gtk.Image({
                    icon_name: iconTheme.has_icon(bundled) ? bundled : fallback,
                    pixel_size: 16,
                    valign: Gtk.Align.CENTER,
                });
            };
            const fillAxisIcons = (box, reversedAxes) => {
                let child = box.get_first_child();
                while (child) {
                    const next = child.get_next_sibling();
                    box.remove(child);
                    child = next;
                }
                const tips = [];
                for (const axis of RULE_AXES) {
                    if (!caps[axis] || !reversedAxes.has(axis))
                        continue;
                    const word = reversedAxisWord(axis);
                    const icon = axisImage(axis);
                    icon.set_tooltip_text(word);
                    icon.update_property([Gtk.AccessibleProperty.LABEL], [word]);
                    box.append(icon);
                    tips.push(word);
                }
                box.set_tooltip_text(tips.join(' · '));
            };

            const row = new Adw.ExpanderRow({
                title: asMarkup(name),
                subtitle: asMarkup(windowKindSentence(properties)),
                subtitle_lines: 2,
                tooltip_text: ruleKey,
            });
            row.update_property([Gtk.AccessibleProperty.LABEL], [name]);

            row.add_prefix(appInfo?.icon
                ? new Gtk.Image({gicon: appInfo.icon, pixel_size: 32})
                : new Gtk.Image({icon_name: 'window-new-symbolic', pixel_size: 24}));

            const iconBox = new Gtk.Box({spacing: 8, valign: Gtk.Align.CENTER});
            fillAxisIcons(iconBox, reversed);

            // ExpanderRow prepends suffixes to keep its arrow last, so add in
            // reverse visual order: [icons] … [delete][chevron].
            const deleteButton = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                css_classes: ['flat', 'destructive-action'],
                valign: Gtk.Align.CENTER,
                margin_start: 12,
                tooltip_text: _('Remove Rule'),
            });
            deleteButton.update_property([Gtk.AccessibleProperty.LABEL], [_('Remove Rule')]);
            deleteButton.connect('clicked', () => {
                const rules = getWindowRules(settings);
                delete rules[ruleKey];
                setWindowRules(settings, rules);
                scheduleRenderRules();
            });
            row.add_suffix(deleteButton);
            row.add_suffix(iconBox);

            const onAxisChange = (axis, isReversed) => {
                const storedRules = getWindowRules(settings);
                const current = parseRuleState(storedRules[ruleKey]) ?? new Set();
                const next = new Set(current);
                if (isReversed)
                    next.add(axis);
                else
                    next.delete(axis);
                const stored = withRule(storedRules, ruleKey, buildRuleState(next));
                setWindowRules(settings, stored);
                const canonical = stored[ruleKey];
                if (!canonical) {
                    // Nothing reversed is no rule: the row is the rule, so it goes with it.
                    scheduleRenderRules();
                    return;
                }
                fillAxisIcons(iconBox, parseRuleState(canonical));
            };

            // The kind sentence in the header already says what the rule applies to; this
            // line gives the two positions below their meaning, and the body then carries
            // only the axes.
            row.add_row(new Adw.ActionRow({
                title: asMarkup(_('Each axis follows the automatic decision; reverse the ones you disagree with')),
                title_lines: 2,
                sensitive: false,
            }));

            for (const axis of RULE_AXES) {
                if (!caps[axis]) {
                    // Left-right structure kept: title takes its natural width, the
                    // reason label expands over every leftover pixel on the right,
                    // text right-aligned on one line. A usable axis shows no hint
                    // at all - title plus control only.
                    const unavailableRow = new Adw.ActionRow({
                        title: asMarkup(axisName(axis)),
                        sensitive: false,
                    });
                    // Single line, enforced: ellipsize truncates instead of wrapping,
                    // and the tooltip keeps the full sentence one hover away.
                    const reason = axisUnavailableReason(axis, decoratable, properties);
                    const reasonLabel = new Gtk.Label({
                        label: reason,
                        css_classes: ['dim-label'],
                        valign: Gtk.Align.CENTER,
                        halign: Gtk.Align.FILL,
                        hexpand: true,
                        xalign: 1.0,
                        wrap: false,
                        ellipsize: Pango.EllipsizeMode.END,
                        tooltip_text: reason,
                    });
                    unavailableRow.add_suffix(reasonLabel);
                    row.add_row(unavailableRow);
                    continue;
                }
                const axisRow = new Adw.ActionRow({title: asMarkup(axisName(axis))});
                axisRow.update_property([Gtk.AccessibleProperty.LABEL], [axisName(axis)]);
                axisRow.add_suffix(buildAxisSegment(axis, reversed, onAxisChange));
                row.add_row(axisRow);
            }

            return row;
        };

        pickButton.connect('clicked', () => {
            window.set_visible(false);
            inspectWindow((err, props) => {
                if (!windowAlive)
                    return;

                window.set_visible(true);
                window.present();

                if (err) {
                    showError(window,
                        _('Window Inspection Failed'),
                        _('Could not connect to the Window Nativizer extension — it is not enabled'));
                    return;
                }

                // Empty = cancelled pick or extension disabling — not an error.
                if (!props || Object.keys(props).length === 0)
                    return;

                const ruleKey = buildRuleKeyFromProperties(props);

                if (!ruleKey) {
                    window.add_toast(new Adw.Toast({
                        title: _('No rule added: this window could not be identified'),
                    }));
                    return;
                }

                // The inspector only offers decoratable windows, so this guards
                // future callers - and names the reason instead of a generic refusal.
                const {properties: pickedProperties} = parseRuleKey(ruleKey);
                if (pickedProperties && !isDecoratableKind(pickedProperties)) {
                    window.add_toast(new Adw.Toast({title: neverDecorated()}));
                    return;
                }

                // The inspector sends the correction to make, as the axes to reverse.
                // An extension too old to judge sends nothing, and the runtime's own rule
                // is applied here (`hasUnclearableShadow`): the corners, plus the shadow
                // unless the window keeps a Mutter X11 shadow that cannot be cleared.
                const suggested = typeof props.suggestedState === 'string'
                    ? parseRuleState(props.suggestedState)
                    : null;
                const fallback = [RuleAxis.CORNERS];
                if (!hasUnclearableShadow({
                    hasSsd: props.hasSsd === 'true',
                    isX11: props.clientType === 'x11',
                    hasRing: props.hasRing === 'true',
                }))
                    fallback.push(RuleAxis.SHADOW);
                const state = buildRuleState(suggested ?? fallback);

                if (props.suggestedStateWouldChange === 'false') {
                    window.add_toast(new Adw.Toast({
                        title: _('No rule added: it would have no effect on a window of this kind'),
                    }));
                    return;
                }

                const existingRules = getWindowRules(settings);
                const isExisting = Object.prototype.hasOwnProperty.call(existingRules, ruleKey);

                setWindowRules(settings, withRule(existingRules, ruleKey, state));

                // Read-back is a persistence check, not redundancy: sanitize inside
                // setWindowRules may drop what withRule staged.
                if (!Object.prototype.hasOwnProperty.call(getWindowRules(settings), ruleKey)) {
                    window.add_toast(new Adw.Toast({
                        title: _('No rule added: the rule could not be saved'),
                    }));
                    return;
                }

                renderRules(ruleKey);

                const {baseWmClass} = parseRuleKey(ruleKey);
                const appInfo = findAppInfoByWmClass(baseWmClass, installedApps);
                const name = appInfo?.name || baseWmClass || ruleKey;

                const toastTitle = isExisting
                    ? _('Rule updated for %s: %s').format(name, ruleSummaryText(state))
                    : _('Rule added for %s: %s').format(name, ruleSummaryText(state));

                window.add_toast(new Adw.Toast({
                    title: toastTitle,
                }));

                // A rule outlives transient state, so a pick made mid-state says so.
                if (props.isMaximized === 'true' || props.isFullscreen === 'true' ||
                    props.hasTileMatch === 'true') {
                    window.add_toast(new Adw.Toast({
                        title: _('The rule takes effect once the window is restored'),
                    }));
                }
            });
        });

        renderRules();
    }
}
