/**
 * The interactive picker: it dims the screen, lets the user click a window, and
 * answers the prefs process over the D-Bus method defined in lib/pick.js. How it
 * fits the two-process split, and the selection mechanics it borrows from KWin and
 * from GNOME's own, are in docs/architecture.md.
 */

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
        // The prefs process owns no window, so the picker has to answer whether a
        // rule for the picked kind would change anything.
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

    /**
     * D-Bus method: PickWindow (implemented via GJS async naming convention `PickWindowAsync`)
     */
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

    // ---------- Interactive Picking Implementation ----------

    _findTargetWindow(stageX, stageY) {
        const actors = global.get_window_actors?.() ?? [];
        // Hoisted: this runs on every pointer motion, and the active workspace cannot
        // change between the first and the last window of one hit test.
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

            // Runtime typelib enum: numeric values must align with src/lib/mutterRules.generated.js
            // (verified against upstream Mutter headers by tools/gen-mutter.mjs).
            const type = win.get_window_type?.() ?? Meta.WindowType.NORMAL;
            if (type === Meta.WindowType.DESKTOP || type === Meta.WindowType.DOCK)
                continue;

            const frame = win.get_frame_rect();
            if (stageX >= frame.x && stageX < frame.x + frame.width &&
                stageY >= frame.y && stageY < frame.y + frame.height)
                return win;
        }
        return null;
    }

    _startInteractivePick() {
        // 1. Overlay to capture global mouse and keyboard events
        this._overlay = new St.Widget({
            name: 'WindowNativizerInspectorOverlay',
            reactive: true,
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });
        Main.uiGroup.add_child(this._overlay);

        // 2. Visual highlight border box
        this._highlight = new St.Widget({
            name: 'WindowNativizerInspectorHighlight',
            style: 'border: 3px solid #3584e4; background-color: rgba(53, 132, 228, 0.15); border-radius: 12px;',
            visible: false,
        });
        Main.uiGroup.add_child(this._highlight);

        // 3. Event bindings
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
                // Right click or other buttons cancel
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

        // 4. Modal grab and crosshair cursor
        try {
            this._activeGrab = Main.pushModal(this._overlay);
        } catch (e) {
            // A failed grab must still answer the D-Bus call, or the prefs window
            // stays hidden waiting on a reply that never comes.
            logError(e, '[window-nativizer] Could not grab the window picker');
            this._finishInteractivePick(null);
            return;
        }
        try {
            global.stage?.set_cursor_type?.(Clutter.CursorType.CROSSHAIR);
        } catch {
            // Ignore if stage is unmanaging or cursor cannot be updated
        }
    }

    _finishInteractivePick(win) {
        const invocation = this._pendingInvocation;
        this._pendingInvocation = null;

        this._cleanupPickUI();

        if (!invocation)
            return;

        if (!win) {
            // Cancelled or no window clicked
            invocation.return_value(new GLib.Variant('(a{ss})', [{}]));
            return;
        }

        const properties = extractWindowProperties(win, resolveWindowIdentity(win));

        // The suggestion and whether it would change anything, so prefs can write the
        // corrective state and refuse one that would do nothing. A missing manager
        // leaves both absent, and prefs then adds the rule anyway.
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
                // Ignore if invocation already answered
            }
        }
        this._cleanupPickUI();
    }

    _cleanupPickUI() {
        // popModal() raises 'incorrect pop' when the grab was already released by
        // the actor-destroy hook. The cursor and overlay must be restored either
        // way, otherwise a stuck crosshair and a stale overlay leak out.
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
            // Ignore if stage is unmanaging
        }

        this._highlight?.destroy();
        this._highlight = null;

        this._overlay?.destroy();
        this._overlay = null;
    }
}
