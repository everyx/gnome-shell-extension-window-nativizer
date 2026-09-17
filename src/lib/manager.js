/**
 * Manager: window lifecycle → decoration reconciliation. Shell/Mutter surface in docs/shell-compatibility.md.
 */

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {
    evaluateWindowActions,
    isWindowMaximized,
    isWindowTiled,
    shouldShowResizeBand,
    suggestedRuleState,
    suggestedRuleWouldChange,
} from './detector.js';
import {computeFrameInsets} from './frame.js';
import {SSD_FRAME_EXTENTS} from './adwaitaStyle.generated.js';
import {extractWindowProperties} from './pick.js';
import {ResizeBand, RESIZE_BAND_G_TYPE} from './resizeBandActor.js';
import {getWindowRules, SETTINGS_KEY_WINDOW_RULES} from './settings.js';
import {resolveWindowIdentity} from './window.js';
import {destroy as destroyNativeLikeCorners, forgetProcess, hasNativeLikeCorners} from './nativeLikeCorners.js';
import {resolveClipTarget} from './clipTarget.js';
import {RoundedClipEffect, ROUNDED_CLIP_G_TYPE} from '../effects/clipEffect.js';
import {ShadowActor, SHADOW_ACTOR_G_TYPE} from '../effects/shadowActor.js';
import * as shadowTexture from '../effects/shadowTexture.js';

// Mutter enum value; the generated copy exists so modules and tests without the gi://Meta typelib can still read Mutter's constants.
const CLIENT_TYPE_X11 = Meta.WindowClientType.X11;

/** @returns {string|undefined} Registered GType name; name comparison survives module re-evaluation. */
function gtypeName(object) {
    return object?.constructor?.$gtype?.name;
}

export class Manager {
    /** @param {import('../extension.js').default} ext */
    constructor(ext) {
        this._settings = ext.getSettings();
        this._windows = new Map();  // Meta.Window -> decorations state
        this._signals = [];
        this._rules = null;         // fingerprint -> RuleState, invalidated on settings change
    }

    enable() {
        shadowTexture.reset();

        this._connect(this._signals, global.display, 'window-created', (_, win) => this._trackWindow(win));
        this._connect(this._signals, global.display, 'grab-op-end', () => {
            // Mutter drove the cursor through the grab; take the band's back to DEFAULT.
            this._resetBandCursors();
            this._reconcile();
        });
        this._connect(this._signals, global.display, 'restacked', () => this._restackActors());
        this._connect(this._signals, global.display, 'notify::focus-window', () => {
            this._resetBandCursors();
            this._reconcileDebounced();
        });

        this._connect(this._signals, St.Settings.get(), 'notify::high-contrast', () => this._reconcile());

        const monitorManager = global.backend?.get_monitor_manager?.();
        if (monitorManager)
            this._connect(this._signals, monitorManager, 'monitors-changed', () => this._reconcile());

        this._settingsHandlerIds = [];
        for (const key of [SETTINGS_KEY_WINDOW_RULES, 'prefer-crisp-text', 'resize-band']) {
            const id = this._settings.connect(`changed::${key}`, () => {
                this._refreshSettings();
                this._reconcile();
            });
            this._settingsHandlerIds.push(id);
        }
        this._refreshSettings();

        for (const win of global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null))
            this._trackWindow(win);
        this._reconcile();
    }

    disable() {
        if (this._reconcileTimeout) {
            GLib.Source.remove(this._reconcileTimeout);
            this._reconcileTimeout = null;
        }
        for (const [win, state] of this._windows) {
            this._dropPendingWork(state);
            this._disconnectSignals(state.signals);
            this._undecorate(win);
        }
        this._windows.clear();
        this._disconnectSignals(this._signals);
        this._settingsHandlerIds?.forEach(id => this._settings.disconnect(id));
        this._settingsHandlerIds = [];
        this._rules = null;
        // Sweep after signals gone so no reconcile can re-populate mid-teardown.
        this._tearDownStrays();
        destroyNativeLikeCorners();
        shadowTexture.destroy();
    }

    /** Remove orphaned effects/actors from windows closed mid-session (clip/shadow must not outlive disable()). */
    _tearDownStrays() {
        for (const actor of global.window_group?.get_children?.() ?? []) {
            if (gtypeName(actor) === SHADOW_ACTOR_G_TYPE || gtypeName(actor) === RESIZE_BAND_G_TYPE)
                actor.destroy();
        }
        for (const winActor of global.get_window_actors?.() ?? []) {
            // Clip may be on window actor or X11 surface child → walk subtree.
            const pending = [winActor];
            while (pending.length > 0) {
                const target = pending.pop();
                for (const effect of target.get_effects?.() ?? []) {
                    if (gtypeName(effect) !== ROUNDED_CLIP_G_TYPE)
                        continue;
                    try {
                        target.remove_effect(effect);
                    } catch {
                        // Actor already going away.
                    }
                }
                const children = target.get_children?.() ?? [];
                pending.push(...children);
            }
        }
    }

    _refreshSettings() {
        this._rules = null;
        this._preferCrispText = this._settings.get_boolean('prefer-crisp-text');
        this._resizeBandEnabled = this._settings.get_boolean('resize-band');
    }

    _dropPendingWork(state) {
        if (state.idleId) {
            GLib.Source.remove(state.idleId);
            state.idleId = null;
        }
        if (state.reconcileTimeout) {
            GLib.Source.remove(state.reconcileTimeout);
            state.reconcileTimeout = null;
        }
    }

    // ---------- Internal ----------

    _disconnectSignals(signalsList) {
        if (!Array.isArray(signalsList))
            return;
        for (const [obj, id] of signalsList) {
            try {
                obj.disconnect(id);
            } catch {
                // Object already destroyed.
            }
        }
        signalsList.length = 0;
    }

    /**
     * @param {Array<[object, number]>} list
     * @param {object} obj
     * @param {string} signal
     * @param {Function} handler
     * @param {boolean} [safe=false] - Swallow connect failure (window/actor signals vary across Shell versions)
     */
    _connect(list, obj, signal, handler, safe = false) {
        try {
            list.push([obj, obj.connect(signal, handler)]);
        } catch (e) {
            if (!safe)
                throw e;
        }
    }

    _trackWindow(win) {
        if (this._windows.has(win))
            return;
        const state = {
            clip: null, clipTarget: null, clipInsets: null, clearRing: false, shadow: null,
            idleId: null, reconcileTimeout: null,
            firstFrameDone: false, signals: [],
        };
        this._windows.set(win, state);

        const windowSignals = [
            'position-changed', 'size-changed', 'notify::appears-focused',
            'notify::maximized-horizontally', 'notify::maximized-vertically',
            'notify::fullscreen', 'notify::main-monitor', 'highest-scale-monitor-changed',
        ];
        for (const sig of windowSignals)
            this._connect(state.signals, win, sig, () => this._reconcileWindowDebounced(win), true);

        this._connect(state.signals, win, 'unmanaging', () => this._forgetWindow(win), true);

        const actor = win.get_compositor_private();
        if (actor) {
            this._connect(state.signals, actor, 'notify::allocation', () => {
                if (!state.firstFrameDone && actor.width > 0 && actor.height > 0) {
                    if (state.idleId)
                        GLib.Source.remove(state.idleId);
                    // Defer to idle: don't mutate actor tree during allocation.
                    state.idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        state.idleId = null;
                        state.firstFrameDone = true;
                        this._reconcileWindow(win);
                        return GLib.SOURCE_REMOVE;
                    });
                } else {
                    this._reconcileWindowDebounced(win);
                }
            }, true);
        }
        if (actor && actor.width > 0 && actor.height > 0) {
            state.firstFrameDone = true;
            this._reconcileWindow(win);
        } else {
            this._reconcileWindowDebounced(win);
        }
    }

    _forgetWindow(win) {
        const state = this._windows.get(win);
        if (state) {
            this._dropPendingWork(state);
            this._disconnectSignals(state.signals);
            // The band takes clicks, so it cannot fade with the window: drop it now.
            state.resizeBand?.destroy();
            state.resizeBand = null;
            // Keep clip/shadow to fade with windowActor on close.
        }
        const pid = win.get_pid?.();
        this._windows.delete(win);
        if (pid) {
            let hasPeer = false;
            for (const other of this._windows.keys()) {
                if (other.get_pid?.() === pid) {
                    hasPeer = true;
                    break;
                }
            }
            // Last window for pid gone → drop process cache (also cleared in destroy()).
            if (!hasPeer)
                forgetProcess(pid);
        }
    }

    _reconcileDebounced() {
        if (this._reconcileTimeout)
            return;
        this._reconcileTimeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 50, () => {
                this._reconcileTimeout = null;
                this._reconcile();
                return GLib.SOURCE_REMOVE;
            });
    }

    _reconcileWindowDebounced(win) {
        const state = this._windows.get(win);
        if (!state || state.reconcileTimeout)
            return;
        state.reconcileTimeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 50, () => {
                state.reconcileTimeout = null;
                this._reconcileWindow(win);
                return GLib.SOURCE_REMOVE;
            });
    }

    /** @returns {number} Monitor scale (fractional); 1 if unknown. */
    _getMonitorScale(win) {
        const monitor = win.get_monitor();
        if (monitor < 0)
            return 1;
        if (typeof global.display?.get_monitor_scale === 'function')
            return global.display.get_monitor_scale(monitor);
        return 1;
    }

    /** Sync clip; clearRing erases client's shadow ring even when corners stay square (see docs/decoration-model.md § Rounding a window takes its shadow over). */
    _syncClip(win, wantEffect, clearRing = false, target = null, insets = null) {
        const state = this._windows.get(win);
        if (!state)
            return;
        const actor = win.get_compositor_private();
        if (!actor)
            return;

        const clipTarget = target ?? resolveClipTarget(win, actor, St);
        // Attach/detach is a decision, not a frame measurement: it no longer depends on the
        // actor's current allocation (that is why a resize used to drop the effect for a
        // frame). The only window that gets no effect is one whose `_frameInsets` is null -
        // a frame that does not fit inside its buffer at all. A framed X11 window is not
        // that case: its buffer is the frame grown by the invisible borders, so it is
        // clipped like any other (measured: the surface child is buffer-sized).
        const wanted = wantEffect && Boolean(insets);

        const hasClip = Boolean(state.clip);
        if (wanted !== hasClip) {
            if (wanted) {
                state.clip = new RoundedClipEffect();
                state.clipTarget = clipTarget;
                state.clipTarget.add_effect(state.clip);
            } else {
                this._removeClipEffect(state);
                state.clip = null;
                state.clipTarget = null;
            }
        } else if (wanted) {
            // X11 may replace surface child; re-pin if target moved.
            if (clipTarget !== state.clipTarget) {
                this._removeClipEffect(state);
                state.clipTarget = clipTarget;
                clipTarget.add_effect(state.clip);
            }
        }
        state.clipInsets = state.clip ? insets : null;
        state.clearRing = state.clip ? Boolean(clearRing) : false;
    }

    /** Detach clip; tolerates X11 surface child already destroyed. */
    _removeClipEffect(state) {
        try {
            state.clipTarget?.remove_effect(state.clip);
        } catch {
            // Target already gone.
        }
    }

    _syncShadow(win, wantShadow) {
        const state = this._windows.get(win);
        if (!state)
            return;
        const actor = win.get_compositor_private();
        if (!actor)
            return;

        const hasShadow = Boolean(state.shadow);
        if (wantShadow !== hasShadow) {
            if (wantShadow) {
                state.shadow = new ShadowActor(actor, global.window_group);
            } else {
                state.shadow.destroy();
                state.shadow = null;
            }
        }
    }

    _reconcileWindow(win) {
        const state = this._windows.get(win);
        if (!state)
            return;
        const actor = win.get_compositor_private();
        if (!actor || actor.width === 0 || actor.height === 0)
            return;

        const inputs = this._decorationInputs(win);
        const actions = evaluateWindowActions(inputs);

        // One inset set for clip and shadow so they cannot drift mid-resize.
        const target = resolveClipTarget(win, actor, St);
        const insets = this._frameInsets(win);

        this._syncClip(win, actions.drawClip || actions.clearRing, actions.clearRing, target, insets);

        // No clip → client's shadow still visible; defer ours to avoid double shadow.
        this._syncShadow(win, actions.clearRing && !state.clip ? false : actions.drawShadow);

        this._syncResizeBand(win, shouldShowResizeBand({
            ...inputs,
            decorated: actions.drawShadow || actions.drawClip,
        }), inputs);

        if (state.clip || state.shadow)
            this._applyStyle(win, actions.style, insets, actions.drawClip);
    }

    _reconcile() {
        for (const [win] of this._windows)
            this._reconcileWindow(win);
    }

    get _windowRules() {
        if (!this._rules)
            this._rules = getWindowRules(this._settings);
        return this._rules;
    }

    _restackActors() {
        for (const [win, state] of this._windows) {
            const actor = win.get_compositor_private();
            if (!actor)
                continue;
            if (state.shadow)
                global.window_group.set_child_below_sibling(state.shadow, actor);
            state.resizeBand?.restack();
        }
    }

    /** Back to the arrow on every band; the next motion event over one sets it again. */
    _resetBandCursors() {
        for (const state of this._windows.values())
            state.resizeBand?.resetCursor();
    }

    /** Inputs for evaluateWindowActions; shared with suggestedRuleWouldChange(). */
    _decorationInputs(win) {
        const b = win.get_buffer_rect();
        const f = win.get_frame_rect();
        const clientType = win.get_client_type?.();
        const isMaximized = isWindowMaximized(win);
        const hasTileMatch = Boolean(win.get_tile_match?.());

        return {
            bufferWidth: b.width, bufferHeight: b.height,
            frameWidth: f.width, frameHeight: f.height,
            // Per-side ring, so each consumer keeps the aggregation it needs: the resize
            // band asks about every side, the shadow axis whether either side declares one.
            insets: this._frameInsets(win),
            monitorScale: this._getMonitorScale(win),

            isMaximized,
            isFullscreen: win.is_fullscreen(),
            hasSsd: Boolean(win.decorated),
            isX11: clientType === CLIENT_TYPE_X11,
            nativeLikeCorners: hasNativeLikeCorners(win),
            windowType: win.get_window_type(),
            hasParent: Boolean(win.get_transient_for?.()),
            isAttachedDialog: Boolean(win.is_attached_dialog?.()),
            allowsResize: Boolean(win.allows_resize?.()),
            hasTileMatch,
            wmClass: resolveWindowIdentity(win),

            focused: win.appears_focused,
            tiled: isWindowTiled(win, {isMaximized, hasTileMatch}),
            highContrast: St.Settings.get().high_contrast,

            rules: this._windowRules,
            preferCrispText: this._preferCrispText,
            resizeBand: this._resizeBandEnabled,
        };
    }

    /**
     * @param {object} win - Meta.Window
     * @param {string} ruleState
     * @returns {boolean|null} Whether storing ruleState would change decoration; null if unidentifiable.
     */
    suggestedRuleWouldChange(win, ruleState) {
        const inputs = this._decorationInputs(win);
        return suggestedRuleWouldChange(extractWindowProperties(win, inputs.wmClass), inputs, ruleState);
    }

    /**
     * @param {object} win - Meta.Window
     * @returns {string|null} Suggested RuleState for pick, or null if unreadable.
     */
    suggestedRuleState(win) {
        if (!win)
            return null;
        return suggestedRuleState(this._decorationInputs(win));
    }

    /**
     * @param {Meta.Window} win
     * @param {boolean} want
     * @param {object} inputs - From _decorationInputs(): frame size and monitor scale
     */
    _syncResizeBand(win, want, inputs) {
        const state = this._windows.get(win);
        if (!state)
            return;

        if (!want) {
            state.resizeBand?.destroy();
            state.resizeBand = null;
            return;
        }

        const actor = win.get_compositor_private();
        if (!actor)
            return;

        if (!state.resizeBand)
            state.resizeBand = new ResizeBand(actor, global.window_group);

        const monitor = win.get_monitor();
        const bounds = monitor >= 0 ? global.display.get_monitor_geometry(monitor) : null;
        // Geometry, not decisions: the actor carries it live and the band derives its
        // regions from the actor's size on every allocation, so this only has to hand over
        // the insets and the monitor rect. A frameless window's null insets read as zero.
        state.resizeBand.setGeometry({
            insets: this._frameInsets(win),
            bounds,
            scale: inputs.monitorScale,
        });
    }

    _undecorate(win) {
        this._syncClip(win, false);
        this._syncShadow(win, false);
        this._syncResizeBand(win, false, null);
    }

    /**
     * @param {Meta.Window} win
     * @returns {import('./frame.js').Insets|null} Ring between the actor (buffer) and the
     * body (`frame_rect`). For an X11 SSD window, mutter-x11-frames adds invisible borders
     * around the frame. Modern Mutter reports buffer_rect == frame_rect, so this falls
     * back to SSD_FRAME_EXTENTS (derived from upstream GTK/Adwaita). Deliberately
     * does not look at any actor size: the body is placed against the actor's live size at
     * paint time, so a lagging actor can never turn this into "no body".
     */
    _frameInsets(win) {
        return computeFrameInsets({
            buffer: win.get_buffer_rect?.(),
            frame: win.get_frame_rect?.(),
            isX11: win.get_client_type?.() === CLIENT_TYPE_X11,
            hasSsd: Boolean(win.decorated),
            ssdFrameExtents: SSD_FRAME_EXTENTS,
        });
    }

    _applyStyle(win, style, insets, drawClip) {
        const state = this._windows.get(win);
        const actor = win.get_compositor_private();
        if (!state || !actor)
            return;

        if (state.clip && state.clipInsets) {
            // Radius 0 keeps corners square; the clip still clears the ring outside body.
            // Only the decisions are uploaded here; the effect places the body against the
            // actor's live size in its own paint.
            state.clip.setParams({
                insets: state.clipInsets,
                radius: drawClip ? style.radius : 0,
                outline: drawClip ? style.outline : null,
                clearRing: state.clearRing,
            });
        }
        if (state.shadow) {
            // Shadow cast by body, not actor (actor includes client's ring).
            state.shadow.setShadowInsets(insets);

            state.shadow.setShadowStyle({
                radius: state.clip && drawClip ? style.radius : 0,
                shadows: style.shadows,
            });
        }
    }
}
