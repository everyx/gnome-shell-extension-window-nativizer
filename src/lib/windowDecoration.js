/**
 * WindowDecoration: encapsulates the single-window decoration lifecycle and tri-axis actors.
 * Manages the synchronized lifecycle of:
 * - RoundedClipEffect (clip)
 * - ShadowActor (shadow & backdrop cross-fade)
 * - ResizeBand (grab handles)
 *
 * Designed with dependency injection for full unit-testability without GNOME Shell private typelibs.
 */

import {resolveClipTarget} from './clipTarget.js';
import {FLAT_SAFE_INSET} from './frame.js';
import {normalizeConstrainedEdges} from './resizeBand.js';
import {OverviewDecoration} from './overviewDecoration.js';
import {resolveMonitorBounds} from './window.js';
import {getWindowGroup, getDisplay, setActorBelowSibling} from '../platform/display.js';
import {getWindowActor} from '../platform/window.js';

export class WindowDecoration {
    /**
     * @param {Meta.Window} win
     * @param {object} [options]
     * @param {Clutter.Actor} [options.container] - Usually getWindowGroup()
     * @param {Meta.Display} [options.display] - Usually getDisplay()
     * @param {object} [options.St] - Usually imports.gi.St
     * @param {Function} [options.RoundedClipEffect]
     * @param {Function} [options.ShadowActor]
     * @param {Function} [options.ResizeBand]
     * @param {object} [options.OverviewMask] - {buildRoundedMask, opaqueMask} texture builders
     * @param {Function} [options.OverviewShadow] - Clutter.Clone subclass carrying the preview shadow
     */
    constructor(win, options = {}) {
        this._win = win;
        this._container = options.container ?? (getWindowGroup() ?? null);
        this._display = options.display ?? (getDisplay() ?? null);
        this._St = options.St ?? (globalThis.St ?? null);

        this._RoundedClipEffect = options.RoundedClipEffect ?? null;
        this._ShadowActor = options.ShadowActor ?? null;
        this._ResizeBand = options.ResizeBand ?? null;

        // The overview's own decoration (mask, container opacity, shadow clone) is a
        // lifecycle of its own; the desktop reads it for clip decisions but never reaches in.
        this.overview = new OverviewDecoration(win, {
            OverviewMask: options.OverviewMask ?? null,
            OverviewShadow: options.OverviewShadow ?? null,
            // A card rebuild inside the overview can settle on a different mode than the entry
            // did; the desktop clip must follow whatever was actually installed.
            onModeChange: mode => this._syncOverviewClip(mode),
        });

        this.clip = null;
        this.clipTarget = null;
        // The resolved target's phase strategy; the clip effect reads it at attach/repin time.
        this.clipPhaseInTransform = true;
        this.clipInsets = null;
        this.drawClip = false;
        // The resolved ring plan for the current pass; null until the first apply().
        this.ring = null;

        this._style = null;
        this._scale = 1.0;
        // The manager's "force corners" setting for this pass; handed to the overview, which
        // picks the legacy offscreen clip over the mask when masking is unsafe.
        this._forceOverviewCorners = false;

        this.shadow = null;
        this.resizeBand = null;
    }

    /** @returns {boolean} Whether the window is actively managed with a rounded clip effect */
    get isActivelyClipped() {
        return Boolean(this.clip && this.drawClip);
    }

    /** @returns {boolean} Whether a clip effect is attached */
    get hasClip() {
        return Boolean(this.clip);
    }

    /** @returns {boolean} Whether a shadow actor is attached */
    get hasShadow() {
        return Boolean(this.shadow);
    }

    /** @returns {boolean} Whether an active resize band is attached */
    get hasResizeBand() {
        return Boolean(this.resizeBand);
    }

    /**
     * Returns a fresh snapshot copy of the current decoration state flags.
     *
     * @returns {{
     *   hasClip: boolean,
     *   drawClip: boolean,
     *   isActivelyClipped: boolean,
     *   hasShadow: boolean,
     *   hasResizeBand: boolean,
     *   ring: {insets: object|null, clear: boolean, erase: boolean}|null,
     *   overview: {inOverview: boolean, hasMask: boolean, hasShadow: boolean, hasContainer: boolean, isProbed: boolean},
     * }}
     */
    get stateView() {
        return {
            hasClip: Boolean(this.clip),
            drawClip: this.drawClip,
            isActivelyClipped: this.isActivelyClipped,
            hasShadow: this.hasShadow,
            hasResizeBand: this.hasResizeBand,
            ring: this.ring ? {...this.ring} : null,
            overview: this.overview.stateView,
        };
    }

    /**
     * Safely retrieves the window compositor private actor.
     * @param {Clutter.Actor} [actor]
     * @returns {Clutter.Actor|null}
     */
    _getActor(actor = null) {
        if (actor)
            return actor;
        return getWindowActor(this._win);
    }

    /**
     * Applies evaluated actions and inputs to the tri-axis window decoration.
     * Core public interface: apply(params), setOverviewMode(inOverview), destroy(options).
     *
     * @param {object} params
     * @param {import('./detector.js').WindowActions} params.actions
     * @param {object} params.inputs
     * @param {Clutter.Actor} [params.actor] - Window actor
     * @param {{actor: Clutter.Actor, phaseInTransform: boolean}} [params.target] - A
     *        resolveClipTarget() result; resolved from the window when omitted
     * @param {boolean} [params.inOverview=false]
     */
    apply({actions, inputs, actor = null, target = null, inOverview = false, forceOverviewCorners = false}) {
        const winActor = this._getActor(actor);
        if (!winActor)
            return;

        this._forceOverviewCorners = Boolean(forceOverviewCorners);

        const resolvedTarget = target ?? resolveClipTarget(this._win, winActor, this._St);
        const clipTarget = resolvedTarget?.actor ?? null;
        this.clipPhaseInTransform = resolvedTarget?.phaseInTransform ?? false;
        const rawInsets = inputs.insets;
        const scale = inputs?.monitorScale ?? 1.0;

        // One plan per pass: the insets the body uses, and the two meanings the clip shader gives
        // the ring. Every consumer below reads this instead of recombining the detector's answer.
        this.ring = {
            insets: actions.ring.safeInset && (actions.drawClip || actions.drawShadow)
                ? FLAT_SAFE_INSET : rawInsets,
            clear: actions.ring.clear,
            erase: actions.ring.clear || actions.ring.safeInset,
        };

        this._syncClip(actions.drawClip || actions.ring.clear, clipTarget, this.ring.insets, inOverview);

        // Draw shadow actor if tiled ring is needed, or if window needs drop shadow without deferring to client.
        const deferToClientShadow = actions.ring.clear && !this.clip;
        this._syncShadow(actions.drawRing || (!deferToClientShadow && actions.drawShadow), winActor);

        this._syncResizeBand(actions.drawResize, inputs, this.ring.insets, winActor);

        // The style is this pass's own reading of the corner state; the overview re-reads it, so a
        // pass that draws nothing (maximized, fullscreen) must still clear the previous one's.
        this._applyStyle(actions.style, this.ring.insets, actions.drawClip, scale);

        // _syncClip only runs the overview transition when the clip's presence changed, so the
        // style this pass produced - and a desktop pass that has to take the clip back - is
        // applied to the overview state here.
        this.setOverviewMode(inOverview);
    }

    /**
     * Updates decoration state when entering or exiting Shell overview.
     *
     * The overview's own visuals live in `this.overview`; this only hands it the readings it
     * cannot take for itself, then keeps the desktop clip in step with the choice it made. The
     * mask replaces the clip while it is safe, the legacy offscreen clip stays when the user
     * forces corners, and on exit the clip comes back.
     *
     * @param {boolean} inOverview
     */
    setOverviewMode(inOverview) {
        const mode = this.overview.setMode(inOverview, {
            radius: this._style?.radius ?? 0,
            insets: this.clipInsets,
            erase: this.clip ? Boolean(this.ring?.erase) : false,
            scale: this._scale,
            drawClip: this.drawClip,
            hasStyle: Boolean(this._style),
            forceOverviewCorners: this._forceOverviewCorners,
            shadow: this.shadow,
        });

        this._syncOverviewClip(mode);
    }

    /**
     * Keeps the desktop clip in step with the overview mode that actually installed. Called when
     * a pass enters or leaves the overview, and when the overview rebuilds its card under a
     * resize or workspace change - the two paths that can change the mode.
     *
     * @param {'mask'|'clip'|'square'} mode
     */
    _syncOverviewClip(mode) {
        if (!this.clip)
            return;
        // The overview chose the outcome; on the desktop the clip is simply on. `enabled` is
        // computed once so a resume and its matching enable cannot disagree.
        const enabled = this.overview.inOverview ? mode === 'clip' : true;
        if (enabled)
            this.clip.resume?.();
        this.clip.set_enabled(enabled);
        this._syncClipParams();
    }

    /**
     * @param {boolean} wantEffect
     * @param {Clutter.Actor|null} [clipTarget=null]
     * @param {import('./frame.js').Insets|null} [insets=null]
     * @param {boolean} [inOverview=false]
     */
    _syncClip(wantEffect, clipTarget = null, insets = null, inOverview = false) {
        // Clip effect requires valid insets (null indicates frame does not fit inside buffer).
        const wanted = wantEffect && Boolean(insets);
        const hasClip = Boolean(this.clip);

        if (wanted !== hasClip) {
            if (wanted) {
                const ClipClass = this._RoundedClipEffect;
                this.clip = ClipClass ? new ClipClass() : null;
                this.clipTarget = clipTarget;
                this.clipTarget?.add_effect?.(this.clip);
            } else {
                this._removeClipEffect();
                this.clip = null;
                this.clipTarget = null;
            }
        } else if (wanted) {
            // XWayland may replace surface child; re-pin if target moved.
            if (clipTarget !== this.clipTarget) {
                this._removeClipEffect();
                this.clipTarget = clipTarget;
                this.clipTarget?.add_effect?.(this.clip);
            }
        }
        // The target's identity and its phase strategy are one report, so a re-pin also re-states
        // the strategy; the effect's setter is a no-op while it is unchanged.
        if (this.clip)
            this.clip.setPhaseInTransform?.(this.clipPhaseInTransform);
        this.clipInsets = this.clip ? insets : null;
        // Only a clip appearing or going away changes the overview's options. While the overview
        // is open, apply() syncs the rest once the style is current.
        if (wanted !== hasClip)
            this.setOverviewMode(inOverview);
    }

    /**
     * @param {boolean} wantShadow
     * @param {Clutter.Actor} [actor]
     */
    _syncShadow(wantShadow, actor = null) {
        const winActor = this._getActor(actor);
        if (!winActor)
            return;

        const hasShadow = Boolean(this.shadow);
        if (wantShadow !== hasShadow) {
            if (wantShadow) {
                const ShadowClass = this._ShadowActor;
                this.shadow = ShadowClass ? new ShadowClass(winActor, this._container) : null;
            } else {
                this.shadow?.destroy?.();
                this.shadow = null;
            }
        }
    }

    /**
     * @param {boolean} want
     * @param {object} inputs
     * @param {import('./frame.js').Insets|null} insets
     * @param {Clutter.Actor} [actor]
     */
    _syncResizeBand(want, inputs, insets, actor = null) {
        if (!want) {
            this.resizeBand?.destroy?.();
            this.resizeBand = null;
            return;
        }

        const winActor = this._getActor(actor);
        if (!winActor)
            return;

        if (!this.resizeBand) {
            const BandClass = this._ResizeBand;
            this.resizeBand = BandClass ? new BandClass(winActor, this._container) : null;
        }

        let bounds = null;
        try {
            bounds = resolveMonitorBounds(this._display, this._win);
        } catch {
            // Defend against window deallocation or monitor hotplug races
        }

        const constrainedEdges = normalizeConstrainedEdges({
            maximizedHorizontally: inputs?.maximizedHorizontally,
            maximizedVertically: inputs?.maximizedVertically,
        });

        this.resizeBand?.setGeometry?.({
            insets: insets ?? null,
            bounds,
            // `resolveMonitorBounds` answers null both when the display is stale and when the
            // read threw. That is "bounds unknown", not "do not clip": without this the strips
            // are written at full extent and a window flush against an edge swallows clicks on
            // the neighbouring monitor.
            boundsUnknown: bounds === null,
            scale: inputs?.monitorScale ?? 1,
            constrainedEdges,
        });
    }

    /**
     * @param {object} style
     * @param {import('./frame.js').Insets|null} insets
     * @param {boolean} drawClip
     * @param {number} [scale=1.0]
     */
    _applyStyle(style, insets, drawClip, scale = 1.0) {
        this._style = style;
        this._scale = scale;
        // Record what is drawn, not what was asked: a pass whose insets are null has no clip to
        // attach, so the overview must not later mask a corner the desktop never shows.
        this.drawClip = Boolean(this.clip && drawClip && style.radius > 0);

        this._syncClipParams();
        if (this.shadow) {
            // Both cuts read the same phase source: the shadow follows the clip's resolved target
            // strategy (see shadowPhaseOffset).
            this.shadow.setPhaseInTransform?.(this.clipPhaseInTransform);
            this.shadow.setScale?.(scale);
            this.shadow.setShadowInsets?.(insets);
            this.shadow.setShadowStyle?.({
                ...style,
                radius: this.clip && drawClip ? style.radius : 0,
            });
        }
    }

    /**
     * Synchronizes clip parameters to shader, suppressing inner outline during overview.
     */
    _syncClipParams() {
        if (this.clip && this.clipInsets && this._style) {
            this.clip.setParams?.({
                insets: this.clipInsets,
                radius: this.drawClip ? this._style.radius : 0,
                outline: this.drawClip && !this.overview.inOverview ? this._style.outline : null,
                erase: Boolean(this.ring?.erase),
                clearStroke: !this.overview.inOverview && Boolean(this.ring?.clear),
                scale: this._scale,
            });
        }
    }

    /**
     * Restacks shadow actor below the window actor and syncs resize band stack order.
     * @param {Clutter.Actor} [actor]
     */
    restack(actor = null) {
        const winActor = this._getActor(actor);
        if (!winActor)
            return;

        if (this.shadow && this._container)
            setActorBelowSibling(this.shadow, winActor, this._container);

        this.resizeBand?.restack?.();
    }

    resetBandCursor() {
        this.resizeBand?.resetCursor?.();
    }

    /**
     * Completely removes all effects and actors without destroying signal bindings.
     */
    undecorate() {
        this.drawClip = false;
        this._style = null;
        this.ring = null;
        this.overview.drop();
        this._syncClip(false);
        this._syncShadow(false);
        this._syncResizeBand(false, null, null);
    }

    _removeClipEffect() {
        if (!this.clip || !this.clipTarget)
            return;

        try {
            this.clipTarget.remove_effect?.(this.clip);
        } catch {
            // Target already gone.
        }
    }

    /**
     * Phased teardown of the window decoration:
     * 1. Destroys the resize band (preventing stray clicks);
     * 2. Drops the overview decoration;
     * 3. Detaches and destroys clip and shadow actors (unless keepVisualsForClose is true).
     *
     * The signals, debounce and first-frame idle are the manager's, torn down there.
     *
     * @param {object} [options]
     * @param {boolean} [options.keepVisualsForClose=false] - Keep clip and shadow attached
     *        so MetaWindowActor's close animation completes without visual pop.
     */
    destroy({keepVisualsForClose = false} = {}) {
        try {
            this.resizeBand?.destroy?.();
        } catch {
            // Already destroyed.
        }
        this.resizeBand = null;

        this.overview.drop();

        if (!keepVisualsForClose) {
            this._removeClipEffect();
            this.clip = null;
            this.clipTarget = null;
            this.clipInsets = null;

            try {
                this.shadow?.destroy?.();
            } catch {
                // Already destroyed.
            }
            this.shadow = null;
        }
    }
}
