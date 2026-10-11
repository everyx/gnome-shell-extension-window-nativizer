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
import {FLAT_SAFE_INSET, ZERO_INSETS} from './frame.js';
import {normalizeConstrainedEdges} from './resizeBand.js';
import {resolveMonitorBounds} from './window.js';
import {WindowClientType} from './mutterRules.generated.js';
import {getWindowGroup, getDisplay, setActorBelowSibling} from '../platform/display.js';
import {getWindowActor, getWindowClientType} from '../platform/window.js';

/**
 * GNOME Shell's cap on an overview thumbnail's scale, from `WINDOW_PREVIEW_MAXIMUM_SCALE`
 * (js/ui/workspace.js). No preview is drawn larger than this fraction of the window's
 * logical size, which is what bounds the resolution the corner mask ever has to resolve.
 */
const OVERVIEW_PREVIEW_MAX_SCALE = 0.95;

/**
 * Hard ceiling on either side of the overview corner mask, in texels.
 *
 * Measured against actual rendering: the corner arc stops looking polygonal (mask texels
 * per screen pixel) at roughly 0.7, and is indistinguishable from a full-resolution mask
 * at 1.0. The ceiling only bites on monitors big enough that this preview never reaches it,
 * which keeps the arc above the visible threshold up to ~4K-wide displays and degrades it
 * gradually beyond.
 */
const OVERVIEW_MASK_MAX_DIMENSION = 2560;

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
        this._OverviewMask = options.OverviewMask ?? null;
        this._OverviewShadowClass = options.OverviewShadow ?? null;

        this.clip = null;
        this.clipTarget = null;
        this.clipInsets = null;
        this.drawClip = false;
        // The resolved ring plan for the current pass; null until the first apply().
        this.ring = null;

        this._style = null;
        this._scale = 1.0;
        this._inOverview = false;

        // Overview rounding: an A_8 mask on the shaped texture plus a shadow clone,
        // both live only while the overview is shown.
        this._overviewStex = null;
        this._forceOverviewCorners = false;
        this._overviewProbe = null;
        this._overviewContainer = null;
        this._overviewContainerDestroyId = 0;
        this._overviewSavedOpacity = 255;
        this._overviewSizeId = 0;
        this._overviewWorkspaceId = 0;
        this._overviewShadow = null;

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
     *   hasShadow: boolean,
     *   hasResizeBand: boolean,
     *   firstFrameDone: boolean,
     *   isPendingReconcile: boolean,
     *   ring: {insets: object|null, clear: boolean, erase: boolean}|null,
     * }}
     */
    get stateView() {
        return {
            hasClip: Boolean(this.clip),
            drawClip: this.drawClip,
            isActivelyClipped: this.isActivelyClipped,
            hasShadow: this.hasShadow,
            hasResizeBand: this.hasResizeBand,
            firstFrameDone: this.firstFrameDone,
            isPendingReconcile: Boolean(this.reconcileTimeout),
            ring: this.ring ? {...this.ring} : null,
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
    apply({actions, inputs, actor = null, target = null, inOverview = false, forceOverviewCorners = false}) {
        const winActor = this._getActor(actor);
        if (!winActor)
            return;

        this._forceOverviewCorners = Boolean(forceOverviewCorners);

        const clipTarget = target ?? resolveClipTarget(this._win, winActor, this._St);
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

        if (this.clip || this.shadow)
            this._applyStyle(actions.style, this.ring.insets, actions.drawClip, scale);

        // _syncClip only runs the overview transition when the clip's presence changed, so the
        // style this pass produced - and a desktop pass that has to take the clip back - is
        // applied to the overview state here.
        this.setOverviewMode(inOverview);
    }

    /**
     * Updates decoration state when entering or exiting Shell overview.
     * @param {boolean} inOverview
     */
    setOverviewMode(inOverview) {
        const wanted = Boolean(inOverview);
        // A fresh overview entry re-asks whether masking is safe; reconciles within one entry
        // reuse the answer, so the probe reads a texture at most once per entry.
        if (wanted !== this._inOverview)
            this._overviewProbe = null;
        this._inOverview = wanted;

        if (!this._inOverview) {
            this._dropOverview();
            this.clip?.set_enabled?.(true);
            this._syncClipParams();
            return;
        }

        // Three ways a window can be shown in the overview. Rounded and sharp comes from the
        // shaped-texture mask, and is only taken where it costs the desktop nothing; rounded and
        // blurry is the legacy offscreen clip, kept when the user forces corners; neither leaves
        // the thumbnail square, and as sharp as an undecorated window.
        const maskable = this._canApplyOverviewMask() && !this._overviewMaskWouldChangeDesktop();
        const keepClip = !maskable && this._forceOverviewCorners;

        if (this.clip) {
            this.clip.set_enabled(keepClip);
            this._syncClipParams();
        }

        // The shadow does not depend on the clip either way: a window can carry a shadow without
        // corners (prefer-crisp-text on a fractional scale).
        this._syncOverviewHooks();
        if (maskable)
            this._applyOverviewMask();
        else
            this._clearOverviewMask();
        this._applyOverviewShadow();
    }

    /** Drops every overview visual and hook: the overview ended, or the decoration is going away. */
    _dropOverview() {
        this._inOverview = false;
        this._clearOverviewMask();
        this._clearOverviewShadow();
        this._syncOverviewHooks();
    }

    /**
     * Connects, or drops, the preview-lifecycle hooks.
     *
     * The overview rebuilds a window's preview - and with it the card and its container - when
     * the window moves to another workspace, and a client can resize itself while the overview
     * is open. Either leaves the mask and the shadow clone attached to a card that no longer
     * exists, so both are re-applied when the hook fires.
     */
    _syncOverviewHooks() {
        if (this._inOverview) {
            if (!this._overviewSizeId)
                this._overviewSizeId = this._win.connect('size-changed', () => this._refreshOverview());
            if (!this._overviewWorkspaceId)
                this._overviewWorkspaceId = this._win.connect('workspace-changed', () => this._refreshOverview());
            return;
        }

        if (this._overviewSizeId) {
            try {
                this._win.disconnect(this._overviewSizeId);
            } catch {
                // Window already gone.
            }
            this._overviewSizeId = 0;
        }

        if (this._overviewWorkspaceId) {
            try {
                this._win.disconnect(this._overviewWorkspaceId);
            } catch {
                // Window already gone.
            }
            this._overviewWorkspaceId = 0;
        }
    }

    /**
     * Whether the overview can round this window through the shaped-texture mask. A window whose
     * corner or outline is not drawn has no mask to build.
     *
     * @returns {boolean}
     */
    _canApplyOverviewMask() {
        if (!this.drawClip || !this._style)
            return false;
        // XWayland keeps the window's shape in the same mask slot and Mutter rewrites it
        // from that shape, so overwriting it would deform the window once the overview ends —
        // and GJS cannot put it back (`set_mask_texture` rejects null).
        return getWindowClientType(this._win) !== WindowClientType.X11;
    }

    /**
     * Probes whether masking this window would move a path the desktop can see, so the overview
     * can leave that window alone instead. See `overviewMask.maskWouldChangeScreenshot`.
     *
     * @returns {boolean}
     */
    _overviewMaskWouldChangeDesktop() {
        if (this._overviewProbe === null) {
            const probe = this._OverviewMask?.maskWouldChangeScreenshot;
            this._overviewProbe = probe
                ? Boolean(probe(this._getActor()?.get_texture?.() ?? null))
                : true;
        }
        return this._overviewProbe;
    }

    /**
     * Rounds the window's shaped texture during the overview.
     *
     * Mutter samples the mask with the same minification filter as the window
     * colour, so a downscaled thumbnail keeps hardware mipmapping. Mutter skips
     * the mask on its opaque fast path, so the preview container's opacity is
     * pulled one step below 255 to force the blended path; the 1/255 alpha that
     * costs is imperceptible.
     */
    _applyOverviewMask() {
        if (this._overviewStex || !this._canApplyOverviewMask() || this._overviewMaskWouldChangeDesktop())
            return;

        const buildRoundedMask = this._OverviewMask?.buildRoundedMask;
        if (!buildRoundedMask)
            return;

        const actor = this._getActor();
        const stex = actor?.get_texture?.() ?? null;
        const multi = stex?.get_texture?.() ?? null;
        const context = multi?.get_plane?.(0)?.get_context?.() ?? null;
        const preview = this._win?._delegate ?? null;
        const container = preview?.window_container ?? null;
        if (!stex || !context || !container)
            return;

        const actorWidth = actor?.width ?? 0;
        const actorHeight = actor?.height ?? 0;
        const textureWidth = multi.get_width?.() ?? 0;
        const textureHeight = multi.get_height?.() ?? 0;
        if (!(actorWidth > 0) || !(actorHeight > 0) || !(textureWidth > 0) || !(textureHeight > 0))
            return;

        // Insets and radius are logical; the texture carries the client's buffer.
        const bufferScale = textureWidth / actorWidth;
        const insets = this.clipInsets ?? ZERO_INSETS;

        // A thumbnail-sized mask is all the corner arcs need; a full-buffer one would cost
        // a byte per client pixel (tens of MB for a hidpi 4K window) for detail the preview
        // cannot show.
        const maskScale = this._overviewMaskScale(textureWidth, textureHeight, bufferScale, this._scale || 1);
        const mask = buildRoundedMask(context, {
            width: textureWidth * maskScale,
            height: textureHeight * maskScale,
            frameX: insets.left * bufferScale * maskScale,
            frameY: insets.top * bufferScale * maskScale,
            frameW: (actorWidth - insets.left - insets.right) * bufferScale * maskScale,
            frameH: (actorHeight - insets.top - insets.bottom) * bufferScale * maskScale,
            radius: (this._style.radius ?? 0) * bufferScale * maskScale,
            clearRing: this.clip ? Boolean(this.ring?.erase) : false,
        });
        if (!mask)
            return;

        stex.set_mask_texture(mask);

        this._overviewStex = stex;
        this._overviewContainer = container;
        this._overviewContainerDestroyId = container.connect('destroy', () => {
            // The preview can be torn down before the overview 'hidden' signal; drop the
            // reference so the teardown never touches a disposed actor.
            this._overviewContainer = null;
            this._overviewContainerDestroyId = 0;
        });
        this._overviewSavedOpacity = container.get_opacity();
        container.set_opacity(Math.min(254, this._overviewSavedOpacity));
    }

    /**
     * Resolution factor for the overview corner mask.
     *
     * The mask is sampled through the window texture's own coordinates, so it only has to
     * resolve what the overview actually draws: a thumbnail never larger than
     * `OVERVIEW_PREVIEW_MAX_SCALE` of the window's logical size, on screen at the monitor
     * scale. In buffer texels that is `OVERVIEW_PREVIEW_MAX_SCALE * monitorScale / bufferScale`,
     * so a hidpi-buffer client on a low-dpi monitor gets downsampled, and a 1x client on a
     * hidpi monitor is capped at buffer resolution. A full-buffer mask would instead cost a
     * byte per client pixel — tens of megabytes for a 4K window — for detail no preview shows.
     *
     * @param {number} textureWidth - Window buffer width, texture px
     * @param {number} textureHeight - Window buffer height, texture px
     * @param {number} bufferScale - Buffer texels per logical pixel
     * @param {number} monitorScale - Monitor scale for the window's monitor
     * @returns {number} Factor in [0.05, 1]
     */
    _overviewMaskScale(textureWidth, textureHeight, bufferScale, monitorScale) {
        const longest = Math.max(textureWidth, textureHeight);
        const previewScale = OVERVIEW_PREVIEW_MAX_SCALE * monitorScale / (bufferScale || 1);
        const scale = Math.min(previewScale, OVERVIEW_MASK_MAX_DIMENSION / longest);
        return Math.min(1, Math.max(scale, 0.05));
    }

    /** Re-applies the mask and the shadow clone after the card, or the window, changes. */
    _refreshOverview() {
        if (!this._inOverview)
            return;
        // The card, or the client's buffer, changed: ask the probe again.
        this._overviewProbe = null;
        this._clearOverviewMask();
        if (this._canApplyOverviewMask() && !this._overviewMaskWouldChangeDesktop())
            this._applyOverviewMask();
        this._clearOverviewShadow();
        this._applyOverviewShadow();
    }

    /** Retires the overview mask and restores the preview container opacity. */
    _clearOverviewMask() {
        if (this._overviewContainerDestroyId) {
            try {
                this._overviewContainer.disconnect(this._overviewContainerDestroyId);
            } catch {
                // Preview already gone.
            }
            this._overviewContainerDestroyId = 0;
        }

        if (this._overviewContainer) {
            try {
                this._overviewContainer.set_opacity(this._overviewSavedOpacity);
            } catch {
                // Preview already destroyed.
            }
            this._overviewContainer = null;
        }

        if (this._overviewStex) {
            const opaqueMask = this._OverviewMask?.opaqueMask;
            const context = this._overviewStex.get_texture?.()?.get_plane?.(0)?.get_context?.() ?? null;
            if (opaqueMask && context) {
                try {
                    this._overviewStex.set_mask_texture(opaqueMask(context));
                } catch {
                    // Shaped texture already gone.
                }
            }
            this._overviewStex = null;
        }
    }

    /** Adds the shadow clone under the overview preview. */
    _applyOverviewShadow() {
        const OverviewShadow = this._OverviewShadowClass;
        if (this._overviewShadow || !this.shadow || !OverviewShadow)
            return;

        const preview = this._win?._delegate ?? null;
        const container = preview?.window_container ?? null;
        if (!preview || !container)
            return;

        const width = this._win.get_frame_rect?.()?.width ?? 0;
        if (!(width > 0))
            return;

        try {
            const shadow = new OverviewShadow(this.shadow, preview, container, width);
            shadow.connect('destroy', () => {
                // The preview owns the clone and destroys it before 'hidden'; null the
                // reference so teardown never calls into a disposed actor.
                if (this._overviewShadow === shadow)
                    this._overviewShadow = null;
            });
            this._overviewShadow = shadow;
        } catch {
            this._overviewShadow = null;
        }
    }

    /** Removes the overview shadow clone. */
    _clearOverviewShadow() {
        if (!this._overviewShadow)
            return;
        try {
            this._overviewShadow.destroy();
        } catch {
            // Preview already destroyed.
        }
        this._overviewShadow = null;
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
                erase: Boolean(this.ring?.erase),
                clearStroke: !this._inOverview && Boolean(this.ring?.clear),
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
        this.ring = null;
        this._dropOverview();
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

        this._dropOverview();

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
