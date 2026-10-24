import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {CursorShape, setActorCursor} from '../platform/actorCursor.js';
import {journal} from '../platform/journal.js';
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
import {isDecoratableWindowType} from './detector.js';
import {
    HIGHLIGHT_BORDER_WIDTH,
    expectedWindowRadius,
    highlightBoundingBox,
    highlightOuterRadius,
} from './pickHighlight.js';
import {
    getWindowFromActor,
    readWindow,
    resolveWindowIdentity,
} from './window.js';

// Highlight styling mirrors upstream Shell's pickers.

function highlightStyle(outerRadius) {
    return `border: ${HIGHLIGHT_BORDER_WIDTH}px solid -st-accent-color; ` +
        `background-color: st-transparentize(-st-accent-color, ${HIGHLIGHT_BG_TRANSPARENTIZE}); ` +
        `border-radius: ${outerRadius}px;`;
}

export class InspectorService {
    constructor(manager = null) {
        this._manager = manager;
        this._activeGrab = null;
        this._overlay = null;
        this._highlight = null;
        this._pendingInvocation = null;
        this._pendingDiagnostics = false;

        // The export is acquired here, so a failure after it must be undone here: enable() cannot
        // roll this back, because the object it would call destroy() on does not exist yet.
        try {
            this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(INSPECTOR_DBUS_IFACE_XML, this);
            this._dbusImpl.export(Gio.DBus.session, INSPECTOR_DBUS_PATH);
            this._ownerId = Gio.DBus.session.own_name(
                INSPECTOR_DBUS_NAME,
                Gio.BusNameOwnerFlags.REPLACE,
                null,
                null
            );
        } catch (e) {
            this.destroy();
            throw e;
        }
    }

    destroy() {
        // Guarded: `_cleanupPickUI` touches actors that may already be gone at shell shutdown.
        try {
            this._cancelInteractivePick();
        } catch (e) {
            journal.failure(e, 'Failed to tear down the window picker');
        }

        if (this._ownerId) {
            Gio.DBus.session.unown_name(this._ownerId);
            this._ownerId = null;
        }

        if (this._dbusImpl) {
            this._dbusImpl.unexport();
            // `wrapJSObject`'s handlers form a cycle GJS never collects: disconnect them too.
            GObject.signal_handlers_destroy(this._dbusImpl);
            this._dbusImpl = null;
        }
    }

    /** `true` adds read-only diagnostics to the same gesture; there is no non-interactive path. */
    PickWindowAsync(params, invocation) {
        const {valid, diagnostics} = parseDebugFlag(params);
        if (!valid) {
            // A caller that was not updated fails here rather than silently getting the quiet pick.
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
            // Answer even on failure, or the invocation stays pending and every later pick is BUSY.
            journal.failure(e, 'Failed to start the window picker');
            this._cancelInteractivePick();
        }
    }

    _findTargetWindow(stageX, stageY) {
        const actors = getWindowActors();
        // Hoisted: the active workspace cannot change during one hit test.
        const activeWorkspace = getActiveWorkspace();
        const candidates = [];
        for (const winActor of actors) {
            // A torn-down window must not escape a Clutter handler and leave the call unanswered.
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
                candidates.push(null);
            }
        }
        return pickTarget(candidates, activeWorkspace, stageX, stageY);
    }

    /** Diagnostics fields are added only when asked; nothing here is printed or journaled. */
    _buildReply(win, diagnostics) {
        // With no manager the dictionary is still truthful; prefs refuses a pick it cannot judge.
        const answer = this._manager?.pickAnswer(win) ?? null;
        const properties = {
            ...answer?.properties ?? extractWindowProperties(win, resolveWindowIdentity(win)),
        };

        if (diagnostics) {
            Object.assign(properties, extractDiagnosticProperties(
                win, this._manager?.decorationFor(win) ?? null, null, St));
            // Cache only: a diagnostic must not start the probe it observes; `unknown` = uncached.
            properties.nativeLikeCorners = cachedNativeLikeCorners(
                this._manager?.classifier, getWindowPid(win));
        }

        // Display only, not used in rule identity matching.
        const title = getWindowDisplayTitle(win);
        if (title)
            properties.windowTitle = title;

        if (typeof answer?.suggestedState === 'string')
            properties.suggestedState = answer.suggestedState;
        if (typeof answer?.suggestedStateWouldChange === 'boolean')
            properties.suggestedStateWouldChange = String(answer.suggestedStateWouldChange);
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
            isActivelyClipped: Boolean(this._manager?.isWindowActivelyClipped(win)),
            // The read may not have landed; the highlight lives a frame and keeps the old default.
            hasNativeLikeCorners: reading.nativeLikeCorners ?? true,
            hasSsd: reading.hasSsd,
            baseRadius: ADWAITA_STYLE.window.radius,
        });
    }

    _startInteractivePick() {
        // Publish both refs before `add_child`, or a throw leaves the overlay eating every click.
        const dims = getStageDimensions();
        this._overlay = new St.Widget({
            name: 'WindowNativizerInspectorOverlay',
            reactive: true,
            x: 0,
            y: 0,
            width: dims.width,
            height: dims.height,
        });

        // `-st-accent-color` re-resolves when St.Settings changes, so no signal of our own.
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
                    // No probe: an untracked window leaves an answer with no owner to forget it.
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
                // A pick cannot throw into the shell's event handler.
            }
            // Always reached, so a thrown hit test still answers the caller.
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
            // Must answer the D-Bus call, or the prefs window hangs waiting.
            journal.failure(e, 'Could not grab the window picker');
            this._finishInteractivePick(null);
            return;
        }
        try {
            setActorCursor(getStage(), CursorShape.CROSSHAIR);
        } catch {
            // The cursor is cosmetic; a stage that refused the call must not stop a pick.
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
            // Diagnostics stay behind the debug argument; the quiet reply is unchanged.
            const properties = this._buildReply(win, diagnostics);
            invocation.return_value(new GLib.Variant('(a{ss})', [properties]));
        } catch (e) {
            // A pick is one-shot, so a journal line costs nothing; the empty reply still goes out.
            journal.failure(e, 'Failed to answer the pick');
            // The invocation itself may be gone too, so its throw must not escape into the handler.
            try {
                invocation.return_value(new GLib.Variant('(a{ss})', [{}]));
            } catch {
                // The invocation is already gone.
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
                // The invocation is already gone.
            }
        }
        this._cleanupPickUI();
    }

    _cleanupPickUI() {
        // popModal can throw "incorrect pop"; cursor and overlay must be restored either way.
        try {
            if (this._activeGrab)
                Main.popModal(this._activeGrab);
        } catch (e) {
            journal.failure(e, 'Failed to release the window picker grab');
        } finally {
            this._activeGrab = null;
        }

        try {
            setActorCursor(getStage(), CursorShape.DEFAULT);
        } catch {
            // The cursor is cosmetic; a stage that refused the call must not stop teardown.
        }

        this._currentRadius = null;
        try {
            this._highlight?.destroy();
        } catch {
            // The highlight went away with the window it outlined; the pick still has to end.
        }
        this._highlight = null;

        try {
            this._overlay?.destroy();
        } catch {
            // Same as the highlight: a destroy that already ran must not strand the modal grab.
        }
        this._overlay = null;
    }
}
