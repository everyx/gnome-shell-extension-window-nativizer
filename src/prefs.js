import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {ExtensionPreferences, gettext as _, ngettext} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {
    RULE_AXES,
    buildRuleState,
    kindFromProperties,
    kindId,
    parseRuleState,
} from './lib/rules.js';
import {
    axisName,
    axisUnavailableReason,
    isDecoratableKind,
    keyAxisCapabilities,
    neverDecorated,
    ruleSummaryText,
    asMarkup,
} from './lib/rulePresenter.js';
import {
    getInstalledApps,
    findAppInfoByWmClass,
} from './lib/appInfo.js';
import {
    INSPECTOR_DBUS_NAME,
    INSPECTOR_DBUS_PATH,
} from './lib/pick.js';
import {
    setWindowRule,
    readEntries,
    setAllRuleEntries,
    exportRulesJson,
    importRulesJson,
    applyConflictResolutions,
} from './lib/settings.js';
import {showConflictDialog} from './prefs/conflictDialog.js';
import {
    registerIconThemePath,
    populateAxisIcons,
    buildAxisSwitch,
    setupRuleRowHeader,
    ensureCustomStyles,
} from './prefs/ruleUi.js';

/**
 * @param {Function} callback
 * @param {Gio.Cancellable} [cancellable] - Cancelled when the preferences window closes.
 */
function inspectWindow(callback, cancellable = null) {
    Gio.DBus.session.call(
        INSPECTOR_DBUS_NAME,
        INSPECTOR_DBUS_PATH,
        INSPECTOR_DBUS_NAME,
        'PickWindow',
        null,
        null,
        Gio.DBusCallFlags.NONE,
        60000,
        cancellable,
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

/**
 * Immutable ambient preferences context passed across UI builders.
 * @typedef {object} PrefsContext
 * @property {Adw.PreferencesWindow} window - Host preferences window
 * @property {Gio.Settings} settings - Extension GSettings instance
 * @property {Array<object>} installedApps - Installed desktop apps list
 * @property {Gtk.IconTheme} iconTheme - Active display icon theme
 * @property {Gio.Cancellable} pickCancellable - Cancellable tied to window destruction
 * @property {() => boolean} isWindowAlive - Guard checking if preferences window is alive
 */

/**
 * @typedef {object} DisplayRuleRow
 * @property {string} key - The kind's UI map id
 * @property {object} kind - The window kind the row describes
 * @property {string} state - Active axis state
 * @property {string} title - Picked window's sample title, shown dimmed beside the app name
 * @property {boolean} isRecentlyImported - Whether imported in current session
 * @property {string} appName - Resolved application display name
 * @property {object|null} appInfo - Cached Gio.AppInfo descriptor
 */

function _prepareDisplayRows(entries, installedApps, recentImportKeys = null) {
    const rows = [];
    for (const [key, entry] of Object.entries(entries ?? {})) {
        if (!entry || !entry.state || !entry.kind)
            continue;

        const appInfo = findAppInfoByWmClass(entry.kind.identity, installedApps);
        const appName = appInfo?.name || entry.kind.identity || key;

        rows.push({
            key,
            kind: entry.kind,
            state: entry.state,
            title: entry.title || '',
            isRecentlyImported: Boolean(recentImportKeys?.has(key)),
            appName,
            appInfo,
        });
    }

    // Tier 0: Recently imported items pinned to top
    // Tier 1: Existing items
    rows.sort((a, b) => {
        const tierA = a.isRecentlyImported ? 0 : 1;
        const tierB = b.isRecentlyImported ? 0 : 1;
        if (tierA !== tierB)
            return tierA - tierB;

        const nameCmp = a.appName.localeCompare(b.appName);
        return nameCmp !== 0 ? nameCmp : a.key.localeCompare(b.key);
    });

    return rows;
}

function _buildRuleRow(rowData, ctx, onRefresh) {
    const {settings, installedApps, iconTheme} = ctx;
    const {key: ruleKey, kind, state, title: sample, isRecentlyImported, appName, appInfo: cachedAppInfo} = rowData;
    const appInfo = cachedAppInfo ?? findAppInfoByWmClass(kind.identity, installedApps);
    const name = appName || appInfo?.name || kind.identity || ruleKey;
    const corrected = parseRuleState(state) ?? new Set();
    const caps = keyAxisCapabilities(kind);
    const decoratable = isDecoratableKind(kind);

    const row = new Adw.ExpanderRow();
    setupRuleRowHeader(row, {
        name,
        sampleTitle: sample,
        kind,
        appInfo,
    });
    if (isRecentlyImported)
        row.add_css_class('recently-imported');

    const deleteTooltip = _('Revert to the automatic decision');
    const deleteButton = new Gtk.Button({
        icon_name: 'user-trash-symbolic',
        css_classes: ['flat', 'destructive-action'],
        valign: Gtk.Align.CENTER,
        margin_start: 12,
        tooltip_text: deleteTooltip,
    });
    deleteButton.update_property([Gtk.AccessibleProperty.LABEL], [deleteTooltip]);
    deleteButton.connect('clicked', () => {
        const entries = readEntries(settings);
        delete entries[ruleKey];
        setAllRuleEntries(settings, entries);
        onRefresh();
    });

    const iconBox = new Gtk.Box({spacing: 8, valign: Gtk.Align.CENTER});
    populateAxisIcons(iconBox, corrected, caps, iconTheme);

    // ExpanderRow prepends suffixes to keep its arrow last, so add in
    // reverse visual order: [icons] … [delete][chevron].
    row.add_suffix(deleteButton);
    row.add_suffix(iconBox);

    const onAxisChange = (axis, isCorrected) => {
        const entries = readEntries(settings);
        const currentEntry = entries[ruleKey];
        if (!currentEntry)
            return;

        const currentAxes = parseRuleState(currentEntry.state) ?? new Set();
        const nextAxes = new Set(currentAxes);
        if (isCorrected)
            nextAxes.add(axis);
        else
            nextAxes.delete(axis);
        const nextStateStr = buildRuleState(nextAxes);

        if (!nextStateStr) {
            delete entries[ruleKey];
            setAllRuleEntries(settings, entries);
            onRefresh();
            return;
        }

        currentEntry.state = nextStateStr;
        setAllRuleEntries(settings, entries);
        populateAxisIcons(iconBox, nextAxes, caps, iconTheme);
    };

    for (const axis of RULE_AXES) {
        if (!caps[axis]) {
            const unavailableRow = new Adw.ActionRow({
                title: asMarkup(axisName(axis)),
                sensitive: false,
            });
            const reason = axisUnavailableReason(axis, decoratable, kind);
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
        row.add_row(buildAxisSwitch(axis, corrected, onAxisChange));
    }

    return row;
}

function _setupWindowPickerAction(pickButton, ctx, onRulePicked) {
    const {window, settings, installedApps, pickCancellable, isWindowAlive} = ctx;
    // Bound here rather than threaded through the call site below.
    const pickWindow = callback => inspectWindow(callback, pickCancellable);
    pickButton.connect('clicked', () => {
        window.set_visible(false);
        pickWindow((err, props) => {
            if (!isWindowAlive())
                return;

            window.set_visible(true);
            window.present();

            if (err) {
                const busy = err.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.BUSY) ?? false;
                showError(window,
                    _('Window Pick Failed'),
                    busy
                        ? _('A window is already being picked')
                        : _('Could not connect to the Window Nativizer extension — it is not enabled'));
                return;
            }

            // Empty = cancelled pick or extension disabling — not an error.
            if (!props || Object.keys(props).length === 0)
                return;

            const kind = kindFromProperties(props);

            if (!kind) {
                window.add_toast(new Adw.Toast({
                    title: _('No correction added: this window could not be identified'),
                }));
                return;
            }

            // The inspector only offers decoratable windows, so this guards
            // future callers - and names the reason instead of a generic refusal.
            if (!isDecoratableKind(kind)) {
                window.add_toast(new Adw.Toast({title: neverDecorated()}));
                return;
            }

            // The inspector sends the axes to correct. No answer means an extension
            // too old to judge (a Shell that has not reloaded since an update): the
            // pick is refused rather than guessed at.
            const suggested = typeof props.suggestedState === 'string'
                ? parseRuleState(props.suggestedState)
                : null;
            if (!suggested) {
                window.add_toast(new Adw.Toast({
                    title: _('No correction added: the extension did not answer — restart the session and pick again'),
                }));
                return;
            }

            // The picker's own pre-flight: a reversal of nothing stores no rule.
            if (props.suggestedStateWouldChange === 'false') {
                window.add_toast(new Adw.Toast({
                    title: _('No correction added: it would have no effect on a window of this kind'),
                }));
                return;
            }

            const state = buildRuleState(suggested);
            const ruleKey = kindId(kind);

            const existingEntries = readEntries(settings);
            const isExisting = Object.prototype.hasOwnProperty.call(existingEntries, ruleKey);

            // One write: the rule and the sample it came from are one entry.
            setWindowRule(settings, kind, state,
                typeof props.windowTitle === 'string' ? props.windowTitle : '');

            // Read-back is a persistence check, not redundancy: sanitize inside
            // setWindowRule may drop what it staged.
            if (!Object.prototype.hasOwnProperty.call(readEntries(settings), ruleKey)) {
                window.add_toast(new Adw.Toast({
                    title: _('No correction added: it could not be saved'),
                }));
                return;
            }

            onRulePicked(ruleKey);

            const appInfo = findAppInfoByWmClass(kind.identity, installedApps);
            const name = appInfo?.name || kind.identity || ruleKey;

            const toastTitle = isExisting
                ? _('Correction updated for %s: %s').format(name, ruleSummaryText(state))
                : _('Correction added for %s: %s').format(name, ruleSummaryText(state));

            window.add_toast(new Adw.Toast({
                title: toastTitle,
            }));

            // A rule outlives transient state, so a pick made mid-state says so.
            if (props.isMaximized === 'true' || props.isFullscreen === 'true' ||
                props.hasTileMatch === 'true') {
                window.add_toast(new Adw.Toast({
                    title: _('The correction takes effect once the window is restored'),
                }));
            }
        });
    });
}

function _exportToClipboard(ctx) {
    const {window, settings} = ctx;
    const entries = readEntries(settings);
    const count = Object.keys(entries).length;
    if (count === 0) {
        window.add_toast(new Adw.Toast({
            title: _('No corrections to export'),
        }));
        return;
    }

    const jsonText = exportRulesJson(entries);
    const clipboard = window.get_clipboard() ?? Gdk.Display.get_default()?.get_clipboard();
    if (!clipboard)
        return;

    clipboard.set(jsonText);
    const title = ngettext(
        'Exported %d correction to clipboard',
        'Exported %d corrections to clipboard',
        count
    ).format(count);
    window.add_toast(new Adw.Toast({title}));
}

function _importFromClipboard(ctx, scheduleRenderRules) {
    const {window, settings, isWindowAlive} = ctx;
    const clipboard = window.get_clipboard() ?? Gdk.Display.get_default()?.get_clipboard();
    if (!clipboard)
        return;

    clipboard.read_text_async(null, (_clip, res) => {
        if (!isWindowAlive())
            return;

        let text = null;
        try {
            text = clipboard.read_text_finish(res);
        } catch {
            // Read failed or cancelled
        }

        if (!text || !text.trim()) {
            window.add_toast(new Adw.Toast({
                title: _('Clipboard is empty or does not contain text'),
            }));
            return;
        }

        try {
            const existing = readEntries(settings);
            const importResult = importRulesJson(existing, text);

            if (importResult.hasConflicts) {
                showConflictDialog(window, ctx, importResult, resolutions => {
                    if (!isWindowAlive())
                        return;

                    const {nextEntries} = applyConflictResolutions(
                        existing,
                        importResult.nonConflictingEntries,
                        importResult.cleanImported,
                        resolutions
                    );
                    setAllRuleEntries(settings, nextEntries);

                    const actuallyImportedKeys = [];
                    for (const [k, entry] of Object.entries(importResult.cleanImported)) {
                        const existingEntry = existing[k];
                        if (!existingEntry)
                            actuallyImportedKeys.push(k);
                        else if (resolutions[k] === 'imported')
                            actuallyImportedKeys.push(k);
                        else if (resolutions[k] === undefined && existingEntry.state === entry.state && !existingEntry.title && entry.title)
                            actuallyImportedKeys.push(k);
                    }

                    if (actuallyImportedKeys.length === 0) {
                        scheduleRenderRules();
                        window.add_toast(new Adw.Toast({
                            title: _('All rules in clipboard are already up to date'),
                        }));
                        return;
                    }

                    scheduleRenderRules({importedKeys: actuallyImportedKeys});

                    const totalCount = actuallyImportedKeys.length;
                    const title = ngettext(
                        'Imported %d rule successfully',
                        'Imported %d rules successfully',
                        totalCount
                    ).format(totalCount);
                    window.add_toast(new Adw.Toast({title}));
                });
                return;
            }

            const {nextEntries, addedCount, updatedCount, importedKeys} = importResult;
            const changedCount = addedCount + updatedCount;
            if (changedCount === 0) {
                window.add_toast(new Adw.Toast({
                    title: _('All rules in clipboard are already up to date'),
                }));
                return;
            }

            setAllRuleEntries(settings, nextEntries);
            scheduleRenderRules({importedKeys});

            const totalCount = importedKeys.length;
            const title = ngettext(
                'Imported %d rule successfully',
                'Imported %d rules successfully',
                totalCount
            ).format(totalCount);
            window.add_toast(new Adw.Toast({title}));
        } catch (err) {
            window.add_toast(new Adw.Toast({
                title: _('Import failed: %s').format(err.message),
            }));
        }
    });
}

function _setupCorrectionsGroup(page, ctx) {
    const {settings, window, installedApps, isWindowAlive} = ctx;

    const pickButton = new Gtk.Button({
        child: new Adw.ButtonContent({
            icon_name: 'list-add-symbolic',
            label: _('Pick window…'),
        }),
        css_classes: ['flat'],
        tooltip_text: _('The correction applies to every window of its kind'),
        valign: Gtk.Align.CENTER,
    });

    const menu = new Gio.Menu();
    menu.append(_('Import from Clipboard'), 'win.import-clipboard');
    menu.append(_('Export to Clipboard'), 'win.export-clipboard');

    const menuButton = new Gtk.MenuButton({
        icon_name: 'view-more-symbolic',
        menu_model: menu,
        css_classes: ['flat'],
        tooltip_text: _('More actions'),
        valign: Gtk.Align.CENTER,
    });
    menuButton.update_property([Gtk.AccessibleProperty.LABEL], [_('More actions')]);

    const headerBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
        valign: Gtk.Align.CENTER,
        margin_start: 18,
    });
    headerBox.append(pickButton);
    headerBox.append(menuButton);

    const rulesGroup = new Adw.PreferencesGroup({
        title: asMarkup(_('Corrections')),
        description: asMarkup(_('Corrections apply per window kind; a switch corrects the automatic decision for one axis')),
        header_suffix: headerBox,
    });
    page.add(rulesGroup);

    const rows = [];

    let renderScheduled = false;
    let recentImportKeys = null;
    let pendingFocusKey = null;
    const scheduleRenderRules = ({importedKeys = null, focusKey = null} = {}) => {
        if (importedKeys)
            recentImportKeys = new Set(Array.isArray(importedKeys) ? importedKeys : [importedKeys]);
        if (focusKey)
            pendingFocusKey = focusKey;
        if (renderScheduled)
            return;
        renderScheduled = true;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            renderScheduled = false;
            if (isWindowAlive())
                renderRules();
            return GLib.SOURCE_REMOVE;
        });
    };

    const renderRules = () => {
        for (const row of rows)
            rulesGroup.remove(row);
        rows.length = 0;

        const entries = readEntries(settings);
        const displayRows = _prepareDisplayRows(entries, installedApps, recentImportKeys);

        if (displayRows.length === 0) {
            const emptyRow = new Adw.ActionRow({
                title: asMarkup(_('Use the button above to pick a window that is decorated incorrectly')),
                sensitive: false,
            });
            rulesGroup.add(emptyRow);
            rows.push(emptyRow);
            return;
        }

        let focusedRow = null;
        for (const rowData of displayRows) {
            const row = _buildRuleRow(rowData, ctx, () => scheduleRenderRules());
            rulesGroup.add(row);
            rows.push(row);
            if (pendingFocusKey && rowData.key === pendingFocusKey) {
                focusedRow = row;
                row.set_expanded(true);
            } else if (rowData.isRecentlyImported && !focusedRow) {
                focusedRow = row;
            }
        }
        pendingFocusKey = null;

        if (focusedRow && isWindowAlive())
            focusedRow.grab_focus();
    };

    const actionGroup = new Gio.SimpleActionGroup();

    const exportAction = new Gio.SimpleAction({name: 'export-clipboard'});
    exportAction.connect('activate', () => _exportToClipboard(ctx));
    actionGroup.add_action(exportAction);

    const importAction = new Gio.SimpleAction({name: 'import-clipboard'});
    importAction.connect('activate', () => _importFromClipboard(ctx, scheduleRenderRules));
    actionGroup.add_action(importAction);

    window.insert_action_group('win', actionGroup);

    _setupWindowPickerAction(pickButton, ctx, ruleKey => scheduleRenderRules({focusKey: ruleKey}));

    renderRules();
}

export default class WindowNativizerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        ensureCustomStyles();
        const settings = this.getSettings();
        const installedApps = getInstalledApps();
        const iconTheme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        registerIconThemePath(iconTheme);

        // Picker hides prefs window; reply may arrive after prefs closed — guard UI touches, and
        // cancel the call itself so its closure stops holding this window's widgets.
        let windowAlive = true;
        const pickCancellable = new Gio.Cancellable();
        window.connect('destroy', () => {
            windowAlive = false;
            pickCancellable.cancel();
        });

        const ctx = Object.freeze({
            window,
            settings,
            installedApps,
            iconTheme,
            pickCancellable,
            isWindowAlive: () => windowAlive,
        });

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const renderGroup = new Adw.PreferencesGroup({
            title: asMarkup(_('Display & Rendering')),
            description: asMarkup(_('Control how windows are decorated at different monitor scales')),
        });
        page.add(renderGroup);

        const crispRow = new Adw.SwitchRow({
            title: asMarkup(_('Prioritize crisp text')),
            subtitle: asMarkup(_('Skip rounded corners on monitors with fractional scaling to keep text sharp (the shadow is unaffected)')),
        });
        settings.bind('prefer-crisp-text', crispRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        renderGroup.add(crispRow);

        _setupCorrectionsGroup(page, ctx);
    }
}
