import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {parseRuleKey, parseRuleState} from '../lib/rules.js';
import {keyAxisCapabilities, _, ngettext} from '../lib/rulePresenter.js';
import {findAppInfoByWmClass} from '../lib/appInfo.js';
import {setupRuleRowHeader, populateAxisIcons, ensureCustomStyles} from './ruleUi.js';

/** Modal dialog that resolves import conflicts between existing rules and imported rules. */
export function showConflictDialog(parentWindow, ctx, importResult, onApply) {
    ensureCustomStyles();
    const {conflicts} = importResult;

    const dialog = new Adw.Window({
        title: _('Resolve Import Conflicts'),
        transient_for: parentWindow,
        modal: true,
        destroy_with_parent: true,
        default_width: 620,
        default_height: 440,
    });

    const toolbarView = new Adw.ToolbarView();
    dialog.set_content(toolbarView);

    const headerBar = new Adw.HeaderBar({
        show_end_title_buttons: false,
        show_start_title_buttons: false,
    });
    toolbarView.add_top_bar(headerBar);

    const statusLabel = new Gtk.Label({
        label: '',
        css_classes: ['error'],
        wrap: true,
        xalign: 0,
        visible: false,
        margin_top: 8,
        margin_bottom: 8,
        margin_start: 12,
        margin_end: 12,
    });
    toolbarView.add_bottom_bar(statusLabel);

    const cancelButton = new Gtk.Button({
        label: _('Cancel'),
    });
    cancelButton.connect('clicked', () => dialog.close());
    headerBar.pack_start(cancelButton);

    const applyButton = new Gtk.Button({
        label: _('Apply'),
        css_classes: ['suggested-action'],
    });
    headerBar.pack_end(applyButton);

    const page = new Adw.PreferencesPage();
    toolbarView.set_content(page);

    const conflictCount = conflicts.length;
    const group = new Adw.PreferencesGroup({
        title: ngettext(
            '%d conflicting rule:',
            '%d conflicting rules:',
            conflictCount
        ).format(conflictCount),
    });
    group.add_css_class('conflict-group');
    page.add(group);

    const headerBtnsBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 8,
        margin_end: 8,
        valign: Gtk.Align.CENTER,
    });

    const checkAllKeep = new Gtk.CheckButton({
        label: _('Keep'),
        tooltip_text: _('Keep existing rules for all conflicts'),
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.CENTER,
    });
    const checkAllReplace = new Gtk.CheckButton({
        label: _('Replace'),
        tooltip_text: _('Replace existing rules with imported rules for all conflicts'),
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.CENTER,
    });
    headerBtnsBox.append(checkAllKeep);
    headerBtnsBox.append(checkAllReplace);
    group.set_header_suffix(headerBtnsBox);

    const keepColGroup = new Gtk.SizeGroup({mode: Gtk.SizeGroupMode.HORIZONTAL});
    const replaceColGroup = new Gtk.SizeGroup({mode: Gtk.SizeGroupMode.HORIZONTAL});
    keepColGroup.add_widget(checkAllKeep);
    replaceColGroup.add_widget(checkAllReplace);

    const rowControllers = [];

    let syncingHeader = false;
    const syncHeaderChecks = () => {
        if (syncingHeader)
            return;
        syncingHeader = true;

        let keepCount = 0;
        let replaceCount = 0;
        for (const ctrl of rowControllers) {
            if (ctrl.getChoice() === 'existing')
                keepCount++;
            else
                replaceCount++;
        }

        const total = rowControllers.length;
        const allKeep = keepCount === total;
        const allReplace = replaceCount === total;
        const mixed = !allKeep && !allReplace;
        checkAllKeep.set_inconsistent(mixed);
        checkAllKeep.set_active(allKeep);
        checkAllReplace.set_inconsistent(mixed);
        checkAllReplace.set_active(allReplace);

        syncingHeader = false;
    };

    for (const item of conflicts) {
        const {row, controller} = buildConflictRow(item, ctx, syncHeaderChecks);
        group.add(row);
        rowControllers.push(controller);
    }

    syncHeaderChecks();

    checkAllKeep.connect('toggled', () => {
        if (syncingHeader)
            return;
        for (const ctrl of rowControllers)
            ctrl.setKeep();
        syncHeaderChecks();
    });

    checkAllReplace.connect('toggled', () => {
        if (syncingHeader)
            return;
        for (const ctrl of rowControllers)
            ctrl.setReplace();
        syncHeaderChecks();
    });

    applyButton.connect('clicked', () => {
        const resolutions = {};
        for (const ctrl of rowControllers)
            resolutions[ctrl.key] = ctrl.getChoice();
        // Apply before closing: a rejected apply must leave the dialog open with the error showing.
        try {
            onApply(resolutions);
        } catch (err) {
            statusLabel.set_label(_('Could not apply the changes. Review your selections and try again.'));
            statusLabel.set_visible(true);
            console.error('Failed to apply conflict resolutions:', err);
            return;
        }
        dialog.close();
    });

    dialog.present();
}

/**
 * One conflict's row: the labels a rule is known by, its two toggle columns, and the choice they
 * currently hold. The caller owns where the row goes and what its toggles notify.
 */
function buildConflictRow(item, {installedApps, iconTheme}, onChoiceChanged) {
    const {key, existingState, importedState, existingTitle, importedTitle} = item;
    const {baseWmClass, properties} = parseRuleKey(key);
    const appInfo = findAppInfoByWmClass(baseWmClass, installedApps);
    const name = appInfo?.name || baseWmClass || key;

    const row = new Adw.ActionRow();
    setupRuleRowHeader(row, {
        name,
        sampleTitle: existingTitle || importedTitle,
        properties,
        appInfo,
    });

    const caps = keyAxisCapabilities(properties);
    const tg = new Adw.ToggleGroup({valign: Gtk.Align.CENTER});

    const toggleFor = corrected => {
        const box = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER, halign: Gtk.Align.CENTER});
        populateAxisIcons(box, corrected, caps, iconTheme, _('Automatic'));
        return new Adw.Toggle({child: box});
    };

    tg.add(toggleFor(parseRuleState(existingState) ?? new Set()));
    tg.add(toggleFor(parseRuleState(importedState) ?? new Set()));
    tg.set_active(1);
    tg.connect('notify::active', onChoiceChanged);

    row.add_suffix(tg);
    return {
        row,
        controller: {
            key,
            setKeep: () => tg.set_active(0),
            setReplace: () => tg.set_active(1),
            getChoice: () => tg.get_active() === 0 ? 'existing' : 'imported',
        },
    };
}
