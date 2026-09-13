/**
 * Manager - core extension state machine: it watches window lifecycle, focus and
 * display changes, and reconciles the decoration effects attached to each window.
 *
 * The Shell/Mutter surface this depends on, and the working rules it follows, are
 * in docs/shell-compatibility.md.
 */

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {
    evaluateWindowActions,
    isWindowMaximized,
    isWindowTiled,
    suggestedRuleState,
    suggestedRuleWouldChange,
} from './detector.js';
import {extractWindowProperties} from './pick.js';
import {getWindowRules, SETTINGS_KEY_WINDOW_RULES} from './settings.js';
import {resolveWindowIdentity} from './window.js';
import {destroy as destroyNativeLikeCorners, forgetProcess, hasNativeLikeCorners} from './nativeLikeCorners.js';
import {RoundedClipEffect, ROUNDED_CLIP_G_TYPE} from '../effects/clipEffect.js';
import {ShadowActor, SHADOW_ACTOR_G_TYPE} from '../effects/shadowActor.js';
import * as shadowTexture from '../effects/shadowTexture.js';

// The typelib's enum value, for this shell-side module. Pure modules take the same
// value from mutterRules.generated.js instead (pick.js) - they cannot import
// gi://Meta - and check-style keeps that copy in step with window.h.
const CLIENT_TYPE_X11 = Meta.WindowClientType.X11;

/**
 * An object's registered type name, or undefined when it has none. Comparing the
 * name rather than using `instanceof` stays valid across a re-evaluation of the
 * module, which replaces the JS class.
 */
function gtypeName(object) {
    return object?.constructor?.$gtype?.name;
}

export class Manager {
    /** @param {import('../extension.js').default} ext */
    constructor(ext) {
        this._ext = ext;
        this._settings = ext.getSettings();
        this._windows = new Map();  // Meta.Window -> decorations state
        this._signals = [];
        this._rules = null;         // cached fingerprint -> RuleState value, invalidated on settings change
    }

    enable() {
        // destroy() on disable seals the shadow cache; re-arm it before any paint.
        shadowTexture.reset();

        // Display-level events (global). Workspace switches are deliberately absent:
        // no decoration input depends on the workspace, so switching cannot change
        // what any window looks like.
        this._connect(this._signals, global.display, 'window-created', (_, win) => this._trackWindow(win));
        this._connect(this._signals, global.display, 'grab-op-end', () => this._reconcile());
        // Window restacking (focus/raise/lower) -> shadow actor must be placed below window
        this._connect(this._signals, global.display, 'restacked', () => this._restackShadows());
        // Focus change (active <-> backdrop shadow depth transition)
        this._connect(this._signals, global.display, 'notify::focus-window', () => this._reconcileDebounced());

        // Accessibility style (high contrast swaps the shadow set and deepens the outline)
        this._connect(this._signals, St.Settings.get(), 'notify::high-contrast', () => this._reconcile());

        // Monitor changes (scale changes, plugging/unplugging displays, etc.)
        const monitorManager = global.backend?.get_monitor_manager?.();
        if (monitorManager)
            this._connect(this._signals, monitorManager, 'monitors-changed', () => this._reconcile());

        // GSettings changes -> full re-evaluation (only relevant core keys)
        this._settingsHandlerIds = [];
        for (const key of [SETTINGS_KEY_WINDOW_RULES, 'prefer-crisp-text']) {
            const id = this._settings.connect(`changed::${key}`, () => {
                this._refreshSettings();
                this._reconcile();
            });
            this._settingsHandlerIds.push(id);
        }
        this._refreshSettings();

        // Pre-existing windows (extension enabled mid-session)
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
        // Only once nothing can re-add them: with the global signals gone, no reconcile
        // can run mid-sweep.
        this._tearDownStrays();
        destroyNativeLikeCorners();
        shadowTexture.destroy();
    }

    /**
     * Takes down effects and actors that outlived their window's entry in `_windows`.
     * A window that closed while the extension was live kept its clip and shadow to
     * fade with the window actor, so disable() would otherwise leave them - and the
     * shadow's fade source - behind, which docs/shell-compatibility.md promises it
     * does not.
     */
    _tearDownStrays() {
        for (const actor of global.window_group?.get_children?.() ?? []) {
            if (gtypeName(actor) === SHADOW_ACTOR_G_TYPE)
                actor.destroy();
        }
        for (const winActor of global.get_window_actors?.() ?? []) {
            // Walk the whole subtree: the clip sits on the window actor or on a surface
            // child, and which one is not this sweep's business to hard-code.
            const pending = [winActor];
            while (pending.length > 0) {
                const target = pending.pop();
                for (const effect of target.get_effects?.() ?? []) {
                    if (gtypeName(effect) !== ROUNDED_CLIP_G_TYPE)
                        continue;
                    try {
                        target.remove_effect(effect);
                    } catch {
                        // Actor already going away; the effect goes with it.
                    }
                }
                const children = target.get_children?.() ?? [];
                pending.push(...children);
            }
        }
    }

    /** Keeps the per-window scan reading the same values for a whole batch. */
    _refreshSettings() {
        this._rules = null;
        this._preferCrispText = this._settings.get_boolean('prefer-crisp-text');
    }

    /** Cancels a window's queued work. */
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
                // Silently ignore if object is already destroyed
            }
        }
        signalsList.length = 0;
    }

    /**
     * Connects a signal and records the [object, id] handle in `list`.
     *
     * @param {Array<[object, number]>} list - Target signal registration list
     * @param {object} obj - Object emitting signal
     * @param {string} signal - Signal name
     * @param {Function} handler - Signal callback
     * @param {boolean} [safe=false] - Swallow a failed connection: for window- and
     *   actor-level signals, which vary across Shell versions and may be gone by the
     *   time we connect (docs/shell-compatibility.md)
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
            clip: null, clipTarget: null, clipBody: null, clearRing: false, shadow: null,
            idleId: null, reconcileTimeout: null,
            firstFrameDone: false, signals: [],
        };
        this._windows.set(win, state);

        // Window-level signals (position/size/focus/monitor changes -> idempotent
        // re-evaluation). Every one of them can only change this window's own
        // decoration, so they re-evaluate this window rather than the whole session.
        const windowSignals = [
            'position-changed', 'size-changed', 'notify::appears-focused',
            'notify::maximized-horizontally', 'notify::maximized-vertically',
            'notify::fullscreen', 'notify::main-monitor', 'highest-scale-monitor-changed',
        ];
        for (const sig of windowSignals)
            this._connect(state.signals, win, sig, () => this._reconcileWindowDebounced(win), true);

        this._connect(state.signals, win, 'unmanaging', () => this._forgetWindow(win), true);

        // Actor allocation changes (initial frame size 0 -> ready re-evaluation + size tracking)
        const actor = win.get_compositor_private();
        if (actor) {
            this._connect(state.signals, actor, 'notify::allocation', () => {
                // First frame ready: defer to idle so we don't mutate the actor
                // hierarchy during an allocation pass, and decorate now rather than
                // after the debounce. Later allocations only need the debounce.
                if (!state.firstFrameDone && actor.width > 0 && actor.height > 0) {
                    if (state.idleId)
                        GLib.Source.remove(state.idleId);
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
            // Retain clipEffect and shadowActor to fade naturally with windowActor on close
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
            if (!hasPeer)
                forgetProcess(pid);
        }
    }

    /** Debounced full pass, for the events that can affect more than one window. */
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

    /** Debounced single-window pass, for the events that cannot affect any other. */
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

    /** Gets physical/logical scale factor for window's monitor (supports fractional scale 1.25, 1.333, etc.) */
    _getMonitorScale(win) {
        const monitor = win.get_monitor();
        if (monitor < 0)
            return 1;
        if (typeof global.display?.get_monitor_scale === 'function')
            return global.display.get_monitor_scale(monitor);
        return 1;
    }

    /**
     * Gets the actor to which the clipping effect should be attached.
     * In Wayland, the effect is applied directly to MetaWindowActorWayland.
     * In X11 / XWayland, MetaWindowActorX11 is an outer container whose paint
     * volume includes Mutter's native shadow; applying the offscreen clip to it
     * causes coordinate mismatch with the shadow margins. Applying to its
     * surface child (actor.get_first_child()) cleanly clips the window texture
     * while preserving Mutter's native drop shadow.
     *
     * @param {Meta.Window} win
     * @param {Clutter.Actor} actor
     * @returns {Clutter.Actor}
     */
    _getClipTarget(win, actor) {
        if (win.get_client_type?.() === CLIENT_TYPE_X11)
            return actor.get_first_child?.() ?? actor;
        return actor;
    }

    /**
     * Dynamically synchronize window clipEffect.
     *
     * `wantEffect` attaches or removes the effect, which both rounds the body and
     * clears the client's own shadow ring outside it. `clearRing` erases that ring for
     * a window whose shadow we are taking over: the ring belongs to the client shape
     * whose shadow we are taking over, even when the corners stay square
     * (docs/decoration-model.md).
     */
    _syncClip(win, wantEffect, clearRing = false, target = null, body = undefined) {
        const state = this._windows.get(win);
        if (!state)
            return;
        const actor = win.get_compositor_private();
        if (!actor)
            return;

        const clipTarget = target ?? this._getClipTarget(win, actor);
        const clipBody = body === undefined ? this._bodyRect(win, clipTarget) : body;
        // No placeable body means no rounding. Rounding the actor instead is exactly
        // the cut into a client's own shadow that this clip exists to avoid.
        const wanted = wantEffect && Boolean(clipBody);

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
            // X11 may replace the surface child (assign_surface_actor); the effect
            // would otherwise stay orphaned on the dead actor. Re-pin when moved.
            // A missing child falls back to the window actor until one appears.
            if (clipTarget !== state.clipTarget) {
                this._removeClipEffect(state);
                state.clipTarget = clipTarget;
                clipTarget.add_effect(state.clip);
            }
        }
        state.clipBody = state.clip ? clipBody : null;
        state.clearRing = state.clip ? Boolean(clearRing) : false;
    }

    /**
     * Removes the clip effect from its target, tolerating an actor the compositor
     * already destroyed: X11 swaps the surface child, and the effect goes with it.
     */
    _removeClipEffect(state) {
        try {
            state.clipTarget?.remove_effect(state.clip);
        } catch {
            // Target actor already gone; nothing left to detach from.
        }
    }

    /** Dynamically synchronize window shadowActor */
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

    /** Idempotent re-evaluation and decoration sync for a single window */
    _reconcileWindow(win) {
        const state = this._windows.get(win);
        if (!state)
            return;
        const actor = win.get_compositor_private();
        if (!actor || actor.width === 0 || actor.height === 0)
            return;

        const inputs = this._decorationInputs(win);
        const actions = evaluateWindowActions(inputs);

        // One body rect for both: the clip rounds it and the shadow is cast by it, and
        // deriving it twice would let the two drift apart mid-resize.
        const target = this._getClipTarget(win, actor);
        const body = this._bodyRect(win, target);

        // The decision and the style it was made with come from the same call, so
        // there is no second derivation here to keep in step with it. Clearing the ring is
        // the clip's job even when the corners are not ours (a `shadow` rule), so the
        // effect is attached for either.
        this._syncClip(win, actions.drawClip || actions.clearRing, actions.clearRing, target, body);

        // A ring we could not clear must not get a second shadow on top of it: with no clip
        // attached the client's own shadow is still there, so ours waits for the next pass.
        this._syncShadow(win, actions.clearRing && !state.clip ? false : actions.drawShadow);

        if (state.clip || state.shadow)
            this._applyStyle(win, actions.style, body, actions.drawClip);
    }

    /** Full idempotent re-evaluation: synchronizes clip and shadow for each tracked window */
    _reconcile() {
        for (const [win] of this._windows)
            this._reconcileWindow(win);
    }

    /**
     * Rules are read once per reconcile batch rather than once per window, and
     * re-read only when the underlying settings keys change.
     */
    get _windowRules() {
        if (!this._rules)
            this._rules = getWindowRules(this._settings);
        return this._rules;
    }

    /** Re-orders all shadow actors below corresponding windows after restack */
    _restackShadows() {
        for (const [win, state] of this._windows) {
            if (!state.shadow)
                continue;
            const actor = win.get_compositor_private();
            if (!actor)
                continue;
            global.window_group.set_child_below_sibling(state.shadow, actor);
        }
    }

    /**
     * Everything the decoration decision depends on, read from a live window.
     * Shared with suggestedRuleWouldChange() so a rule is judged against the same
     * inputs the runtime will later apply it to.
     */
    _decorationInputs(win) {
        const b = win.get_buffer_rect();
        const f = win.get_frame_rect();
        const clientType = win.get_client_type?.();
        const isMaximized = isWindowMaximized(win);
        const hasTileMatch = Boolean(win.get_tile_match?.());

        return {
            // Geometry & scale
            bufferWidth: b.width, bufferHeight: b.height,
            frameWidth: f.width, frameHeight: f.height,
            monitorScale: this._getMonitorScale(win),

            // Window state & type
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

            // Style inputs, read here so that one pass does not read them twice
            focused: win.appears_focused,
            tiled: isWindowTiled(win, {isMaximized, hasTileMatch}),
            highContrast: St.Settings.get().high_contrast,

            // Preferences & rules
            rules: this._windowRules,
            preferCrispText: this._preferCrispText,
        };
    }

    /**
     * Whether storing `ruleState` for this window's kind would change what we draw,
     * or null when the window cannot be identified.
     */
    suggestedRuleWouldChange(win, ruleState) {
        const inputs = this._decorationInputs(win);
        return suggestedRuleWouldChange(extractWindowProperties(win, inputs.wmClass), inputs, ruleState);
    }

    /**
     * The state a pick on this window should write: the suggestion from
     * suggestedRuleState(), or null when the window cannot be read.
     */
    suggestedRuleState(win) {
        if (!win)
            return null;
        return suggestedRuleState(this._decorationInputs(win));
    }

    _undecorate(win) {
        this._syncClip(win, false);
        this._syncShadow(win, false);
    }

    /**
     * The window body inside the actor the clip is attached to: the buffer, body plus
     * the margin ring the client drew its own shadow into. Null when it cannot be
     * placed - the two rectangles belong to different coordinate frames (a framed X11
     * window reports its buffer in frame coordinates), or the actor lags a resize.
     */
    _bodyRect(win, target) {
        const b = win.get_buffer_rect?.();
        const f = win.get_frame_rect?.();
        if (!b || !f || f.width <= 0 || f.height <= 0)
            return null;

        const x = f.x - b.x;
        const y = f.y - b.y;
        if (x < 0 || y < 0 || x + f.width > target.width || y + f.height > target.height)
            return null;

        return {x, y, width: f.width, height: f.height};
    }

    /** Applies style -> shader uniforms and the shadow's baked texture */
    _applyStyle(win, style, body, drawClip) {
        const state = this._windows.get(win);
        const actor = win.get_compositor_private();
        if (!state || !actor)
            return;

        if (state.clip && state.clipBody) {
            // A clip attached only to clear the ring keeps the body square: radius 0 leaves the
            // corners alone, and what the mask erases is the ring outside the body.
            state.clip.setParams({
                width: state.clipTarget.width,
                height: state.clipTarget.height,
                frame: state.clipBody,
                radius: drawClip ? style.radius : 0,
                outline: drawClip ? style.outline : null,
                clearRing: state.clearRing,
            });
        }
        if (state.shadow) {
            // The shadow is cast by the body, not by the actor: a client-decorated window's
            // actor carries the margin ring it painted its own shadow into. The rect is the
            // clip's own, and null casts the whole actor.
            state.shadow.setShadowBody(body ?? null);

            // If corner clipping is skipped (square corners), the shadow fits a square
            // outline instead. The actor cross-fades to a new style on its own.
            state.shadow.setShadowStyle({
                radius: state.clip && drawClip ? style.radius : 0,
                shadows: style.shadows,
            });
        }
    }
}
