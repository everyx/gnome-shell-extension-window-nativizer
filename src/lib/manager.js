import GLib from 'gi://GLib';
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
import {reconcileOutcome, readWindow} from './window.js';
import {ProcessClassifier} from './nativeLikeCorners.js';
import {WindowDecoration} from './windowDecoration.js';
import * as shadowTexture from '../effects/shadowTexture.js';
import {ROUNDED_CLIP_G_TYPE, RoundedClipEffect} from '../effects/clipEffect.js';
import {SHADOW_ACTOR_G_TYPE, ShadowActor} from '../effects/shadowActor.js';
import * as overviewMask from '../effects/overviewMask.js';
import {OverviewShadow} from '../effects/overviewShadow.js';
import {RESIZE_BAND_G_TYPE, ResizeBand} from './resizeBandActor.js';
import {
    getDisplay,
    getFocusWindow,
    getWindowGroup,
    getMonitorManager,
    getTabList,
    getWindowActors,
} from '../platform/display.js';
import {
    getWindowActor,
    getWindowType,
    getWindowPid,
    getSurfaceContainer,
} from '../platform/window.js';


/** @returns {string|undefined} Registered GType name; name comparison survives module re-evaluation. */
function gtypeName(object) {
    return object?.constructor?.$gtype?.name;
}

/**
 * A window the manager tracks: the decoration it drives plus the bookkeeping the manager
 * keeps for it — the signals connected here, the debounce and the first-frame gate. These
 * belong to the manager's lifecycle, not the decoration's, so they live outside it.
 */
class TrackedWindow {
    /** @param {WindowDecoration} deco */
    constructor(deco) {
        this.deco = deco;
        /** @type {Array<[object, number]>} */
        this.signals = [];
        this.reconcileTimeout = null;
        this.idleId = null;
        this.firstFrameDone = false;
        this.actorWired = false;
        // The surface container the clip targets, tracked so its allocation can be watched without
        // re-connecting on every reconcile. Null until the child exists.
        this.wiredContainer = null;
    }
}

export class Manager {
    /** @param {import('../extension.js').default} ext */
    constructor(ext) {
        this._settings = ext.getSettings();
        /** @type {Map<Meta.Window, TrackedWindow>} */
        this._windows = new Map();  // Meta.Window -> TrackedWindow
        this._signals = [];
        this._rules = null;         // fingerprint -> rule state, invalidated on settings change
        this._inOverview = false;
        this._lastFocusWindow = null;
        this._highContrast = false;
        this._animationsEnabled = true;
        this._dark = false;
        this._preferCrispText = false;
        this._forceOverviewCorners = false;
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

        // Track the overview state so decorations switch into overview mode with it.
        this._inOverview = Boolean(Main.overview.visible);
        const display = getDisplay();
        this._lastFocusWindow = getFocusWindow(display);
        this._highContrast = St.Settings.get().high_contrast;
        this._animationsEnabled = St.Settings.get().enable_animations;
        this._dark = this._isDark();
        // Maintain overview mode across the showing-to-hidden transition.
        this._connect(this._signals, Main.overview, 'showing', () => this._onOverviewShowing());
        this._connect(this._signals, Main.overview, 'hidden', () => this._onOverviewHidden());

        this._connect(this._signals, display, 'window-created', (_, win) => this._trackWindow(win));
        this._connect(this._signals, display, 'grab-op-end', () => {
            // Mutter drove the cursor through the grab; take the band's back to DEFAULT.
            this._resetBandCursors();
            this._reconcile();
        });
        this._connect(this._signals, display, 'restacked', () => this._restackActors());
        this._connect(this._signals, display, 'notify::focus-window', () => {
            this._resetBandCursors();

            // Reconcile focus shadow styles for the windows losing and gaining focus.
            const previous = this._lastFocusWindow;
            const focusWin = getFocusWindow(display);
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

        // Honor system animation toggle to snap shadow state instantly when animations are disabled.
        this._connect(this._signals, St.Settings.get(), 'notify::enable-animations', () => {
            this._animationsEnabled = St.Settings.get().enable_animations;
            this._reconcile();
        });

        // The tiled border is the one colour upstream takes from the theme rather than baking in.
        this._connect(this._signals, St.Settings.get(), 'notify::color-scheme', () => {
            this._dark = this._isDark();
            this._reconcile();
        });

        const monitorManager = getMonitorManager();
        if (monitorManager)
            this._connect(this._signals, monitorManager, 'monitors-changed', () => this._reconcile());

        this._settingsHandlerIds = [];
        for (const key of [SETTINGS_KEY_WINDOW_RULES, 'prefer-crisp-text', 'force-overview-corners']) {
            const id = this._settings.connect(`changed::${key}`, () => {
                this._refreshSettings();
                this._reconcile();
            });
            this._settingsHandlerIds.push(id);
        }
        this._refreshSettings();

        for (const win of getTabList())
            this._trackWindow(win);
        this._reconcile();
    }

    disable() {
        this._inOverview = false;

        // Isolate per-window errors so a failure on one window never aborts teardown
        // of remaining windows or drops global signal and state disconnection.
        for (const record of this._windows.values()) {
            try {
                this._destroyWindow(record);
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
        for (const actor of getWindowGroup()?.get_children?.() ?? []) {
            if (gtypeName(actor) !== SHADOW_ACTOR_G_TYPE && gtypeName(actor) !== RESIZE_BAND_G_TYPE)
                continue;
            try {
                actor.destroy();
            } catch {
                // Actor already finalized or torn down mid-sweep.
            }
        }
        for (const winActor of getWindowActors()) {
            // Clip may be on window actor or XWayland surface child → walk subtree.
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
        this._forceOverviewCorners = this._settings.get_boolean('force-overview-corners');
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
        if (!win || !isDecoratableWindowType(getWindowType(win)) || this._windows.has(win))
            return;

        const deco = new WindowDecoration(win, {
            container: getWindowGroup(),
            display: getDisplay(),
            RoundedClipEffect,
            ShadowActor,
            ResizeBand,
            OverviewMask: overviewMask,
            OverviewShadow,
            St,
        });
        const record = new TrackedWindow(deco);
        this._windows.set(win, record);

        const windowSignals = [
            'position-changed', 'size-changed',
            'notify::maximized-horizontally', 'notify::maximized-vertically',
            'notify::fullscreen', 'notify::main-monitor', 'highest-scale-monitor-changed',
        ];
        for (const sig of windowSignals)
            this._connect(record.signals, win, sig, () => this._reconcileWindowDebounced(win), true);

        // Focus is not geometry, so it is not debounced: the shadow it selects is the animation
        // the user is watching, and delaying its start by the debounce window is visible against
        // the window's own backdrop change.
        this._connect(record.signals, win, 'notify::appears-focused', () => this._reconcileWindow(win), true);

        this._connect(record.signals, win, 'unmanaging', () => this._forgetWindow(win), true);

        const actor = getWindowActor(win);
        this._wireActorSignals(win, record, actor);
        if (actor && actor.width > 0 && actor.height > 0) {
            record.firstFrameDone = true;
            this._reconcileWindow(win);
        } else {
            this._reconcileWindowDebounced(win);
        }
    }

    /**
     * Connects the actor-driven signals once the window actor exists.
     * @param {Meta.Window} win @param {TrackedWindow} record @param {object|null} actor
     */
    _wireActorSignals(win, record, actor) {
        if (!actor)
            return;

        if (!record.actorWired) {
            record.actorWired = true;

            this._connect(record.signals, actor, 'notify::allocation', () => {
                if (!record.firstFrameDone && actor.width > 0 && actor.height > 0) {
                    if (record.idleId)
                        GLib.Source.remove(record.idleId);
                    // Defer to idle: don't mutate actor tree during allocation.
                    record.idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        record.idleId = null;
                        record.firstFrameDone = true;
                        this._reconcileWindow(win);
                        return GLib.SOURCE_REMOVE;
                    });
                } else {
                    this._reconcileWindowDebounced(win);
                }
            }, true);
            this._connect(record.signals, actor, 'child-added', () => this._reconcileWindowDebounced(win), true);
            this._connect(record.signals, actor, 'child-removed', () => this._reconcileWindowDebounced(win), true);
        }

        // The Wayland clip attaches to the surface container, a child of the window actor, whose
        // allocation can move (0 -> real, a buffer swap, a decoration change) without the window
        // actor's changing. Watching it re-runs the readings so the stored insets cannot go stale
        // and re-verifies a clip target `resolveClipTarget` deferred while the container was
        // unallocated, so the clip returns to the container once its box is verifiable.
        const container = getSurfaceContainer(actor, St);
        if (container && container !== record.wiredContainer) {
            // The container can be replaced (XWayland swaps the surface child); drop the old
            // connection before watching the new one so `signals` does not accumulate dead entries.
            const previous = record.wiredContainer;
            if (previous) {
                const index = record.signals.findIndex(([obj]) => obj === previous);
                if (index >= 0) {
                    try {
                        previous.disconnect(record.signals[index][1]);
                    } catch {
                        // The old container is already gone.
                    }
                    record.signals.splice(index, 1);
                }
            }
            record.wiredContainer = container;
            this._connect(record.signals, container, 'notify::allocation',
                () => this._reconcileWindowDebounced(win), true);
        }
    }

    /** Cancels the debounce and first-frame idle the manager scheduled for this window. */
    _dropPendingWindowWork(record) {
        if (record.idleId) {
            GLib.Source.remove(record.idleId);
            record.idleId = null;
        }
        if (record.reconcileTimeout) {
            GLib.Source.remove(record.reconcileTimeout);
            record.reconcileTimeout = null;
        }
    }

    /**
     * Ends the manager's bookkeeping for a window, then tears down its decoration. The
     * signals, idle and debounce are the manager's, so this is where they go; the
     * decoration's own teardown gets the options.
     * @param {TrackedWindow} record
     * @param {object} [options]
     * @param {boolean} [options.keepVisualsForClose=false]
     */
    _destroyWindow(record, options = {}) {
        this._dropPendingWindowWork(record);
        this._disconnectSignals(record.signals);
        record.deco.destroy(options);
    }

    _forgetWindow(win) {
        const record = this._windows.get(win);
        if (record)
            this._destroyWindow(record, {keepVisualsForClose: true});

        this._windows.delete(win);
        if (this._lastFocusWindow === win)
            this._lastFocusWindow = null;

        const pid = getWindowPid(win);
        if (pid > 0) {
            let hasPeer = false;
            for (const other of this._windows.keys()) {
                if (getWindowPid(other) === pid) {
                    hasPeer = true;
                    break;
                }
            }
            // Last window for pid gone -> drop process cache.
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
            if (getWindowPid(win) === pid)
                this._reconcileWindow(win);
        }
    }

    _reconcileWindowDebounced(win) {
        const record = this._windows.get(win);
        if (!record || record.reconcileTimeout)
            return;
        record.reconcileTimeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 50, () => {
                record.reconcileTimeout = null;
                this._reconcileWindow(win);
                return GLib.SOURCE_REMOVE;
            });
    }

    _reconcileWindow(win) {
        const record = this._windows.get(win);
        if (!record)
            return;

        try {
            const actor = getWindowActor(win);
            this._wireActorSignals(win, record, actor);
            if (!actor || actor.width === 0 || actor.height === 0)
                return;

            const pid = getWindowPid(win);
            this._classifier?.probeAdwaitaLook(pid);

            const inputs = this._decorationInputs(win);
            // The branch itself lives in the reading module, so a spec can table it:
            // no reading to undecorate, classification in flight to wait, otherwise apply.
            const outcome = reconcileOutcome(inputs);
            if (outcome === 'undecorate') {
                record.deco.undecorate();
                return;
            }
            if (outcome === 'defer')
                return;
            const actions = evaluateWindowActions(inputs);

            record.deco.apply({
                actions,
                inputs,
                actor,
                inOverview: this._inOverview,
                forceOverviewCorners: this._forceOverviewCorners,
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
        for (const record of this._windows.values())
            record.deco.setOverviewMode(this._inOverview);
    }

    _restackActors() {
        for (const [win, record] of this._windows) {
            try {
                record.deco.restack(getWindowActor(win));
            } catch {
                // Window went away mid-restack; the next restack drops it.
            }
        }
    }

    /** Back to the arrow on every band; the next motion event over one sets it again. */
    _resetBandCursors() {
        for (const record of this._windows.values())
            record.deco.resetBandCursor();
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
        // A null reading means the rects could not be read. Keep it null so `reconcileOutcome`
        // defers instead of tearing the decoration down; only a window that is actually gone
        // reaches `destroy` through the actor path. A reading with `hasValidGeometry` false is a
        // read answer of "no extent", which still routes to undecorate.
        if (!reading)
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
        // A rule suggestion needs a geometry to be about; the previous shape returned null for
        // every invalid reading, so keep that here now the reconcile path sees them.
        if (!inputs?.hasValidGeometry)
            return null;
        return suggestedRuleWouldChange(extractWindowProperties(inputs, inputs.wmClass), inputs, ruleState);
    }

    /**
     * @param {object} win - Meta.Window
     * @returns {string|null} Suggested canonical rule state for pick, or null if unreadable.
     */
    suggestedRuleState(win) {
        const inputs = this._decorationInputs(win);
        return inputs?.hasValidGeometry ? suggestedRuleState(inputs) : null;
    }

    /**
     * Read-only state inspection snapshot for a tracked window decoration.
     * The introspection boundary for a tracked window's state in E2E tests and debugging.
     * @param {Meta.Window} win
     * @returns {object|null}
     */
    stateView(win) {
        const record = this._windows.get(win);
        if (!record)
            return null;
        // firstFrameDone/isPendingReconcile are manager bookkeeping, so the manager adds them
        // to the decoration's own snapshot rather than the decoration reporting them.
        return {
            ...record.deco.stateView,
            firstFrameDone: record.firstFrameDone,
            isPendingReconcile: Boolean(record.reconcileTimeout),
        };
    }

    /**
     * The live decoration for a tracked window, for read-only diagnostics. Returns the
     * `WindowDecoration` itself (not its `stateView` snapshot), so the inspector can read the live
     * clip internals the diagnostic reply carries.
     * @param {Meta.Window} win
     * @returns {WindowDecoration|null}
     */
    decorationFor(win) {
        return this._windows.get(win)?.deco ?? null;
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
        for (const record of this._windows.values()) {
            if (record.reconcileTimeout)
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
        return Boolean(this._windows.get(win)?.deco.isActivelyClipped);
    }
}
