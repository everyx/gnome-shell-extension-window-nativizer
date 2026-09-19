// Interactive window picker — selection mechanics in docs/architecture.md.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    INSPECTOR_DBUS_NAME,
    INSPECTOR_DBUS_PATH,
    extractWindowProperties,
} from './pick.js';
import {ADWAITA_STYLE} from './adwaitaStyle.generated.js';
import {isDecoratableWindowType} from './detector.js';
import {resolveWindowIdentity} from './window.js';

const INSPECTOR_DBUS_IFACE_XML = `
<node>
  <interface name="${INSPECTOR_DBUS_NAME}">
    <method name="PickWindow">
      <arg type="a{ss}" direction="out" name="properties"/>
    </method>
  </interface>
</node>`;

export class InspectorService {
    constructor(manager = null) {
        this._manager = manager;

        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(INSPECTOR_DBUS_IFACE_XML, this);
        this._dbusImpl.export(Gio.DBus.session, INSPECTOR_DBUS_PATH);
        this._ownerId = Gio.DBus.session.own_name(
            INSPECTOR_DBUS_NAME,
            Gio.BusNameOwnerFlags.REPLACE,
            null,
            null
        );

        this._activeGrab = null;
        this._overlay = null;
        this._highlight = null;
        this._pendingInvocation = null;
    }

    destroy() {
        this._cancelInteractivePick();

        if (this._ownerId) {
            Gio.DBus.session.unown_name(this._ownerId);
            this._ownerId = null;
        }

        if (this._dbusImpl) {
            this._dbusImpl.unexport();
            this._dbusImpl = null;
        }
    }

    /** D-Bus method PickWindow — GJS async name is PickWindowAsync. */
    PickWindowAsync(_params, invocation) {
        if (this._pendingInvocation) {
            invocation.return_error_literal(
                Gio.IOErrorEnum,
                Gio.IOErrorEnum.BUSY,
                'Window inspection is already in progress'
            );
            return;
        }

        this._pendingInvocation = invocation;
        this._startInteractivePick();
    }

    _findTargetWindow(stageX, stageY) {
        const actors = global.get_window_actors?.() ?? [];
        // Hoisted out of the loop: the active workspace cannot change while one hit test enumerates windows.
        const activeWorkspace = global.workspace_manager?.get_active_workspace?.();
        for (let i = actors.length - 1; i >= 0; i--) {
            const winActor = actors[i];
            const win = winActor.meta_window ?? winActor.metaWindow;
            if (!win || win.minimized || (win.is_hidden && win.is_hidden()))
                continue;
            if (winActor.is_mapped && !winActor.is_mapped())
                continue;

            if (activeWorkspace && !win.is_on_all_workspaces?.() && !win.located_on_workspace?.(activeWorkspace))
                continue;

            const type = win.get_window_type?.() ?? Meta.WindowType.NORMAL;
            if (!isDecoratableWindowType(type))
                continue;

            const frame = win.get_frame_rect();
            if (stageX >= frame.x && stageX < frame.x + frame.width &&
                stageY >= frame.y && stageY < frame.y + frame.height)
                return win;
        }
        return null;
    }

    _startInteractivePick() {
        this._overlay = new St.Widget({
            name: 'WindowNativizerInspectorOverlay',
            reactive: true,
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });
        Main.uiGroup.add_child(this._overlay);

        // The accent colour is the `-st-accent-color` CSS term, not a literal:
        // St resolves it from St.Settings:accent-color and re-resolves every mapped
        // widget's style when that setting changes, so the highlight follows the
        // system accent without a signal of our own to connect.
        this._highlight = new St.Widget({
            name: 'WindowNativizerInspectorHighlight',
            style: `border: 3px solid -st-accent-color; background-color: st-transparentize(-st-accent-color, 0.85); border-radius: ${ADWAITA_STYLE.window.radius}px;`,
            visible: false,
        });
        Main.uiGroup.add_child(this._highlight);

        this._overlay.connect('motion-event', (_actor, event) => {
            const [x, y] = event.get_coords();
            const targetWin = this._findTargetWindow(x, y);
            if (targetWin) {
                const frame = targetWin.get_frame_rect();
                this._highlight.set_position(frame.x, frame.y);
                this._highlight.set_size(frame.width, frame.height);
                this._highlight.visible = true;
            } else {
                this._highlight.visible = false;
            }
            return Clutter.EVENT_STOP;
        });

        this._overlay.connect('button-press-event', (_actor, event) => {
            const button = event.get_button();
            if (button === Clutter.BUTTON_PRIMARY) {
                const [x, y] = event.get_coords();
                const targetWin = this._findTargetWindow(x, y);
                this._finishInteractivePick(targetWin);
            } else {
                this._finishInteractivePick(null);
            }
            return Clutter.EVENT_STOP;
        });

        this._overlay.connect('key-press-event', (_actor, event) => {
            const symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Escape)
                this._finishInteractivePick(null);
            return Clutter.EVENT_STOP;
        });

        try {
            this._activeGrab = Main.pushModal(this._overlay);
        } catch (e) {
            // Must answer the D-Bus call or the prefs window hangs waiting.
            logError(e, '[window-nativizer] Could not grab the window picker');
            this._finishInteractivePick(null);
            return;
        }
        try {
            global.stage?.set_cursor_type?.(Clutter.CursorType.CROSSHAIR);
        } catch {
            // stage may be unmanaging
        }
    }

    _finishInteractivePick(win) {
        const invocation = this._pendingInvocation;
        this._pendingInvocation = null;

        this._cleanupPickUI();

        if (!invocation)
            return;

        if (!win) {
            invocation.return_value(new GLib.Variant('(a{ss})', [{}]));
            return;
        }

        const properties = extractWindowProperties(win, resolveWindowIdentity(win));

        const state = this._manager?.suggestedRuleState?.(win);
        if (typeof state === 'string') {
            properties.suggestedState = state;
            const changes = this._manager?.suggestedRuleWouldChange?.(win, state);
            if (typeof changes === 'boolean')
                properties.suggestedStateWouldChange = String(changes);
        }

        invocation.return_value(new GLib.Variant('(a{ss})', [properties]));
    }

    _cancelInteractivePick() {
        if (this._pendingInvocation) {
            const inv = this._pendingInvocation;
            this._pendingInvocation = null;
            try {
                inv.return_value(new GLib.Variant('(a{ss})', [{}]));
            } catch {
                // invocation already answered
            }
        }
        this._cleanupPickUI();
    }

    _cleanupPickUI() {
        // popModal can throw "incorrect pop" if the grab was already released;
        // cursor and overlay must be restored either way or a crosshair leaks.
        try {
            if (this._activeGrab)
                Main.popModal(this._activeGrab);
        } catch (e) {
            logError(e, '[window-nativizer] Failed to release the window picker grab');
        } finally {
            this._activeGrab = null;
        }

        try {
            global.stage?.set_cursor_type?.(Clutter.CursorType.DEFAULT);
        } catch {
            // stage may be unmanaging
        }

        this._highlight?.destroy();
        this._highlight = null;

        this._overlay?.destroy();
        this._overlay = null;
    }
}
