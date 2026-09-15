import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {WindowType} from './lib/mutterRules.generated.js';
import {
    RULE_STATES,
    RuleState,
    parseRuleKey,
    withRule,
} from './lib/rules.js';
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
const STATE_LABELS = new Map([
    // Translators: This extension draws both the corners and the shadow of the window.
    [RuleState.BOTH, () => _('Both')],
    // Translators: This extension draws neither the corners nor the shadow of the window.
    [RuleState.NONE, () => _('Neither')],
    // Translators: This extension draws the corners of the window, but not its shadow.
    [RuleState.CORNERS, () => _('Corners only')],
    // Translators: This extension draws the shadow of the window, but not its corners.
    [RuleState.SHADOW, () => _('Shadow only')],
]);

function stateLabel(state) {
    return (STATE_LABELS.get(state) ?? (() => state))();
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
 * @param {{client_type:string,window_type:number,has_parent:boolean,allows_resize:boolean,attached_dialog:boolean}|null} properties
 * @returns {string}
 */
function windowKindSentence(properties) {
    if (!properties)
        return '';

    // Translators: A window the user cannot resize.
    const fixedSize = _('Fixed-size');
    // Translators: A window the user can resize.
    const resizable = _('Resizable');
    const size = properties.allows_resize === false ? fixedSize : resizable;
    const server = properties.client_type === 'x11' ? _('X11') : _('Wayland');

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

    // Translators: %s is the size, the client type, the window type and the
    // parent, in that order. Reorder the placeholders to fit the language.
    return _('%s %s %s, %s').format(size, server, windowTypeNoun(properties.window_type), parent);
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

        // Input, not decoration: the band changes where a drag starts.
        // See docs/decoration-model.md § The resize band — it is the first thing here
        // that takes clicks, and it can be turned off for that reason.
        const interactionGroup = new Adw.PreferencesGroup({
            title: asMarkup(_('Window Interaction')),
        });
        page.add(interactionGroup);

        const bandRow = new Adw.SwitchRow({
            // Translators: The resize band is the strip around a window that can be dragged to resize it.
            title: asMarkup(_('Widen the Resize Band')),
            subtitle: asMarkup(_('Let windows whose own resize border is narrower than a native one be resized by dragging the band around them: 12 pixels out on every side, and 24 along the edge at each corner, as native GNOME windows can')),
        });
        settings.bind('resize-band', bandRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        interactionGroup.add(bandRow);

        // See docs/rule-model.md — state names which decoration axes this extension draws.
        const pickButton = new Gtk.Button({
            icon_name: 'find-location-symbolic',
            tooltip_text: _('Pick a window to add a rule'),
            valign: Gtk.Align.CENTER,
            margin_start: 18,
        });
        pickButton.update_property([Gtk.AccessibleProperty.LABEL], [_('Pick a window to add a rule')]);

        const rulesGroup = new Adw.PreferencesGroup({
            title: asMarkup(_('Window Rules')),
            description: asMarkup(_('Configure decoration overrides for specific window kinds')),
            header_suffix: pickButton,
        });
        page.add(rulesGroup);

        const rows = [];

        const renderRules = () => {
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

            for (const [ruleKey, state] of entries) {
                const row = buildRuleRow(ruleKey, state);
                rulesGroup.add(row);
                rows.push(row);
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

        const buildRuleRow = (ruleKey, state) => {
            const {baseWmClass, properties} = parseRuleKey(ruleKey);
            const appInfo = findAppInfoByWmClass(baseWmClass, installedApps);
            const name = appInfo?.name || baseWmClass || ruleKey;

            // A combo row labels its dropdown with the row title and gives it
            // the standard combo-box accessible role; a bare dropdown suffix
            // would leave the control unnamed.
            const row = new Adw.ComboRow({
                title: asMarkup(name),
                subtitle: asMarkup(windowKindSentence(properties)),
                subtitle_lines: 2,
                model: Gtk.StringList.new(RULE_STATES.map(stateLabel)),
                selected: Math.max(0, RULE_STATES.indexOf(state)),
                tooltip_text: ruleKey,
            });
            row.update_property([Gtk.AccessibleProperty.LABEL], [name]);

            row.add_prefix(appInfo?.icon
                ? new Gtk.Image({gicon: appInfo.icon, pixel_size: 32})
                : new Gtk.Image({icon_name: 'window-new-symbolic', pixel_size: 24}));

            row.connect('notify::selected', () => {
                const nextState = RULE_STATES[row.selected];
                if (!nextState)
                    return;
                setWindowRules(settings, withRule(getWindowRules(settings), ruleKey, nextState));
            });

            const deleteButton = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                css_classes: ['flat', 'destructive-action'],
                valign: Gtk.Align.CENTER,
                margin_start: 6,
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

                const state = RULE_STATES.includes(props.suggestedState)
                    ? props.suggestedState
                    : RuleState.BOTH;

                if (props.suggestedStateWouldChange === 'false') {
                    window.add_toast(new Adw.Toast({
                        title: _('No rule added: it would have no effect on a window of this kind'),
                    }));
                    return;
                }

                setWindowRules(settings, withRule(getWindowRules(settings), ruleKey, state));

                if (!Object.prototype.hasOwnProperty.call(getWindowRules(settings), ruleKey)) {
                    window.add_toast(new Adw.Toast({
                        title: _('No rule added: the rule could not be saved'),
                    }));
                    return;
                }

                renderRules();

                window.add_toast(new Adw.Toast({
                    title: _('Rule set to: %s').format(stateLabel(state)),
                }));
            });
        });

        renderRules();
    }
}
