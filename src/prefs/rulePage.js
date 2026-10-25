/** The corrections page: one row per window kind, with the pick, import and export it offers. */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {
    RULE_AXES,
    buildRuleState,
    parseRuleKey,
    parseRuleState,
} from '../lib/rules.js';
import {
    axisName,
    axisUnavailableReason,
    isDecoratableKind,
    keyAxisCapabilities,
    asMarkup,
} from '../lib/rulePresenter.js';
import {findAppInfoByWmClass} from '../lib/appInfo.js';
import {readEntries, setAllRuleEntries} from '../lib/settings.js';
import {
    populateAxisIcons,
    buildAxisSwitch,
    setupRuleRowHeader,
} from './ruleUi.js';
import {exportToClipboard, importFromClipboard} from './clipboardActions.js';
import {setupWindowPickerAction} from './windowPicker.js';

// Rebuilt on every change: the row list is the smallest thing that can stay honest.
function prepareDisplayRows(entries, installedApps, recentImportKeys = null) {
    const rows = [];
    for (const [key, entry] of Object.entries(entries ?? {})) {
        if (!entry || !entry.state)
            continue;

        const {baseWmClass} = parseRuleKey(key);
        const appInfo = findAppInfoByWmClass(baseWmClass, installedApps);
        const appName = appInfo?.name || baseWmClass || key;

        rows.push({
            key,
            state: entry.state,
            title: entry.title || '',
            isRecentlyImported: Boolean(recentImportKeys?.has(key)),
            appName,
            appInfo,
        });
    }

    // Tier 0: recently imported items pinned to top, tier 1: everything else.
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

function buildRuleRow(rowData, ctx, onRefresh) {
    const {settings, installedApps, iconTheme} = ctx;
    const {key: ruleKey, state, title: sample, isRecentlyImported, appName, appInfo: cachedAppInfo} = rowData;
    const {baseWmClass, properties} = parseRuleKey(ruleKey);
    const appInfo = cachedAppInfo ?? findAppInfoByWmClass(baseWmClass, installedApps);
    const name = appName || appInfo?.name || baseWmClass || ruleKey;
    const corrected = parseRuleState(state) ?? new Set();
    const caps = keyAxisCapabilities(properties);
    const decoratable = isDecoratableKind(properties);

    const row = new Adw.ExpanderRow();
    setupRuleRowHeader(row, {
        name,
        sampleTitle: sample,
        properties,
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

    // ExpanderRow prepends suffixes to keep its arrow last, so add in reverse visual order.
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
            const reason = axisUnavailableReason(axis, {decoratable, properties});
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

export function setupCorrectionsGroup(page, ctx) {
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
        const displayRows = prepareDisplayRows(entries, installedApps, recentImportKeys);

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
            const row = buildRuleRow(rowData, ctx, () => scheduleRenderRules());
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
    exportAction.connect('activate', () => exportToClipboard(ctx));
    actionGroup.add_action(exportAction);

    const importAction = new Gio.SimpleAction({name: 'import-clipboard'});
    importAction.connect('activate', () => importFromClipboard(ctx, scheduleRenderRules));
    actionGroup.add_action(importAction);

    window.insert_action_group('win', actionGroup);

    setupWindowPickerAction(pickButton, ctx, ruleKey => scheduleRenderRules({focusKey: ruleKey}));

    renderRules();
}
