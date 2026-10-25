/** The interactive pick: ask the extension over D-Bus, then turn its answer into a correction. */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {parseRuleKey} from '../lib/rules.js';
import {asMarkup, neverDecorated, ruleSummaryText} from '../lib/rulePresenter.js';
import {findAppInfoByWmClass} from '../lib/appInfo.js';
import {INSPECTOR_DBUS_NAME, INSPECTOR_DBUS_PATH} from '../lib/pickWire.js';
import {PickRefusal, pickVerdict} from '../lib/pickAnswer.js';
import {readEntries, setWindowRule} from '../lib/settings.js';
import {showError} from './ruleUi.js';

/** Thunks, not strings: this module loads before the process binds the gettext domain. */
const PICK_REFUSALS = {
    [PickRefusal.UNIDENTIFIABLE]: () => _('No correction added: this window could not be identified'),
    [PickRefusal.NEVER_DECORATED]: () => neverDecorated(),
    // Written as an escape: the msgid keys a translation, so a literal dash would drop it.
    [PickRefusal.NO_SUGGESTION]: () =>
        _('No correction added: the extension did not answer \u2014 restart the session and pick again'),
    [PickRefusal.NO_EFFECT]: () =>
        _('No correction added: it would have no effect on a window of this kind'),
};

/** A reason this build does not know is still a kind nothing acts on: the fallback says so. */
function pickRefusalText(refusal) {
    return (PICK_REFUSALS[refusal] ?? neverDecorated)();
}

function inspectWindow(callback, cancellable = null) {
    // The method takes a debug boolean; `false` is the quiet interactive pick the extension wants.
    Gio.DBus.session.call(
        INSPECTOR_DBUS_NAME,
        INSPECTOR_DBUS_PATH,
        INSPECTOR_DBUS_NAME,
        'PickWindow',
        new GLib.Variant('(b)', [false]),
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

export function setupWindowPickerAction(pickButton, ctx, onRulePicked) {
    const {window, settings, installedApps, windowCancellable, isWindowAlive} = ctx;
    const pickWindow = callback => inspectWindow(callback, windowCancellable);
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
                        : _('Could not connect to the Window Nativizer extension: it is not enabled'));
                return;
            }

            // Empty means a cancelled pick or the extension disabling, not an error.
            if (!props || Object.keys(props).length === 0)
                return;

            // One place decides what a pick is worth; only the words for each reason live here.
            const verdict = pickVerdict(props);
            if (verdict.refusal) {
                window.add_toast(new Adw.Toast({title: asMarkup(pickRefusalText(verdict.refusal))}));
                return;
            }

            const {key: ruleKey, state} = verdict;

            const existingEntries = readEntries(settings);
            const isExisting = Object.prototype.hasOwnProperty.call(existingEntries, ruleKey);

            // One write: the rule and the sample it came from are one entry.
            setWindowRule(settings, ruleKey, state,
                typeof props.windowTitle === 'string' ? props.windowTitle : '');

            // Read-back is a persistence check: sanitize inside setWindowRule may drop the entry.
            if (!Object.prototype.hasOwnProperty.call(readEntries(settings), ruleKey)) {
                window.add_toast(new Adw.Toast({
                    title: _('No correction added: it could not be saved'),
                }));
                return;
            }

            onRulePicked(ruleKey);

            const {baseWmClass} = parseRuleKey(ruleKey);
            const appInfo = findAppInfoByWmClass(baseWmClass, installedApps);
            const name = appInfo?.name || baseWmClass || ruleKey;

            const toastTitle = isExisting
                ? _('Correction updated for %s: %s').format(name, ruleSummaryText(state))
                : _('Correction added for %s: %s').format(name, ruleSummaryText(state));

            window.add_toast(new Adw.Toast({
                title: asMarkup(toastTitle),
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
