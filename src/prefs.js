/** The preferences entry point: build the page, hand the corrections module what it needs. */

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {asMarkup} from './lib/rulePresenter.js';
import {getInstalledApps} from './lib/appInfo.js';
import {registerIconThemePath, ensureCustomStyles} from './prefs/ruleUi.js';
import {setupCorrectionsGroup} from './prefs/rulePage.js';

export default class WindowNativizerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        ensureCustomStyles();
        const settings = this.getSettings();
        const installedApps = getInstalledApps();
        const iconTheme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        registerIconThemePath(iconTheme);

        // The reply may arrive after close: guard UI touches, and cancel to free the widgets.
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

        const overviewCornersRow = new Adw.SwitchRow({
            title: asMarkup(_('Force overview corners on every window')),
            subtitle: asMarkup(_('Round XWayland and the few Wayland windows left square for sharpness (they come out blurrier)')),
        });
        settings.bind('force-overview-corners', overviewCornersRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        renderGroup.add(overviewCornersRow);

        setupCorrectionsGroup(page, ctx);
    }
}
