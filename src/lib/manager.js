import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {evaluateWindowActions} from './detector.js';
import {suggestedRuleState, suggestedRuleWouldChange} from './pickSuggestion.js';
import {extractWindowProperties} from './pick.js';
import {journal} from '../platform/journal.js';
import {getWindowRules, SETTINGS_KEY_WINDOW_RULES} from './settings.js';
import {reconcileOutcome, readWindow} from './window.js';
import {ProcessClassifier} from './nativeLikeCorners.js';
import {WindowDecoration} from './windowDecoration.js';
import {WindowTracking} from './windowTracking.js';
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
    invalidateMonitorCache,
} from '../platform/window.js';


function gtypeName(object) {
    return object?.constructor?.$gtype?.name;
}

export class Manager {
    constructor(ext) {
        this._settings = ext.getSettings();
        this._tracking = null;      // WindowTracking: the windows this session drives
        this._signals = [];
        this._rules = null;         // fingerprint -> rule state, invalidated on settings change
        this._inOverview = false;
        this._lastFocusWindow = null;
        this._highContrast = false;
        this._animationsEnabled = true;
        this._dark = false;
        this._preferCrispText = false;
        this._forceOverviewCorners = false;
        this._classifier = null;
    }

    get classifier() {
        return this._classifier;
    }

    enable() {
        shadowTexture.reset();
        this._classifier?.destroy();
        this._classifier = new ProcessClassifier();
        // Created before anything can route a pass: a failure later in enable is rolled back through
        // disable(), which tears the tracker down with everything else.
        this._tracking = new WindowTracking({
            onPassDue: win => this._reconcileWindow(win),
            onGone: win => this._forgetWindow(win),
            St,
        });

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
            if (previous && previous !== focusWin && this._tracking?.has(previous))
                this._reconcileWindow(previous);
            if (focusWin && this._tracking?.has(focusWin))
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
        if (monitorManager) {
            this._connect(this._signals, monitorManager, 'monitors-changed', () => {
                invalidateMonitorCache();
                this._reconcile();
            });
        }

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
        for (const [win] of this._tracking?.entries() ?? []) {
            try {
                this._destroyWindow(win);
            } catch (e) {
                journal.failure(e, 'Failed to tear down a window decoration');
            }
        }
        this._tracking = null;
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
     * @param [safe=false] - Swallow connect failure (window/actor signals vary across Shell versions)
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
        if (!this._tracking?.accepts(win))
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
        this._tracking.add(win, deco);
    }

    /**
     * Ends the manager's bookkeeping for a window, then tears down its decoration. The signals, the
     * idle and the debounce belong to the tracking module, so releasing the window drops them; the
     * decoration's own teardown is this method's.
     *
     * @returns The dropped record, for the caller that needs what it remembered
     */
    _destroyWindow(win, options = {}) {
        const record = this._tracking?.release(win) ?? null;
        record?.decoration.destroy(options);
        return record;
    }

    _forgetWindow(win) {
        const record = this._destroyWindow(win, {keepVisualsForClose: true});

        if (this._lastFocusWindow === win)
            this._lastFocusWindow = null;

        // The remembered pid, not a fresh read: the window is on its way out, so a read here can
        // come back empty, and an empty read must not decide whether a process still has windows.
        const pid = record?.pid ?? 0;
        if (pid > 0) {
            const hasPeer = this._tracking?.entries()
                .some(([, other]) => other.pid === pid) ?? false;
            // Last window for pid gone -> drop process cache.
            if (!hasPeer)
                this._classifier?.forgetProcess(pid);
        }
    }

    /**
     * A process's answer landed after nothing could be decided for its windows: decide them now.
     */
    _onProcessKnown(pid) {
        for (const [win, record] of this._tracking?.entries() ?? []) {
            if (record.pid === pid)
                this._reconcileWindow(win);
        }
    }

    _reconcileWindow(win) {
        const record = this._tracking?.get(win);
        if (!record)
            return;

        // Reads and the decision run outside the try: `getWindowActor`, `observe`'s container read and
        // `_connect` each catch their own, and `evaluateWindowActions` touches no GObject. A throw from
        // them is ours, and letting it escape is what makes a firing guard visible instead of silent.
        const actor = getWindowActor(win);
        this._tracking.observe(win);
        if (!actor || actor.width === 0 || actor.height === 0)
            return;

        // The remembered pid can still be unusable: tracking happens on `window-created`, and an
        // X11 client sets `_NET_WM_PID` only after the window exists. Learn it here and remember it,
        // so a late pid is still classified and teardown keeps a value.
        this._tracking.learnPid(win);
        this._classifier?.probeAdwaitaLook(record.pid);

        const inputs = this._decorationInputs(win);
        // The branch itself lives in the reading module, so a spec can table it:
        // no reading to undecorate, classification in flight to wait, otherwise apply.
        const outcome = reconcileOutcome(inputs);
        if (outcome === 'defer')
            return;
        const actions = outcome === 'apply' ? evaluateWindowActions(inputs) : null;

        // Only the decoration's own calls are guarded: they touch actors, effects and the compositor,
        // which does throw while Mutter tears the window down. That is an expected outcome and stays
        // silent - one line per closed window is noise, and the log audit counts lines exactly.
        try {
            if (outcome === 'undecorate') {
                record.decoration.undecorate();
            } else {
                record.decoration.apply({
                    actions,
                    inputs,
                    actor,
                    // The pass's one reading of the surface-container rule: `observe()` resolved it
                    // above, and the decoration consumes it rather than asking again.
                    surfaceContainer: this._tracking.surfaceContainer(win),
                    inOverview: this._inOverview,
                    forceOverviewCorners: this._forceOverviewCorners,
                });
            }
        } catch {
            // Window went away mid-sync; the next signal re-runs it if it comes back.
        }
    }

    _reconcile() {
        for (const [win] of this._tracking?.entries() ?? [])
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

    _syncOverviewDecos() {
        for (const [, record] of this._tracking?.entries() ?? [])
            record.decoration.setOverviewMode(this._inOverview);
    }

    _restackActors() {
        for (const [win, record] of this._tracking?.entries() ?? []) {
            try {
                record.decoration.restack(getWindowActor(win));
            } catch {
                // Window went away mid-restack; the next restack drops it.
            }
        }
    }

    _resetBandCursors() {
        for (const [, record] of this._tracking?.entries() ?? [])
            record.decoration.resetBandCursor();
    }

    /**
     * Inputs for evaluateWindowActions; shared with pickAnswer().
     */
    _decorationInputs(win) {
        // No catch: `readWindow` answers null rather than throwing (its two rect reads have their own
        // try, the rest go through safeRead), so a throw from here is a bug of ours and must be seen.
        // Swallowing it would make it identical to an unreadable window, which defers forever.
        return win ? this._collectDecorationInputs(win) : null;
    }

    _collectDecorationInputs(win) {
        const reading = readWindow(win, {classifier: this._classifier});
        // A null reading means the rects could not be read. Keep it null so `reconcileOutcome`
        // defers instead of tearing the decoration down; only a window that is actually gone
        // reaches `destroy` through the actor path. A reading with `hasValidGeometry` false is a
        // read answer of "no extent", which still routes to undecorate.
        if (!reading)
            return null;

        // The visual floor judges the size the window was first decided at, so the latch closes on
        // the first pass the classification landed on: a pass that still defers, or that read no
        // extent, is not a frame to judge and must not close it. The picker's own reading comes
        // through here too, so one answer serves both.
        const deco = this._tracking?.get(win)?.decoration ?? null;
        if (reconcileOutcome(reading) === 'apply')
            deco?.latchInitialFrameSize(reading);
        const initial = deco?.initialFrameSize ?? null;

        return {
            ...reading,
            initialFrameWidth: initial?.width ?? null,
            initialFrameHeight: initial?.height ?? null,
            focused: reading.appearsFocused,
            highContrast: this._highContrast,
            animationsEnabled: this._animationsEnabled,
            dark: this._dark,
            rules: this._windowRules,
            preferCrispText: this._preferCrispText,
        };
    }

    /**
     * What picking a window means, from one reading: the property dictionary prefs reads, the rule
     * state the pick would store, and whether that would change the decoration.
     *
     * @returns Null when the window cannot be read; the state is null when there is no geometry, which
     *          is also when no rule can be suggested
     */
    pickAnswer(win) {
        const inputs = this._decorationInputs(win);
        if (!inputs)
            return null;

        const properties = extractWindowProperties(inputs, inputs.wmClass);
        if (!inputs.hasValidGeometry)
            return {properties, suggestedState: null, suggestedStateWouldChange: null};

        const state = suggestedRuleState(inputs);
        const changes = suggestedRuleWouldChange(properties, inputs, state);
        return {
            properties,
            suggestedState: state,
            suggestedStateWouldChange: typeof changes === 'boolean' ? changes : null,
        };
    }

    /**
     * Read-only state inspection snapshot for a tracked window decoration.
     * The introspection boundary for a tracked window's state in E2E tests and debugging.
     */
    stateView(win) {
        const record = this._tracking?.get(win);
        if (!record)
            return null;
        // firstFrameDone/isPendingReconcile are manager bookkeeping, so the manager adds them
        // to the decoration's own snapshot rather than the decoration reporting them.
        return {
            ...record.decoration.stateView,
            firstFrameDone: record.firstFrameDone,
            isPendingReconcile: record.isPendingReconcile,
        };
    }

    /**
     * The live decoration for a tracked window, for read-only diagnostics. Returns the
     * `WindowDecoration` itself (not its `stateView` snapshot), so the inspector can read the live
     * clip internals the diagnostic reply carries.
     */
    decorationFor(win) {
        return this._tracking?.get(win)?.decoration ?? null;
    }

    /**
     * Number of windows currently tracked by the manager.
     */
    get trackedCount() {
        return this._tracking?.size ?? 0;
    }

    /**
     * Whether any tracked window has a pending debounce reconcile timer.
     */
    get hasPendingWindowReconcile() {
        return Boolean(this._tracking?.hasPending);
    }

    /**
     * Whether the window is actively managed with a rounded clip.
     * @param win - Meta.Window
     */
    isWindowActivelyClipped(win) {
        return Boolean(this._tracking?.get(win)?.decoration.isActivelyClipped);
    }
}
