/**
 * WindowDecoration: encapsulates the single-window decoration lifecycle and tri-axis actors.
 * Manages the synchronized lifecycle of:
 * - RoundedClipEffect (clip)
 * - ShadowActor (shadow & backdrop cross-fade)
 * - ResizeBand (grab handles)
 *
 * Designed with dependency injection for full unit-testability without GNOME Shell private typelibs.
 */

import GLib from 'gi://GLib';

import {resolveClipTarget} from './clipTarget.js';
import {hasPositiveInsets, FLAT_SAFE_INSET} from './frame.js';
import {normalizeConstrainedEdges} from './resizeBand.js';
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
     */
    constructor(win, options = {}) {
        this._win = win;
        this._container = options.container ?? (getWindowGroup() ?? null);
        this._display = options.display ?? (getDisplay() ?? null);
        this._St = options.St ?? (globalThis.St ?? null);

        this._RoundedClipEffect = options.RoundedClipEffect ?? null;
        this._ShadowActor = options.ShadowActor ?? null;
        this._ResizeBand = options.ResizeBand ?? null;

        this.clip = null;
        this.clipTarget = null;
        this.clipInsets = null;
        this.clearRing = false;
        this.effectiveClearRing = false;
        this.drawClip = false;

        this._style = null;
        this._scale = 1.0;
        this._inOverview = false;

        this.shadow = null;
        this.resizeBand = null;

        this.idleId = null;
        this.reconcileTimeout = null;

        this.firstFrameDone = false;
        this.actorWired = false;
        this.signals = [];
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
     *   clearRing: boolean,
     *   effectiveClearRing: boolean,
     *   hasShadow: boolean,
     *   hasResizeBand: boolean,
     *   firstFrameDone: boolean,
     *   isPendingReconcile: boolean,
     * }}
     */
    get stateView() {
        return {
            hasClip: Boolean(this.clip),
            drawClip: this.drawClip,
            isActivelyClipped: this.isActivelyClipped,
            clearRing: this.clearRing,
            effectiveClearRing: this.effectiveClearRing,
            hasShadow: this.hasShadow,
            hasResizeBand: this.hasResizeBand,
            firstFrameDone: this.firstFrameDone,
            isPendingReconcile: Boolean(this.reconcileTimeout),
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
     * @param {Clutter.Actor} [params.target] - Resolved clip target actor
     * @param {boolean} [params.inOverview=false]
     */
    apply({actions, inputs, actor = null, target = null, inOverview = false}) {
        const winActor = this._getActor(actor);
        if (!winActor)
            return;

        const clipTarget = target ?? resolveClipTarget(this._win, winActor, this._St);
        const rawInsets = inputs.insets;
        const scale = inputs?.monitorScale ?? 1.0;

        const isFlat = !hasPositiveInsets(rawInsets);
        const decorInsets = isFlat && (actions.drawClip || actions.drawShadow)
            ? FLAT_SAFE_INSET
            : rawInsets;

        this._syncClip(actions.drawClip || actions.clearRing, actions.clearRing, clipTarget, decorInsets, inOverview, isFlat);

        // Draw shadow actor if tiled ring is needed, or if window needs drop shadow without deferring to client.
        const deferToClientShadow = actions.clearRing && !this.clip;
        this._syncShadow(actions.drawRing || (!deferToClientShadow && actions.drawShadow), winActor);

        this._syncResizeBand(actions.drawResize, inputs, decorInsets, winActor);

        if (this.clip || this.shadow)
            this._applyStyle(actions.style, decorInsets, actions.drawClip, scale);
    }

    /**
     * Updates decoration state when entering or exiting Shell overview.
     * @param {boolean} inOverview
     */
    setOverviewMode(inOverview) {
        this._inOverview = Boolean(inOverview);
        if (!this.clip)
            return;
        this.clip.setOverviewMode?.(this._inOverview);
        this._syncClipParams();
    }

    /**
     * @param {boolean} wantEffect
     * @param {boolean} clearRing
     * @param {Clutter.Actor|null} clipTarget
     * @param {import('./frame.js').Insets|null} insets
     * @param {boolean} [inOverview=false]
     * @param {boolean} [isFlat=false]
     */
    _syncClip(wantEffect, clearRing = false, clipTarget = null, insets = null, inOverview = false, isFlat = false) {
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
            // X11 may replace surface child; re-pin if target moved.
            if (clipTarget !== this.clipTarget) {
                this._removeClipEffect();
                this.clipTarget = clipTarget;
                this.clipTarget?.add_effect?.(this.clip);
            }
        }
        this.clipInsets = this.clip ? insets : null;
        this.clearRing = Boolean(clearRing);
        this.effectiveClearRing = this.clip ? Boolean(clearRing || isFlat) : false;
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
        this.drawClip = Boolean(drawClip && style.radius > 0);

        this._syncClipParams();
        if (this.shadow) {
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
                outline: this.drawClip && !this._inOverview ? this._style.outline : null,
                clearRing: this.effectiveClearRing,
                clearStroke: !this._inOverview && this.clearRing,
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

    /** Drops any scheduled idle or timeout callbacks. */
    _dropPendingWork() {
        if (this.idleId) {
            GLib.Source.remove(this.idleId);
            this.idleId = null;
        }
        if (this.reconcileTimeout) {
            GLib.Source.remove(this.reconcileTimeout);
            this.reconcileTimeout = null;
        }
    }

    /**
     * Completely removes all effects and actors without destroying signal bindings.
     */
    undecorate() {
        this.drawClip = false;
        this._style = null;
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
     * 1. Cancels pending timer/idle callbacks;
     * 2. Destroys the resize band (preventing stray clicks);
     * 3. Disconnects all signal listeners;
     * 4. Detaches and destroys clip and shadow actors (unless keepVisualsForClose is true).
     *
     * @param {object} [options]
     * @param {boolean} [options.keepVisualsForClose=false] - Keep clip and shadow attached
     *        so MetaWindowActor's close animation completes without visual pop.
     */
    destroy({keepVisualsForClose = false} = {}) {
        this._dropPendingWork();

        try {
            this.resizeBand?.destroy?.();
        } catch {
            // Already destroyed.
        }
        this.resizeBand = null;

        for (const [obj, id] of this.signals) {
            try {
                obj?.disconnect?.(id);
            } catch {
                // Object already gone.
            }
        }
        this.signals.length = 0;

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
