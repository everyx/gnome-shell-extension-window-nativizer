import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {CursorShape, setActorCursor} from '../compat/index.js';

import {
    INSPECTOR_DBUS_NAME,
    INSPECTOR_DBUS_PATH,
    extractWindowProperties,
} from './pick.js';
import {ADWAITA_STYLE} from './adwaitaStyle.generated.js';
import {HIGHLIGHT_BG_TRANSPARENTIZE} from './inspectorStyle.generated.js';
import {
    HIGHLIGHT_BORDER_WIDTH,
    expectedWindowRadius,
    highlightBoundingBox,
    highlightOuterRadius,
    isDecoratableWindowType,
} from './detector.js';
import {
    getWindowFromActor,
    readWindow,
    readWindowString,
    resolveWindowIdentity,
} from './window.js';

// Highlight visual styling, generated from the Shell's own pickers: see
// src/lib/inspectorStyle.generated.js and vendor/gnome-shell/README.md.

function highlightStyle(outerRadius) {
    return `border: ${HIGHLIGHT_BORDER_WIDTH}px solid -st-accent-color; ` +
        `background-color: st-transparentize(-st-accent-color, ${HIGHLIGHT_BG_TRANSPARENTIZE}); ` +
        `border-radius: ${outerRadius}px;`;
}

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
        // The picker teardown must not be able to skip the D-Bus teardown below: `_cleanupPickUI`
        // touches actors that may already be gone at shell shutdown.
        try {
            this._cancelInteractivePick();
        } catch (e) {
            logError(e, '[window-nativizer] Failed to tear down the window picker');
        }

        if (this._ownerId) {
            Gio.DBus.session.unown_name(this._ownerId);
            this._ownerId = null;
        }

        if (this._dbusImpl) {
            this._dbusImpl.unexport();
            // `wrapJSObject` connects three handlers whose closures capture this service, forming a
            // reference cycle GJS cannot collect: `unexport()` alone leaves the implementation - and
            // the service, and the manager - alive forever, one set per enable/disable cycle.
            // Disconnecting them is what breaks the cycle (both `run_dispose()` and leaving them
            // connected were measured to misbehave: the first logs Gjs-CRITICAL on the next touch).
            GObject.signal_handlers_destroy(this._dbusImpl);
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
        try {
            this._startInteractivePick();
        } catch (e) {
            // The picker could not be put on screen: tear down whatever it did build and answer,
            // or the invocation stays pending and every later pick is refused as BUSY.
            logError(e, '[window-nativizer] Failed to start the window picker');
            this._cancelInteractivePick();
        }
    }

    _findTargetWindow(stageX, stageY) {
        const actors = global.get_window_actors?.() ?? [];
        // Hoisted out of the loop: the active workspace cannot change while one hit test enumerates windows.
        const activeWorkspace = global.workspace_manager?.get_active_workspace?.();
        for (let i = actors.length - 1; i >= 0; i--) {
            // A window torn down mid-scan must not abort the hit test - or escape a Clutter
            // handler and leave the D-Bus pick unanswered: skip it and keep looking.
            try {
                const winActor = actors[i];
                const win = getWindowFromActor(winActor);
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
            } catch {
                // Deallocated between the actor-list snapshot and these reads.
            }
        }
        return null;
    }

    _getExpectedWindowRadius(win) {
        const reading = readWindow(win, {classifier: this._manager?.classifier});
        if (!reading)
            return 0;

        return expectedWindowRadius({
            isFullscreen: reading.isFullscreen,
            isMaximized: reading.isMaximized,
            isTiled: reading.tiled,
            isActivelyClipped: Boolean(this._manager?.isWindowActivelyClipped?.(win)),
            // The read may not have landed. The highlight lives for one frame and no decision hangs
            // on it, so it keeps the answer the probe used to give for an unclassified process.
            hasNativeLikeCorners: reading.nativeLikeCorners ?? true,
            hasSsd: reading.hasSsd,
            baseRadius: ADWAITA_STYLE.window.radius,
        });
    }

    _startInteractivePick() {
        // Both widgets are built before either is added, and both references are published before
        // the first `add_child`: the overlay is full-screen and reactive, so a throw between the two
        // would leave it swallowing every click until the shell restarted, out of reach of
        // `_cleanupPickUI()`.
        this._overlay = new St.Widget({
            name: 'WindowNativizerInspectorOverlay',
            reactive: true,
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });

        // The accent colour is the `-st-accent-color` CSS term, not a literal:
        // St resolves it from St.Settings:accent-color and re-resolves every mapped
        // widget's style when that setting changes, so the highlight follows the
        // system accent without a signal of our own to connect.
        this._currentRadius = null;
        this._highlight = new St.Widget({
            name: 'WindowNativizerInspectorHighlight',
            style: highlightStyle(0),
            visible: false,
        });

        Main.uiGroup.add_child(this._overlay);
        Main.uiGroup.add_child(this._highlight);

        this._overlay.connect('motion-event', (_actor, event) => {
            const [x, y] = event.get_coords();
            try {
                const targetWin = this._findTargetWindow(x, y);
                if (targetWin) {
                    // Queries never start the /proc read synchronously; the event drives it,
                    // and the answer lands a frame later for the next motion to read.
                    const pid = targetWin.get_pid?.();
                    this._manager?.classifier?.probeAdwaitaLook(pid);
                    const frame = targetWin.get_frame_rect();
                    const box = highlightBoundingBox(frame, HIGHLIGHT_BORDER_WIDTH);
                    const innerRadius = this._getExpectedWindowRadius(targetWin);
                    const outerRadius = highlightOuterRadius(innerRadius, HIGHLIGHT_BORDER_WIDTH);

                    this._highlight.set_position(box.x, box.y);
                    this._highlight.set_size(box.width, box.height);

                    if (this._currentRadius !== outerRadius) {
                        this._currentRadius = outerRadius;
                        this._highlight.style = highlightStyle(outerRadius);
                    }
                    this._highlight.visible = true;
                } else {
                    this._highlight.visible = false;
                }
            } catch {
                // The target went away between hit test and highlight; drop the highlight.
                this._highlight.visible = false;
            }
            return Clutter.EVENT_STOP;
        });

        this._overlay.connect('button-press-event', (_actor, event) => {
            let targetWin = null;
            try {
                if (event.get_button() === Clutter.BUTTON_PRIMARY) {
                    const [x, y] = event.get_coords();
                    targetWin = this._findTargetWindow(x, y);
                }
            } catch {
                // A torn-down target reads as a cancel; the invocation is still answered below.
            }
            // Always reached, so the D-Bus caller cannot be left waiting on a thrown handler.
            this._finishInteractivePick(targetWin);
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
            setActorCursor(global.stage, CursorShape.CROSSHAIR);
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

        try {
            // The suggested-rule queries read the process cache; start the read at this request
            // boundary so they stay side-effect free.
            this._manager?.classifier?.probeAdwaitaLook(win.get_pid?.());
            const properties = extractWindowProperties(win, resolveWindowIdentity(win));

            // Display only, not used in rule identity matching.
            const title = readWindowString(() => win.get_title());
            if (title)
                properties.windowTitle = title;

            const state = this._manager?.suggestedRuleState?.(win);
            if (typeof state === 'string') {
                properties.suggestedState = state;
                const changes = this._manager?.suggestedRuleWouldChange?.(win, state);
                if (typeof changes === 'boolean')
                    properties.suggestedStateWouldChange = String(changes);
            }

            invocation.return_value(new GLib.Variant('(a{ss})', [properties]));
        } catch {
            // The window went away mid-pick; answer empty (a cancel) so the caller is never
            // left waiting on a reply that will not come. The invocation itself may also be
            // gone by now, so its throw must not escape into the Clutter handler.
            try {
                invocation.return_value(new GLib.Variant('(a{ss})', [{}]));
            } catch {
                // Invocation already answered.
            }
        }
    }

    _cancelInteractivePick() {
        if (this._pendingInvocation) {
            const inv = this._pendingInvocation;
            this._pendingInvocation = null;
            try {
                inv.return_value(new GLib.Variant('(a{ss})', [{}]));
            } catch {
                // Invocation already answered.
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
            setActorCursor(global.stage, CursorShape.DEFAULT);
        } catch {
            // stage may be unmanaging
        }

        this._currentRadius = null;
        try {
            this._highlight?.destroy();
        } catch {
            // Already destroyed or stage unmanaging.
        }
        this._highlight = null;

        try {
            this._overlay?.destroy();
        } catch {
            // Already destroyed or stage unmanaging.
        }
        this._overlay = null;
    }
}
