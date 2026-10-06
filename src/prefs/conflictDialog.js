import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {parseRuleState} from '../lib/rules.js';
import {keyAxisCapabilities, _, ngettext} from '../lib/rulePresenter.js';
import {findAppInfoByWmClass} from '../lib/appInfo.js';
import {setupRuleRowHeader, populateAxisIcons, ensureCustomStyles} from './ruleUi.js';

/**
 * Presents a modal dialog for resolving import conflicts between existing rules and imported rules.
 * @param {Gtk.Window} parentWindow
 * @param {import('../prefs.js').PrefsContext} ctx
 * @param {object} importResult
 * @param {(resolutions: Record<string, 'existing'|'imported'>) => void} onApply
 */
export function showConflictDialog(parentWindow, ctx, importResult, onApply) {
    ensureCustomStyles();
    const {installedApps, iconTheme} = ctx;
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
        if (keepCount === total) {
            checkAllKeep.set_inconsistent(false);
            checkAllKeep.set_active(true);
            checkAllReplace.set_inconsistent(false);
            checkAllReplace.set_active(false);
        } else if (replaceCount === total) {
            checkAllKeep.set_inconsistent(false);
            checkAllKeep.set_active(false);
            checkAllReplace.set_inconsistent(false);
            checkAllReplace.set_active(true);
        } else {
            checkAllKeep.set_inconsistent(true);
            checkAllKeep.set_active(false);
            checkAllReplace.set_inconsistent(true);
            checkAllReplace.set_active(false);
        }

        syncingHeader = false;
    };

    for (const item of conflicts) {
        const {key, kind, existingState, importedState, existingTitle, importedTitle} = item;
        const appInfo = findAppInfoByWmClass(kind.identity, installedApps);
        const name = appInfo?.name || kind.identity || '';
        const sample = existingTitle || importedTitle;

        const row = new Adw.ActionRow();
        setupRuleRowHeader(row, {
            name,
            sampleTitle: sample,
            kind,
            appInfo,
        });

        const caps = keyAxisCapabilities(kind);
        const existingCorrected = parseRuleState(existingState) ?? new Set();
        const importedCorrected = parseRuleState(importedState) ?? new Set();

        const tg = new Adw.ToggleGroup({
            valign: Gtk.Align.CENTER,
        });

        const keepToggle = new Adw.Toggle();
        const keepIconBox = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER, halign: Gtk.Align.CENTER});
        populateAxisIcons(keepIconBox, existingCorrected, caps, iconTheme, _('Automatic'));
        keepToggle.set_child(keepIconBox);

        const replaceToggle = new Adw.Toggle();
        const replaceIconBox = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER, halign: Gtk.Align.CENTER});
        populateAxisIcons(replaceIconBox, importedCorrected, caps, iconTheme, _('Automatic'));
        replaceToggle.set_child(replaceIconBox);

        tg.add(keepToggle);
        tg.add(replaceToggle);
        tg.set_active(1);

        let child = tg.get_first_child();
        let btnIdx = 0;
        while (child) {
            if (child instanceof Gtk.ToggleButton) {
                if (btnIdx === 0)
                    keepColGroup.add_widget(child);
                else
                    replaceColGroup.add_widget(child);
                btnIdx++;
            }
            child = child.get_next_sibling();
        }

        tg.connect('notify::active', () => {
            syncHeaderChecks();
        });

        row.add_suffix(tg);
        group.add(row);

        rowControllers.push({
            key,
            setKeep: () => tg.set_active(0),
            setReplace: () => tg.set_active(1),
            getChoice: () => tg.get_active() === 0 ? 'existing' : 'imported',
        });
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
        dialog.close();
        try {
            onApply(resolutions);
        } catch (err) {
            console.error('Failed to apply conflict resolutions:', err);
        }
    });

    dialog.present();
}
