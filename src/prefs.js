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

// The labels are thunks because this table is built while the module loads, before
// the prefs process has bound the gettext domain - a plain _() here would capture
// the untranslated string.
const STATE_LABELS = new Map([
    [RuleState.BOTH, () => _('Decorate')],
    [RuleState.NONE, () => _('Leave alone')],
    [RuleState.CORNERS, () => _('Corners only')],
    [RuleState.SHADOW, () => _('Shadow only')],
]);

function stateLabel(state) {
    return (STATE_LABELS.get(state) ?? (() => state))();
}

// The nouns are thunks for the same reason as the state labels above.
const WINDOW_TYPE_NOUNS = new Map([
    [WindowType.DIALOG, () => _('dialog')],
    [WindowType.MODAL_DIALOG, () => _('modal dialog')],
    [WindowType.UTILITY, () => _('utility window')],
]);

function windowTypeNoun(windowType) {
    return (WINDOW_TYPE_NOUNS.get(windowType) ?? (() => _('window')))();
}

/**
 * Describes what windows a rule matches, as a sentence.
 *
 * A rule is an exact conjunction of the five structural attributes, so all of
 * them have to be named: naming only the unusual ones would hide part of what
 * the rule matches. The two parent-related attributes fold into one phrase,
 * because an attached dialog always has a parent and so they cannot vary
 * independently.
 */
function windowKindSentence(properties) {
    if (!properties)
        return '';

    const size = properties.allows_resize === false ? _('Fixed-size') : _('Resizable');
    const server = properties.client_type === 'x11' ? _('X11') : _('Wayland');

    let parent;
    if (!properties.has_parent)
        parent = _('with no parent');
    else if (properties.attached_dialog)
        parent = _('attached to its parent');
    else
        parent = _('with a parent');

    // The template is the translatable unit, so a language can reorder the
    // sentence; each fragment above is translated on its own.
    return _('{size} {server} {type}, {parent}')
        .replace('{size}', size)
        .replace('{server}', server)
        .replace('{type}', windowTypeNoun(properties.window_type))
        .replace('{parent}', parent);
}

/**
 * Adw group and row labels are parsed as Pango markup, and both translated text
 * and application names can contain '&' or '<'. Escape them so they stay literal;
 * Adw.Toast and Adw.AlertDialog take plain text and must not be escaped. A bare
 * Gtk.Label defaults to use-markup=FALSE, so it takes raw text as well.
 */
function asMarkup(text) {
    return GLib.markup_escape_text(String(text), -1);
}

/** 'org.gnome.Nautilus.desktop' -> 'org.gnome.Nautilus' */
function stripDesktopSuffix(id) {
    return id.endsWith('.desktop') ? id.slice(0, -8) : id;
}

/**
 * Enumerate installed desktop application metadata
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

/**
 * Look up installed application metadata by wmClass
 */
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

/**
 * D-Bus inspection helper to pick a window
 */
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
    if (Adw.AlertDialog) {
        const dialog = new Adw.AlertDialog({
            heading,
            body,
        });
        dialog.add_response('ok', _('OK'));
        dialog.present(parentWindow);
    } else {
        const dialog = new Adw.MessageDialog({
            heading,
            body,
            transient_for: parentWindow,
        });
        dialog.add_response('ok', _('OK'));
        dialog.present();
    }
}


export default class WindowNativizerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const installedApps = getInstalledApps();

        // Picking hides the preferences window; the user can still close it while
        // the (deliberately modal) picker is up, in which case the D-Bus reply
        // arrives for a dead window. Everything touching the UI checks this.
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

        // One rule per window kind. The state names which decoration axes are ours;
        // the runtime applies exactly that (docs/rule-model.md). Picking a window
        // that looks wrong sets its kind the other way.
        const pickButton = new Gtk.Button({
            icon_name: 'find-location-symbolic',
            tooltip_text: _('Pick a window that looks wrong; the rule will be set the other way'),
            valign: Gtk.Align.CENTER,
            margin_start: 18,
        });

        const rulesGroup = new Adw.PreferencesGroup({
            title: asMarkup(_('Window Rules')),
            description: asMarkup(_('Each rule names which decorations are ours for one window kind.')),
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

            // A count saves opening a group just to see whether it holds anything.
            rulesGroup.title = entries.length > 0
                ? `${asMarkup(_('Window Rules'))} <span size="small" alpha="55%">· ${entries.length}</span>`
                : asMarkup(_('Window Rules'));

            if (entries.length === 0) {
                const emptyRow = new Adw.ActionRow({
                    title: asMarkup(_('Use the button above to pick a window that looks wrong.')),
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

        // Rows are torn down from inside their own widgets' signal handlers, so
        // defer the rebuild to idle time rather than destroying the emitter. One
        // pending rebuild is enough: it reads the rules when it runs, not here.
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

            const row = new Adw.ActionRow({
                title: asMarkup(name),
                subtitle: asMarkup(windowKindSentence(properties)),
                subtitle_lines: 2,
                tooltip_text: ruleKey,
            });

            row.add_prefix(appInfo?.icon
                ? new Gtk.Image({gicon: appInfo.icon, pixel_size: 32})
                : new Gtk.Image({icon_name: 'window-new-symbolic', pixel_size: 24}));

            // One dropdown for the four states, in grammar order. A plain string
            // list, so the items carry no icons.
            const dropdown = new Gtk.DropDown({
                model: Gtk.StringList.new(RULE_STATES.map(stateLabel)),
                selected: Math.max(0, RULE_STATES.indexOf(state)),
                valign: Gtk.Align.CENTER,
            });
            dropdown.connect('notify::selected', () => {
                const nextState = RULE_STATES[dropdown.selected];
                if (!nextState)
                    return;
                setWindowRules(settings, withRule(getWindowRules(settings), ruleKey, nextState));
            });
            row.add_suffix(dropdown);

            const deleteButton = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                css_classes: ['flat', 'destructive-action'],
                valign: Gtk.Align.CENTER,
                margin_start: 6,
                tooltip_text: _('Remove Rule'),
            });
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
                        _('Could not connect to Window Nativizer extension. Please ensure the extension is enabled.'));
                    return;
                }

                // An empty result is how the inspector reports a cancelled pick
                // (Escape, right-click) and one abandoned because the extension was
                // being disabled. Neither is a failure, so say nothing.
                if (!props || Object.keys(props).length === 0)
                    return;

                const ruleKey = buildRuleKeyFromProperties(props);

                if (!ruleKey) {
                    window.add_toast(new Adw.Toast({
                        title: _('No rule added: this window could not be identified.'),
                    }));
                    return;
                }

                // The extension suggests the state that corrects what the window
                // looks like now. An absent suggestion means an extension too old to
                // judge, so fall back to the full native look; an absent effect
                // answer means the same, and the rule goes in.
                const state = RULE_STATES.includes(props.suggestedState)
                    ? props.suggestedState
                    : RuleState.BOTH;

                if (props.suggestedStateWouldChange === 'false') {
                    window.add_toast(new Adw.Toast({
                        title: _('No rule added: it would have no effect on a window of this kind.'),
                    }));
                    return;
                }

                setWindowRules(settings, withRule(getWindowRules(settings), ruleKey, state));

                // Never claim success on a write the settings layer rejected.
                if (!Object.prototype.hasOwnProperty.call(getWindowRules(settings), ruleKey)) {
                    window.add_toast(new Adw.Toast({
                        title: _('No rule added: the rule could not be saved.'),
                    }));
                    return;
                }

                renderRules();

                // The row is visible straight away, but name the state it landed on:
                // the heuristic's guess is otherwise not spelled out anywhere.
                window.add_toast(new Adw.Toast({
                    title: _('Rule set to: %s').replace('%s', stateLabel(state)),
                }));
            });
        });

        renderRules();
    }
}
