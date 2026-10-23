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
        this._classifier = this._replaceClassifier();
        // Created first, so a later enable() failure rolls back through disable() and drops it.
        this._tracking = new WindowTracking({
            onPassDue: win => this._reconcileWindow(win),
            onGone: win => this._forgetWindow(win),
            St,
        });

        // A provider answer can land after a window has been decided (see probeAdwaitaLook()).
        this._classifier.setOnProcessKnown(pid => this._onProcessKnown(pid));

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

        // Per-window isolation: one failure must not abort teardown of the windows left.
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
        // The phase mirror caches monitors per display; a stale list would outlive this session.
        invalidateMonitorCache();
        shadowTexture.destroy();
    }

    /** A fresh classifier replaces the old one, so a dead instance's caches cannot survive a cycle. */
    _replaceClassifier() {
        this._classifier?.destroy();
        this._classifier = null;
        return new ProcessClassifier();
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

    /** [safe] swallows a connect failure: window and actor signals vary across Shell versions. */
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

    /** Release drops the tracking-owned signals and idle; the decoration's own teardown is ours. */
    _destroyWindow(win, options = {}) {
        const record = this._tracking?.release(win) ?? null;
        record?.decoration.destroy(options);
        return record;
    }

    _forgetWindow(win) {
        const record = this._destroyWindow(win, {keepVisualsForClose: true});

        if (this._lastFocusWindow === win)
            this._lastFocusWindow = null;

        // Remembered pid, not a fresh read: a closing window can read empty.
        const pid = record?.pid ?? 0;
        if (pid > 0) {
            const hasPeer = this._tracking?.entries()
                .some(([, other]) => other.pid === pid) ?? false;
            if (!hasPeer)
                this._classifier?.forgetProcess(pid);
        }
    }

    /** A process answer that landed too late: decide its windows now. */
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

        // Reads and the decision sit outside the try; a throw there is ours and must stay visible.
        const actor = getWindowActor(win);
        this._tracking.observe(win);
        if (!actor || actor.width === 0 || actor.height === 0)
            return;

        // Tracking runs on window-created, so an X11 client may set _NET_WM_PID only later.
        this._tracking.learnPid(win);
        this._classifier?.probeAdwaitaLook(record.pid);

        const inputs = this._decorationInputs(win);
        // The branch lives in the reading module, so it is a pure function of the reading.
        const outcome = reconcileOutcome(inputs);
        if (outcome === 'defer')
            return;
        const actions = outcome === 'apply' ? evaluateWindowActions(inputs) : null;

        // Guard only the decoration's calls: actors do throw while Mutter tears a window down.
        try {
            if (outcome === 'undecorate') {
                record.decoration.undecorate();
            } else {
                record.decoration.apply({
                    actions,
                    inputs,
                    actor,
                    // Read once by observe() above, so the decoration does not ask again.
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

    /** Inputs for evaluateWindowActions, shared with pickAnswer() so one reading serves both. */
    _decorationInputs(win) {
        // No catch: readWindow answers null instead of throwing, so a throw here is our bug.
        return win ? this._collectDecorationInputs(win) : null;
    }

    _collectDecorationInputs(win) {
        const reading = readWindow(win, {classifier: this._classifier});
        // Null stays null: a window we cannot read is not a window that is gone.
        if (!reading)
            return null;

        // Latch only on an apply pass: one that defers or read no extent is not a frame to judge.
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

    /** One reading's properties, suggested rule state, and whether that would change it. */
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

    /** Read-only state snapshot of a tracked window; the E2E and debugging boundary. */
    stateView(win) {
        const record = this._tracking?.get(win);
        if (!record)
            return null;
        // Manager bookkeeping, added here rather than by the decoration's own snapshot.
        return {
            ...record.decoration.stateView,
            firstFrameDone: record.firstFrameDone,
            isPendingReconcile: record.isPendingReconcile,
        };
    }

    /** The live decoration, not its snapshot, so the inspector can read the live clip internals. */
    decorationFor(win) {
        return this._tracking?.get(win)?.decoration ?? null;
    }

    get trackedCount() {
        return this._tracking?.size ?? 0;
    }

    get hasPendingWindowReconcile() {
        return Boolean(this._tracking?.hasPending);
    }

    isWindowActivelyClipped(win) {
        return Boolean(this._tracking?.get(win)?.decoration.isActivelyClipped);
    }
}
