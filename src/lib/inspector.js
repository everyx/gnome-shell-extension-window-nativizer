import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {CursorShape, setActorCursor} from '../platform/actorCursor.js';
import {
    getWindowActors,
    getActiveWorkspace,
    getStage,
    getStageDimensions,
} from '../platform/display.js';
import {
    getWindowFrameRect,
    getWindowType,
    getWindowPid,
    getWindowDisplayTitle,
    isWindowMinimized,
    isWindowHidden,
    isWindowOnAllWorkspaces,
    isWindowLocatedOnWorkspace,
} from '../platform/window.js';

import {
    INSPECTOR_DBUS_NAME,
    INSPECTOR_DBUS_PATH,
    INSPECTOR_DBUS_IFACE_XML,
    extractWindowProperties,
    extractDiagnosticProperties,
    cachedNativeLikeCorners,
    parseDebugFlag,
} from './pick.js';
import {pickTarget} from './pickTarget.js';
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
    resolveWindowIdentity,
} from './window.js';

// Highlight visual styling derived from upstream Shell pickers.

function highlightStyle(outerRadius) {
    return `border: ${HIGHLIGHT_BORDER_WIDTH}px solid -st-accent-color; ` +
        `background-color: st-transparentize(-st-accent-color, ${HIGHLIGHT_BG_TRANSPARENTIZE}); ` +
        `border-radius: ${outerRadius}px;`;
}

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
        // Whether the pick in flight was asked for diagnostics; read once when it is answered.
        this._pendingDiagnostics = false;
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
            // `wrapJSObject`'s three handlers close over this service, forming a cycle GJS cannot
            // collect: `unexport()` alone leaves the implementation, the service and the manager
            // alive forever, one set per enable/disable cycle. Disconnecting them breaks it.
            GObject.signal_handlers_destroy(this._dbusImpl);
            this._dbusImpl = null;
        }
    }

    /**
     * D-Bus method PickWindow (GJS name `PickWindowAsync`). The required boolean is the whole
     * compatibility boundary: `false` is the quiet interactive pick, `true` adds read-only
     * diagnostics. There is no non-interactive path - diagnostics ride the same user gesture, which
     * is also the authorisation to read that state.
     */
    PickWindowAsync(params, invocation) {
        const {valid, diagnostics} = parseDebugFlag(params);
        if (!valid) {
            // The method requires its boolean. A caller that was not updated fails here rather than
            // silently getting the quiet interactive pick.
            invocation.return_error_literal(
                Gio.IOErrorEnum,
                Gio.IOErrorEnum.INVALID_ARGUMENT,
                'PickWindow requires a boolean debug argument; pass false for the interactive pick'
            );
            return;
        }

        if (this._pendingInvocation) {
            invocation.return_error_literal(
                Gio.IOErrorEnum,
                Gio.IOErrorEnum.BUSY,
                'Window inspection is already in progress'
            );
            return;
        }

        this._pendingInvocation = invocation;
        this._pendingDiagnostics = diagnostics;
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
        const actors = getWindowActors();
        // Hoisted out of the loop: the active workspace cannot change while one hit test enumerates windows.
        const activeWorkspace = getActiveWorkspace();
        const candidates = [];
        for (const winActor of actors) {
            // A window torn down mid-scan must not abort the hit test - or escape a Clutter
            // handler and leave the D-Bus call unanswered: skip it and keep looking.
            try {
                const win = getWindowFromActor(winActor);
                let onAllWorkspaces = false;
                let onWorkspace = false;
                if (activeWorkspace && win) {
                    onAllWorkspaces = isWindowOnAllWorkspaces(win);
                    if (!onAllWorkspaces)
                        onWorkspace = isWindowLocatedOnWorkspace(win, activeWorkspace);
                }
                candidates.push({
                    window: win,
                    minimized: isWindowMinimized(win),
                    hidden: isWindowHidden(win),
                    // `is_mapped` may be absent; a present one that returns false is the skip.
                    mapped: !(winActor?.is_mapped && !winActor.is_mapped()),
                    onAllWorkspaces,
                    onWorkspace,
                    decoratable: isDecoratableWindowType(getWindowType(win)),
                    frame: getWindowFrameRect(win),
                });
            } catch {
                // Deallocated between the actor-list snapshot and these reads.
                candidates.push(null);
            }
        }
        return pickTarget(candidates, activeWorkspace, stageX, stageY);
    }

    /**
     * Builds the pick reply for a window. Public fields are always present; diagnostics-only
     * fields are added only when the caller asked for them, which is the whole point of the
     * debug argument. Nothing here is printed and no journal line is written in either mode.
     *
     */
    _buildReply(win, diagnostics) {
        const properties = {
            ...extractWindowProperties(win, resolveWindowIdentity(win)),
        };

        if (diagnostics) {
            Object.assign(properties, extractDiagnosticProperties(
                win, this._manager?.decorationFor?.(win) ?? null, null, St));
            // The process classification is read from the cache only. A diagnostic must not start
            // the async probe (that would mutate the state it observes); `unknown` is "no answer
            // cached yet" and `cannotTell` is "no classifier to ask".
            properties.nativeLikeCorners = cachedNativeLikeCorners(
                this._manager?.classifier, getWindowPid(win));
        }

        // Display only, not used in rule identity matching.
        const title = getWindowDisplayTitle(win);
        if (title)
            properties.windowTitle = title;

        const state = this._manager?.suggestedRuleState?.(win);
        if (typeof state === 'string') {
            properties.suggestedState = state;
            const changes = this._manager?.suggestedRuleWouldChange?.(win, state);
            if (typeof changes === 'boolean')
                properties.suggestedStateWouldChange = String(changes);
        }
        return properties;
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
        const dims = getStageDimensions();
        this._overlay = new St.Widget({
            name: 'WindowNativizerInspectorOverlay',
            reactive: true,
            x: 0,
            y: 0,
            width: dims.width,
            height: dims.height,
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
                    // No probe from here: a window the manager does not track would leave a
                    // process answer with no owner to forget it by, and any later process given
                    // that pid would inherit it. The picker reads whatever the manager already
                    // knows.
                    const frame = getWindowFrameRect(targetWin);
                    if (!frame)
                        return;
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
            setActorCursor(getStage(), CursorShape.CROSSHAIR);
        } catch {
            // stage may be unmanaging
        }
    }

    _finishInteractivePick(win) {
        const invocation = this._pendingInvocation;
        const diagnostics = this._pendingDiagnostics;
        this._pendingInvocation = null;
        this._pendingDiagnostics = false;

        this._cleanupPickUI();

        if (!invocation)
            return;

        if (!win) {
            invocation.return_value(new GLib.Variant('(a{ss})', [{}]));
            return;
        }

        try {
            // Diagnostics stay behind the debug argument; the quiet interactive path is
            // byte-for-byte today's reply, and the diagnostics path adds fields to it.
            const properties = this._buildReply(win, diagnostics);
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
        this._pendingDiagnostics = false;
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
            setActorCursor(getStage(), CursorShape.DEFAULT);
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
