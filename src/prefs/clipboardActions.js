/** Rules out of the clipboard and back, and the toast that says what happened. */

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';

import {gettext as _, ngettext} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {asMarkup} from '../lib/rulePresenter.js';
import {
    applyConflictResolutions,
    exportRulesJson,
    importRulesJson,
    readEntries,
    setAllRuleEntries,
} from '../lib/settings.js';
import {showConflictDialog} from './conflictDialog.js';

export function exportToClipboard(ctx) {
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
    window.add_toast(new Adw.Toast({title: asMarkup(title)}));
}

export function importFromClipboard(ctx, scheduleRenderRules) {
    const {window, settings, windowCancellable, isWindowAlive} = ctx;
    const clipboard = window.get_clipboard() ?? Gdk.Display.get_default()?.get_clipboard();
    if (!clipboard)
        return;

    clipboard.read_text_async(windowCancellable, (_clip, res) => {
        if (!isWindowAlive())
            return;

        let text = null;
        try {
            text = clipboard.read_text_finish(res);
        } catch {
            // Read failed or cancelled.
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

                    const {nextEntries, landedKeys} = applyConflictResolutions(
                        existing,
                        importResult.nonConflictingEntries,
                        importResult.cleanImported,
                        resolutions
                    );
                    setAllRuleEntries(settings, nextEntries);
                    reportImport(window, landedKeys, scheduleRenderRules);
                });
                return;
            }

            const {nextEntries, addedCount, updatedCount, importedKeys} = importResult;
            const changed = addedCount + updatedCount > 0;
            if (changed)
                setAllRuleEntries(settings, nextEntries);
            reportImport(window, changed ? importedKeys : [], scheduleRenderRules);
        } catch (err) {
            window.add_toast(new Adw.Toast({
                title: asMarkup(_('Import failed: %s').format(err.message)),
            }));
        }
    });
}

/** The line an import ends on, whether or not the payload had conflicts to resolve. */
function reportImport(window, keys, scheduleRenderRules) {
    if (keys.length === 0) {
        scheduleRenderRules();
        window.add_toast(new Adw.Toast({
            title: _('All rules in clipboard are already up to date'),
        }));
        return;
    }
    scheduleRenderRules({importedKeys: keys});
    const title = ngettext('Imported %d rule successfully', 'Imported %d rules successfully',
        keys.length).format(keys.length);
    window.add_toast(new Adw.Toast({title: asMarkup(title)}));
}
