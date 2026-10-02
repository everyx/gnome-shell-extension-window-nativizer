// Central window decoration manager — lifecycle and orchestration in docs/architecture.md.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    evaluateWindowActions,
    isDecoratableWindowType,
    suggestedRuleState,
    suggestedRuleWouldChange,
} from './detector.js';
import {extractWindowProperties} from './pick.js';
import {getWindowRules, SETTINGS_KEY_WINDOW_RULES} from './settings.js';
import {readWindow} from './window.js';
import {ProcessClassifier} from './nativeLikeCorners.js';
import {WindowDecoration} from './windowDecoration.js';
import * as shadowTexture from '../effects/shadowTexture.js';
import {ROUNDED_CLIP_G_TYPE, RoundedClipEffect} from '../effects/clipEffect.js';
import {SHADOW_ACTOR_G_TYPE, ShadowActor} from '../effects/shadowActor.js';
import {RESIZE_BAND_G_TYPE, ResizeBand} from './resizeBandActor.js';


/** @returns {string|undefined} Registered GType name; name comparison survives module re-evaluation. */
function gtypeName(object) {
    return object?.constructor?.$gtype?.name;
}

export class Manager {
    /** @param {import('../extension.js').default} ext */
    constructor(ext) {
        this._settings = ext.getSettings();
        /** @type {Map<Meta.Window, WindowDecoration>} */
        this._windows = new Map();  // Meta.Window -> WindowDecoration
        this._signals = [];
        this._rules = null;         // fingerprint -> rule state, invalidated on settings change
        this._inOverview = false;
        this._lastFocusWindow = null;
        this._highContrast = false;
        this._animationsEnabled = true;
        this._dark = false;
        /** @type {ProcessClassifier|null} */
        this._classifier = null;
    }

    /** @returns {ProcessClassifier|null} */
    get classifier() {
        return this._classifier;
    }

    enable() {
        shadowTexture.reset();
        this._classifier?.destroy();
        this._classifier = new ProcessClassifier();

        // A provider answer can land after a window has been decided (see probeAdwaitaLook()).
        this._classifier.setOnProcessKnown(pid => this._onProcessKnown(pid));

        // Track overview state to switch between standard and mipmapped hardware filtering.
        this._inOverview = Boolean(Main.overview.visible);
        this._lastFocusWindow = global.display.focus_window;
        this._highContrast = St.Settings.get().high_contrast;
        this._animationsEnabled = St.Settings.get().enable_animations;
        this._dark = this._isDark();
        // Maintain overview mode across the showing-to-hidden transition.
        this._connect(this._signals, Main.overview, 'showing', () => this._onOverviewShowing());
        this._connect(this._signals, Main.overview, 'hidden', () => this._onOverviewHidden());

        this._connect(this._signals, global.display, 'window-created', (_, win) => this._trackWindow(win));
        this._connect(this._signals, global.display, 'grab-op-end', () => {
            // Mutter drove the cursor through the grab; take the band's back to DEFAULT.
            this._resetBandCursors();
            this._reconcile();
        });
        this._connect(this._signals, global.display, 'restacked', () => this._restackActors());
        this._connect(this._signals, global.display, 'notify::focus-window', () => {
            this._resetBandCursors();

            // Focus changes only `appears_focused`, which decides the shadow tone of exactly
            // the two windows involved - not every window. Reconcile those two; each also
            // reconciles through its own `notify::appears-focused`, so this is the belt to
            // that suspenders. Focus landing on an unmanaged popup (issue #13) is still
            // carried by the window that lost focus.
            const previous = this._lastFocusWindow;
            const focusWin = global.display.focus_window;
            this._lastFocusWindow = focusWin;
            if (previous && previous !== focusWin && this._windows.has(previous))
                this._reconcileWindow(previous);
            if (focusWin && this._windows.has(focusWin))
                this._reconcileWindow(focusWin);
        });

        this._connect(this._signals, St.Settings.get(), 'notify::high-contrast', () => {
            this._highContrast = St.Settings.get().high_contrast;
            this._reconcile();
        });

        // GTK hands its CSS transitions no frame clock when animations are off, so a native window
        // changes its shadow in one frame. Ours has to stop blending for the same reason, or the
        // one window still moving is ours.
        this._connect(this._signals, St.Settings.get(), 'notify::enable-animations', () => {
            this._animationsEnabled = St.Settings.get().enable_animations;
            this._reconcile();
        });

        // The tiled border is the one colour upstream takes from the theme rather than baking in.
        this._connect(this._signals, St.Settings.get(), 'notify::color-scheme', () => {
            this._dark = this._isDark();
            this._reconcile();
        });

        const monitorManager = global.backend?.get_monitor_manager?.();
        if (monitorManager)
            this._connect(this._signals, monitorManager, 'monitors-changed', () => this._reconcile());

        this._settingsHandlerIds = [];
        for (const key of [SETTINGS_KEY_WINDOW_RULES, 'prefer-crisp-text']) {
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
        this._inOverview = false;

        // Isolate per-window errors so a failure on one window never aborts teardown
        // of remaining windows or drops global signal and state disconnection.
        for (const deco of this._windows.values()) {
            try {
                deco.destroy();
            } catch (e) {
                logError(e, '[window-nativizer] Failed to tear down a window decoration');
            }
        }
        this._windows.clear();
        this._lastFocusWindow = null;
        this._disconnectSignals(this._signals);
        this._settingsHandlerIds?.forEach(id => this._settings.disconnect(id));
        this._settingsHandlerIds = [];
        this._rules = null;
        // Sweep after signals gone so no reconcile can re-populate mid-teardown.
        this._tearDownStrays();
        this._classifier?.destroy();
        this._classifier = null;
        shadowTexture.destroy();
    }

    /** Remove orphaned effects/actors from windows closed mid-session (clip/shadow must not outlive disable()). */
    _tearDownStrays() {
        for (const actor of global.window_group?.get_children?.() ?? []) {
            if (gtypeName(actor) !== SHADOW_ACTOR_G_TYPE && gtypeName(actor) !== RESIZE_BAND_G_TYPE)
                continue;
            try {
                actor.destroy();
            } catch {
                // Actor already finalized or torn down mid-sweep.
            }
        }
        for (const winActor of global.get_window_actors?.() ?? []) {
            // Clip may be on window actor or X11 surface child → walk subtree.
            const pending = [winActor];
            while (pending.length > 0) {
                const target = pending.pop();
                try {
                    for (const effect of target.get_effects?.() ?? []) {
                        if (gtypeName(effect) === ROUNDED_CLIP_G_TYPE)
                            target.remove_effect(effect);
                    }
                    const children = target.get_children?.() ?? [];
                    pending.push(...children);
                } catch {
                    // This actor is going away; its clip went with it.
                }
            }
        }
    }

    _refreshSettings() {
        this._rules = null;
        this._preferCrispText = this._settings.get_boolean('prefer-crisp-text');
    }

    /**
     * Whether libadwaita would be using its dark palette.
     * @returns {boolean}
     */
    _isDark() {
        return St.Settings.get().color_scheme === St.SystemColorScheme.PREFER_DARK;
    }

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
        if (!win || !isDecoratableWindowType(win.get_window_type?.()) || this._windows.has(win))
            return;

        const deco = new WindowDecoration(win, {
            container: global.window_group,
            display: global.display,
            RoundedClipEffect,
            ShadowActor,
            ResizeBand,
            St,
        });
        this._windows.set(win, deco);

        const windowSignals = [
            'position-changed', 'size-changed',
            'notify::maximized-horizontally', 'notify::maximized-vertically',
            'notify::fullscreen', 'notify::main-monitor', 'highest-scale-monitor-changed',
        ];
        for (const sig of windowSignals)
            this._connect(deco.signals, win, sig, () => this._reconcileWindowDebounced(win), true);

        // Focus is not geometry, so it is not debounced: the shadow it selects is the animation
        // the user is watching, and delaying its start by the debounce window is visible against
        // the window's own backdrop change.
        this._connect(deco.signals, win, 'notify::appears-focused', () => this._reconcileWindow(win), true);

        this._connect(deco.signals, win, 'unmanaging', () => this._forgetWindow(win), true);

        const actor = win.get_compositor_private();
        this._wireActorSignals(win, deco, actor);
        if (actor && actor.width > 0 && actor.height > 0) {
            deco.firstFrameDone = true;
            this._reconcileWindow(win);
        } else {
            this._reconcileWindowDebounced(win);
        }
    }

    /**
     * Connects the actor-driven signals once the window actor exists.
     * @param {Meta.Window} win @param {WindowDecoration} deco @param {object|null} actor
     */
    _wireActorSignals(win, deco, actor) {
        if (!actor || deco.actorWired)
            return;
        deco.actorWired = true;

        this._connect(deco.signals, actor, 'notify::allocation', () => {
            if (!deco.firstFrameDone && actor.width > 0 && actor.height > 0) {
                if (deco.idleId)
                    GLib.Source.remove(deco.idleId);
                // Defer to idle: don't mutate actor tree during allocation.
                deco.idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    deco.idleId = null;
                    deco.firstFrameDone = true;
                    this._reconcileWindow(win);
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                this._reconcileWindowDebounced(win);
            }
        }, true);
        this._connect(deco.signals, actor, 'child-added', () => this._reconcileWindowDebounced(win), true);
        this._connect(deco.signals, actor, 'child-removed', () => this._reconcileWindowDebounced(win), true);
    }

    _forgetWindow(win) {
        const deco = this._windows.get(win);
        if (deco)
            deco.destroy({keepVisualsForClose: true});

        this._windows.delete(win);
        if (this._lastFocusWindow === win)
            this._lastFocusWindow = null;

        // Remove the entry before reading the pid: a deallocated window's get_pid() can throw,
        // and the entry must already be gone or it would be re-synced forever. That throw costs the
        // `forgetProcess` below, the only prune site for the process cache, so a process reusing
        // this pid would be decorated from the dead one's answer. Left as is: every caller holds
        // the window for the duration of the call, so the throw has no demonstrated trigger.
        let pid = -1;
        try {
            pid = win.get_pid?.() ?? -1;
        } catch {
            // Window already gone; nothing to correlate.
        }
        if (pid > 0) {
            let hasPeer = false;
            for (const other of this._windows.keys()) {
                try {
                    if (other.get_pid?.() === pid) {
                        hasPeer = true;
                        break;
                    }
                } catch {
                    // Skip a peer that is itself going away.
                }
            }
            // Last window for pid gone → drop process cache (also cleared in destroy()).
            if (!hasPeer)
                this._classifier?.forgetProcess(pid);
        }
    }

    /**
     * A process's answer landed after nothing could be decided for its windows: decide them now.
     * @param {number} pid
     */
    _onProcessKnown(pid) {
        for (const win of this._windows.keys()) {
            try {
                if (win.get_pid?.() === pid)
                    this._reconcileWindow(win);
            } catch {
                // Window went away while the process answer landed.
            }
        }
    }

    _reconcileWindowDebounced(win) {
        const deco = this._windows.get(win);
        if (!deco || deco.reconcileTimeout)
            return;
        deco.reconcileTimeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 50, () => {
                deco.reconcileTimeout = null;
                this._reconcileWindow(win);
                return GLib.SOURCE_REMOVE;
            });
    }

    _reconcileWindow(win) {
        const deco = this._windows.get(win);
        if (!deco)
            return;

        try {
            const actor = win.get_compositor_private();
            this._wireActorSignals(win, deco, actor);
            if (!actor || actor.width === 0 || actor.height === 0)
                return;

            const pid = win.get_pid?.();
            this._classifier?.probeAdwaitaLook(pid);
            if (this._classifier?.isAdwaitaLookPending(pid))
                return;

            const inputs = this._decorationInputs(win);
            if (!inputs) {
                deco.undecorate();
                return;
            }
            const actions = evaluateWindowActions(inputs);

            deco.apply({
                actions,
                inputs,
                actor,
                inOverview: this._inOverview,
            });
        } catch {
            // Window went away mid-sync; the next signal re-runs it if it comes back.
        }
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

    _onOverviewShowing() {
        this._inOverview = true;
        this._syncOverviewDecos();
    }

    _onOverviewHidden() {
        this._inOverview = false;
        this._syncOverviewDecos();
    }

    /** Synchronize overview mode across all managed window decorations. */
    _syncOverviewDecos() {
        for (const deco of this._windows.values())
            deco.setOverviewMode(this._inOverview);
    }

    _restackActors() {
        for (const [win, deco] of this._windows) {
            try {
                deco.restack(win.get_compositor_private());
            } catch {
                // Window went away mid-restack; the next restack drops it.
            }
        }
    }

    /** Back to the arrow on every band; the next motion event over one sets it again. */
    _resetBandCursors() {
        for (const deco of this._windows.values())
            deco.resetBandCursor();
    }

    /**
     * Inputs for evaluateWindowActions; shared with suggestedRuleWouldChange().
     * @param {Meta.Window} win
     * @returns {object|null}
     */
    _decorationInputs(win) {
        if (!win)
            return null;
        try {
            return this._collectDecorationInputs(win);
        } catch {
            return null;
        }
    }

    /** @param {Meta.Window} win @returns {object|null} */
    _collectDecorationInputs(win) {
        const reading = readWindow(win, {classifier: this._classifier});
        if (!reading || !reading.hasValidGeometry)
            return null;

        return {
            ...reading,
            focused: reading.appearsFocused,
            highContrast: this._highContrast,
            animationsEnabled: this._animationsEnabled,
            dark: this._dark,
            rules: this._windowRules,
            preferCrispText: this._preferCrispText,
        };
    }

    /**
     * @param {object} win - Meta.Window
     * @param {string} ruleState
     * @returns {boolean|null} Whether storing ruleState would change decoration; null if unidentifiable.
     */
    suggestedRuleWouldChange(win, ruleState) {
        const inputs = this._decorationInputs(win);
        if (!inputs)
            return null;
        return suggestedRuleWouldChange(extractWindowProperties(inputs, inputs.wmClass), inputs, ruleState);
    }

    /**
     * @param {object} win - Meta.Window
     * @returns {string|null} Suggested canonical rule state for pick, or null if unreadable.
     */
    suggestedRuleState(win) {
        const inputs = this._decorationInputs(win);
        return inputs ? suggestedRuleState(inputs) : null;
    }

    /**
     * Read-only state inspection snapshot for a tracked window decoration.
     * Serves as the single explicit introspection boundary for E2E tests and debugging.
     * @param {Meta.Window} win
     * @returns {object|null}
     */
    stateView(win) {
        return this._windows.get(win)?.stateView ?? null;
    }

    /**
     * Number of windows currently tracked by the manager.
     * @returns {number}
     */
    get trackedCount() {
        return this._windows.size;
    }

    /**
     * Whether any tracked window has a pending debounce reconcile timer.
     * @returns {boolean}
     */
    get hasPendingWindowReconcile() {
        for (const deco of this._windows.values()) {
            if (deco.reconcileTimeout)
                return true;
        }
        return false;
    }

    /**
     * Whether the window is actively managed with a rounded clip.
     * @param {object} win - Meta.Window
     * @returns {boolean}
     */
    isWindowActivelyClipped(win) {
        return Boolean(this._windows.get(win)?.isActivelyClipped);
    }
}
