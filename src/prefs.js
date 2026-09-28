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
import {isDecoratableWindowType, ruleAxisCapabilities} from './lib/detector.js';
import {
    INSPECTOR_DBUS_NAME,
    INSPECTOR_DBUS_PATH,
    buildRuleKeyFromProperties,
} from './lib/pick.js';
import {
    getRuleTitles,
    getWindowRules,
    setWindowRule,
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

// An axis row is titled with the axis itself - the same word the unavailable row above it uses for
// the same axis. Naming the correction as well ("Correct corners") made the two rows read as two
// different things, and "Correct" is ambiguous in English besides. What turning the switch on means
// is on the switch; see `_buildAxisSwitch`.

/**
 * @param {string} axis
 * @returns {string} e.g. "Corners: corrected"
 */
function correctedAxisWord(axis) {
    // Translators: %s is the axis name, e.g. "Corners".
    return _('%s: corrected').format(axisName(axis));
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
 * The shared capability answer, adapted from a rule key's own field names.
 * @param {{window_type:number,allows_resize:boolean,has_ssd:boolean}|null} properties
 * @returns {Record<string, boolean>}
 */
function keyAxisCapabilities(properties) {
    return ruleAxisCapabilities({
        windowType: Number(properties?.window_type ?? WindowType.NORMAL),
        allowsResize: properties?.allows_resize !== false,
        hasSsd: Boolean(properties?.has_ssd),
    });
}

// Translators: Shown where no rule axis applies at all.
function neverDecorated() {
    return _('Windows of this kind are never decorated');
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
            return _('The window frame can already be resized');
        }
        // Translators: Shown where a resize control would be, but cannot be used.
        return _('Fixed-size windows have no resize handle');
    }
    return neverDecorated();
}

/**
 * The axes a state corrects, for toasts, e.g. "Corners, Shadow".
 * @param {string} state Canonical stored state
 * @returns {string}
 */
function ruleSummaryText(state) {
    const corrected = parseRuleState(state);
    if (!corrected)
        return state;
    return RULE_AXES
        .filter(axis => corrected.has(axis))
        .map(axis => axisName(axis))
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
    // Translators: %s is the client type and the window type, e.g. "Wayland window". If your
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
        frame = _('frame drawn by the system');
    } else if (properties.has_ring === false) {
        // Translators: The window declares no shadow margin ring of its own.
        frame = _('no shadow margins');
    }

    if (frame) {
        // Translators: %s is the entity, parent, frame clause, and size, in that order.
        return _('%s, %s, %s, %s').format(entity, parent, frame, size);
    }

    // Translators: %s is the entity, parent, and size, in that order.
    return _('%s, %s, %s').format(entity, parent, size);
}

/**
 * Escape for the Adw properties that parse Pango markup (rows and preference groups); Toast,
 * AlertDialog and a bare Gtk.Label take plain text.
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

/**
 * @param {Function} callback
 * @param {Gio.Cancellable} [cancellable] - Cancelled when the preferences window closes. Without it
 *   a reply that lands after that keeps this closure's window and settings alive until the call
 *   gives up at its 60s timeout.
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


// One bundled icon per axis, plus the stock icon that stands in when the
// bundle is missing; see src/icons/NOTICE.
const AXIS_ICONS = {
    [RuleAxis.CORNERS]: {bundled: 'winnativizer-corners-symbolic', fallback: 'window-restore-symbolic'},
    [RuleAxis.SHADOW]: {bundled: 'winnativizer-shadow-symbolic', fallback: 'edit-copy-symbolic'},
    [RuleAxis.RESIZE]: {bundled: 'winnativizer-resize-symbolic', fallback: 'view-restore-symbolic'},
};

function _registerIconThemePath(iconTheme) {
    try {
        const moduleDir = import.meta.url.slice(0, import.meta.url.lastIndexOf('/') + 1);
        iconTheme.add_search_path(`${decodeURI(moduleDir.replace(/^file:\/\//, ''))}icons`);
    } catch {
        // Search path stays stock; per-axis fallbacks cover it.
    }
}

function _createAxisImage(axis, iconTheme) {
    const {bundled, fallback} = AXIS_ICONS[axis];
    return new Gtk.Image({
        icon_name: iconTheme.has_icon(bundled) ? bundled : fallback,
        pixel_size: 16,
        valign: Gtk.Align.CENTER,
    });
}

function _populateAxisIcons(box, correctedAxes, caps, iconTheme) {
    let child = box.get_first_child();
    while (child) {
        const next = child.get_next_sibling();
        box.remove(child);
        child = next;
    }
    const tips = [];
    for (const axis of RULE_AXES) {
        if (!caps[axis] || !correctedAxes.has(axis))
            continue;
        const word = correctedAxisWord(axis);
        const icon = _createAxisImage(axis, iconTheme);
        icon.set_tooltip_text(word);
        icon.update_property([Gtk.AccessibleProperty.LABEL], [word]);
        box.append(icon);
        tips.push(word);
    }
    box.set_tooltip_text(tips.join(' · '));
}

/**
 * Immutable ambient preferences context passed across UI builders.
 * @typedef {object} PrefsContext
 * @property {Adw.PreferencesWindow} window - Host preferences window
 * @property {Gio.Settings} settings - Extension GSettings instance
 * @property {Map<string, Gio.AppInfo>} installedApps - Installed desktop apps map
 * @property {Gtk.IconTheme} iconTheme - Active display icon theme
 * @property {() => boolean} isWindowAlive - Guard checking if preferences window is alive
 */

// The platform's own switch: an axis is binary (follow the decision, or correct it),
// and the row's title names the correction, so its state is unambiguous.
function _buildAxisSwitch(axis, corrected, onChange) {
    const name = axisName(axis);
    // Translators: Tooltip on a correction switch: turning it on reverses the automatic decision.
    const hint = _('Turn on to correct the automatic decision for this window kind');
    const switchRow = new Adw.SwitchRow({
        title: asMarkup(name),
        tooltip_text: hint,
        active: corrected.has(axis),
    });
    switchRow.update_property([Gtk.AccessibleProperty.LABEL], [name]);
    // The same text, for assistive technology.
    switchRow.update_property([Gtk.AccessibleProperty.DESCRIPTION], [hint]);
    switchRow.connect('notify::active', () => onChange(axis, switchRow.active));
    return switchRow;
}

function _buildRuleRow(ruleKey, state, sample, ctx, onRefresh) {
    const {settings, installedApps, iconTheme} = ctx;
    const {baseWmClass, properties} = parseRuleKey(ruleKey);
    const appInfo = findAppInfoByWmClass(baseWmClass, installedApps);
    const name = appInfo?.name || baseWmClass || ruleKey;
    const corrected = parseRuleState(state) ?? new Set();
    const caps = keyAxisCapabilities(properties);
    const decoratable = isDecoratableKind(properties);

    // Dimmed sample of the kind, not its name - see docs/rule-model.md.
    const row = new Adw.ExpanderRow({
        title: sample && sample !== name
            ? `${asMarkup(name)} <span alpha="55%">${asMarkup(sample)}</span>`
            : asMarkup(name),
        subtitle: asMarkup(windowKindSentence(properties)),
        // Ellipsized by Pango: no character cap can know the row's width.
        title_lines: 1,
        subtitle_lines: 2,
    });
    row.update_property([Gtk.AccessibleProperty.LABEL], [name]);
    // Only when the row actually shows it: a sample equal to the app name is not shown,
    // so it must not be explained either.
    if (sample && sample !== name)
        row.set_tooltip_text(_('Picked from the window “%s”').format(sample));

    row.add_prefix(appInfo?.icon
        ? new Gtk.Image({gicon: appInfo.icon, pixel_size: 32})
        : new Gtk.Image({icon_name: 'window-new-symbolic', pixel_size: 24}));

    const iconBox = new Gtk.Box({spacing: 8, valign: Gtk.Align.CENTER});
    _populateAxisIcons(iconBox, corrected, caps, iconTheme);

    // ExpanderRow prepends suffixes to keep its arrow last, so add in
    // reverse visual order: [icons] … [delete][chevron].
    const deleteButton = new Gtk.Button({
        icon_name: 'user-trash-symbolic',
        css_classes: ['flat', 'destructive-action'],
        valign: Gtk.Align.CENTER,
        margin_start: 12,
        tooltip_text: _('Revert to the automatic decision'),
    });
    deleteButton.update_property([Gtk.AccessibleProperty.LABEL], [_('Revert to the automatic decision')]);
    deleteButton.connect('clicked', () => {
        const rules = getWindowRules(settings);
        delete rules[ruleKey];
        // One write: the entry carries its own title, so it goes with the rule.
        setWindowRules(settings, rules);
        onRefresh();
    });
    row.add_suffix(deleteButton);
    row.add_suffix(iconBox);

    const onAxisChange = (axis, isCorrected) => {
        const storedRules = getWindowRules(settings);
        const current = parseRuleState(storedRules[ruleKey]) ?? new Set();
        const next = new Set(current);
        if (isCorrected)
            next.add(axis);
        else
            next.delete(axis);
        const stored = withRule(storedRules, ruleKey, buildRuleState(next));
        setWindowRules(settings, stored);
        const canonical = stored[ruleKey];
        if (!canonical) {
            // Nothing reversed is no rule: the row is the rule, so it goes with it.
            onRefresh();
            return;
        }
        _populateAxisIcons(iconBox, parseRuleState(canonical), caps, iconTheme);
    };

    // The kind sentence in the header already says what the rule applies to; the
    // group description says what the switches do, so the body is only the axes.
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
        row.add_row(_buildAxisSwitch(axis, corrected, onAxisChange));
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
                // A second pick while one is in progress comes back as G_IO_ERROR_BUSY; say so
                // instead of blaming the extension.
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

            const ruleKey = buildRuleKeyFromProperties(props);

            if (!ruleKey) {
                window.add_toast(new Adw.Toast({
                    title: _('No correction added: this window could not be identified'),
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

            const existingRules = getWindowRules(settings);
            const isExisting = Object.prototype.hasOwnProperty.call(existingRules, ruleKey);

            // One write: the rule and the sample it came from are one entry.
            setWindowRule(settings, ruleKey, state,
                typeof props.windowTitle === 'string' ? props.windowTitle : '');

            // Read-back is a persistence check, not redundancy: sanitize inside
            // setWindowRule may drop what it staged.
            if (!Object.prototype.hasOwnProperty.call(getWindowRules(settings), ruleKey)) {
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

function _setupCorrectionsGroup(page, ctx) {
    const {settings, isWindowAlive} = ctx;

    // Adwaita's group-with-a-header-suffix pattern: the button names its action and wears
    // the add icon, flat, so it reads as part of the header rather than a control in the
    // list. ButtonContent, not Button's own label/icon-name: GTK4 keeps those two in one
    // child slot, so setting both leaves only the last one. The button's label is its
    // accessible name, so it needs no explicit one.
    const pickButton = new Gtk.Button({
        child: new Adw.ButtonContent({
            icon_name: 'list-add-symbolic',
            label: _('Pick window…'),
        }),
        css_classes: ['flat'],
        tooltip_text: _('The correction applies to every window of its kind'),
        valign: Gtk.Align.CENTER,
        margin_start: 18,
    });

    // Both of a group's labels parse markup - adw-preferences-group.ui sets use-markup on the title
    // and on the description - so they are escaped exactly like the rows are.
    const rulesGroup = new Adw.PreferencesGroup({
        title: asMarkup(_('Corrections')),
        description: asMarkup(_('Corrections apply per window kind; a switch corrects the automatic decision for one axis')),
        header_suffix: pickButton,
    });
    page.add(rulesGroup);

    const rows = [];

    // Destroyed from own signal: defer rebuild to idle. One pending is enough, and the key to
    // highlight rides along, so a rebuild merged from several triggers (our own write's
    // `changed`, a pick) still highlights once - a concurrent rebuild would otherwise clear
    // the highlight the pick just set.
    let renderScheduled = false;
    let pendingHighlight = null;
    const scheduleRenderRules = highlightKey => {
        if (highlightKey !== undefined)
            pendingHighlight = highlightKey;
        if (renderScheduled)
            return;
        renderScheduled = true;
        // The id is deliberately not kept: the callback removes itself, and `isWindowAlive()` is
        // what makes a tick that lands after the window closed harmless - cancelling buys nothing.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            renderScheduled = false;
            if (isWindowAlive())
                renderRules(pendingHighlight);
            pendingHighlight = null;
            return GLib.SOURCE_REMOVE;
        });
    };

    // The rules can also change from outside this window (another prefs instance, dconf):
    // without this the rows drift until the window is reopened.
    settings.connect('changed::window-rules', () => scheduleRenderRules());

    const renderRules = highlightKey => {
        for (const row of rows)
            rulesGroup.remove(row);
        rows.length = 0;

        const rules = getWindowRules(settings);
        const titles = getRuleTitles(settings);
        const entries = Object.entries(rules);

        if (entries.length === 0) {
            const emptyRow = new Adw.ActionRow({
                title: asMarkup(_('Use the button above to pick a window that is decorated incorrectly')),
                sensitive: false,
            });
            rulesGroup.add(emptyRow);
            rows.push(emptyRow);
            return;
        }

        let focusedRow = null;
        for (const [ruleKey, state] of entries) {
            const row = _buildRuleRow(ruleKey, state, titles[ruleKey] ?? '', ctx, scheduleRenderRules);
            rulesGroup.add(row);
            rows.push(row);
            if (highlightKey && ruleKey === highlightKey) {
                focusedRow = row;
                row.set_expanded(true);
            }
        }

        if (focusedRow) {
            // One-shot, like the render above: nothing to cancel, and the guard covers a window
            // that closed in the meantime.
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                // A rebuild (an external rule change) may have replaced the rows by now; the
                // old row is no longer in `rows`, so grabbing focus on it would touch a
                // destroyed widget.
                if (isWindowAlive() && rows.includes(focusedRow))
                    focusedRow.grab_focus();
                return GLib.SOURCE_REMOVE;
            });
        }
    };

    _setupWindowPickerAction(pickButton, ctx, ruleKey => scheduleRenderRules(ruleKey));

    renderRules();
}

export default class WindowNativizerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const installedApps = getInstalledApps();
        const iconTheme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        _registerIconThemePath(iconTheme);

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
