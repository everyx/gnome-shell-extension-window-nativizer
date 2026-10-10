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
import {hasPositiveInsets, FLAT_SAFE_INSET, ZERO_INSETS} from './frame.js';
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
 * which keeps the arc above the visible threshold up to ~5K-wide displays and degrades it
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
        this.clearRing = false;
        this.effectiveClearRing = false;
        this.drawClip = false;

        this._style = null;
        this._scale = 1.0;
        this._inOverview = false;

        // Overview rounding: an A_8 mask on the shaped texture plus a shadow clone,
        // both live only while the overview is shown.
        this._overviewStex = null;
        this._overviewMask = null;
        this._overviewSurface = null;
        this._overviewMaskRestoreId = 0;
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

        // _syncClip runs the overview transition before the style is current, so on the
        // applying pass the mask decision has to be taken once more.
        if (inOverview)
            this.setOverviewMode(true);
    }

    /**
     * Updates decoration state when entering or exiting Shell overview.
     * @param {boolean} inOverview
     */
    setOverviewMode(inOverview) {
        this._inOverview = Boolean(inOverview);
        if (!this.clip)
            return;
        // The offscreen clip is suspended for the overview on every client type: the FBO it
        // renders into has no mipmaps, and the preview clone's downscale of it is what blurs
        // thumbnails. Rounding moves into the shaped-texture mask instead, which rides
        // Mutter's own mipmapped pipeline.
        this.clip.set_enabled?.(!this._inOverview);
        this._syncClipParams();
        if (this._inOverview && this._canApplyOverviewMask())
            this._applyOverviewMask();
        else
            this._clearOverviewMask();
        if (this._inOverview)
            this._applyOverviewShadow();
        else
            this._clearOverviewShadow();
    }

    /**
     * Whether the overview can round this window through the shaped-texture mask.
     *
     * X11/XWayland also qualifies: Mutter rebuilds the mask from the X11 shape on surface
     * syncs, so the mask is re-applied after those (see `_applyOverviewMask`). A window whose
     * corner or outline is not drawn has no mask to build.
     *
     * @returns {boolean}
     */
    _canApplyOverviewMask() {
        return Boolean(this.drawClip && this._style);
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
        if (this._overviewStex || !this._canApplyOverviewMask())
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
            clearRing: this.effectiveClearRing,
        });
        if (!mask)
            return;

        stex.set_mask_texture(mask);

        this._overviewStex = stex;
        this._overviewMask = mask;
        this._overviewContainer = container;
        this._overviewContainerDestroyId = container.connect('destroy', () => {
            // The preview can be torn down before the overview 'hidden' signal; drop the
            // reference so the teardown never touches a disposed actor.
            this._overviewContainer = null;
            this._overviewContainerDestroyId = 0;
        });
        this._overviewSavedOpacity = container.get_opacity();
        container.set_opacity(Math.min(254, this._overviewSavedOpacity));
        this._overviewSizeId = this._win.connect('size-changed', () => this._refreshOverviewMask());

        // A workspace move made from the overview builds a fresh WindowPreview whose container
        // starts at full opacity, so the mask and the opacity bypass have to be re-applied to
        // the new card. The new preview is already in place when the signal lands.
        this._overviewWorkspaceId = this._win.connect('workspace-changed', () => this._refreshOverviewMask());

        // X11/XWayland rebuilds this mask slot from the X11 shape on every surface sync
        // (`meta_xwayland_surface_sync_actor_state` -> `update_regions` ->
        // `build_and_scan_frame_mask`), so it has to be re-applied after each one. The
        // surface actor announces exactly that with 'repaint-scheduled'; native Wayland
        // surfaces never touch the slot, so only X11 needs the hook.
        if (getWindowClientType(this._win) === WindowClientType.X11) {
            const surface = this.clipTarget;
            if (typeof surface?.connect === 'function') {
                this._overviewSurface = surface;
                this._overviewMaskRestoreId = surface.connect('repaint-scheduled', () => {
                    this._overviewStex?.set_mask_texture?.(this._overviewMask);
                });
            }
        }
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

    /** Rebuilds the mask after a resize while the overview is shown. */
    _refreshOverviewMask() {
        if (!this._inOverview || !this._overviewStex)
            return;
        this._clearOverviewMask();
        this._applyOverviewMask();
    }

    /** Retires the overview mask and restores the preview container opacity. */
    _clearOverviewMask() {
        if (this._overviewMaskRestoreId) {
            try {
                this._overviewSurface?.disconnect?.(this._overviewMaskRestoreId);
            } catch {
                // Surface already gone.
            }
            this._overviewMaskRestoreId = 0;
            this._overviewSurface = null;
        }

        if (this._overviewContainerDestroyId) {
            try {
                this._overviewContainer.disconnect(this._overviewContainerDestroyId);
            } catch {
                // Preview already gone.
            }
            this._overviewContainerDestroyId = 0;
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
        this._overviewMask = null;
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
        this._clearOverviewMask();
        this._clearOverviewShadow();
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

        this._clearOverviewMask();
        this._clearOverviewShadow();

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
