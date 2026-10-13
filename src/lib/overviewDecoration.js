/**
 * OverviewDecoration: the overview half of a window's decoration.
 *
 * While the shell overview is shown, a window's preview is decorated differently from its
 * desktop actor: an A_8 mask on the shaped texture supplies the rounded corners so the
 * thumbnail rides Mutter's own mipmapped pipeline instead of an offscreen FBO, the preview
 * container drops one step below opaque so Mutter consults that mask, and a clone of the
 * desktop shadow is mounted under the preview. This owns the lifecycle of all three.
 *
 * The overview rebuilds a window's card - and with it the card's container - whenever the
 * window moves workspace or resizes itself, so the mask and the clone have to be moved onto
 * the card that replaced the old one. That is also why the card, its container and the
 * client's buffer are read here rather than handed in: only the values that cannot change
 * without another `apply()` are part of the readings `WindowDecoration` passes.
 */

import {ZERO_INSETS} from './frame.js';
import {WindowClientType} from './mutterRules.generated.js';
import {getWindowActor, getWindowFrameRect, getOverviewPreview, getWindowClientType} from '../platform/window.js';

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

export class OverviewDecoration {
    /**
     * @param {Meta.Window} win
     * @param {object} [options]
     * @param {object} [options.OverviewMask] - {buildRoundedMask, maskWouldChangeScreenshot, opaqueMask}
     * @param {Function} [options.OverviewShadow] - Clutter.Clone subclass carrying the preview shadow
     */
    constructor(win, options = {}) {
        this._win = win;
        this._OverviewMask = options.OverviewMask ?? null;
        this._OverviewShadowClass = options.OverviewShadow ?? null;

        this._inOverview = false;
        this._stex = null;
        this._probe = null;
        this._container = null;
        this._containerDestroyId = 0;
        this._savedOpacity = 255;
        this._sizeId = 0;
        this._workspaceId = 0;
        this._shadow = null;

        // The decoration-derived readings from the last apply(). A card rebuild re-reads the
        // window, but these cannot change without another apply(), which refreshes them.
        this._canMask = false;
        this._radius = 0;
        this._insets = null;
        this._erase = false;
        this._scale = 1;
        this._shadowSource = null;
    }

    /** @returns {boolean} Whether the overview visuals are currently applied */
    get inOverview() {
        return this._inOverview;
    }

    /** @returns {object} A fresh snapshot of the overview decoration's state */
    get stateView() {
        return {
            inOverview: this._inOverview,
            hasMask: Boolean(this._stex),
            hasShadow: Boolean(this._shadow),
            hasContainer: Boolean(this._container),
            isProbed: this._probe !== null,
        };
    }

    /**
     * Whether the overview can round this window through the shaped-texture mask. A window
     * whose corner or outline is not drawn has no mask to build. An XWayland window keeps the
     * window's shape in the same mask slot and Mutter rewrites it from that shape, so
     * overwriting it would deform the window once the overview ends — and GJS cannot put it
     * back (`set_mask_texture` rejects null).
     *
     * @param {object} params
     * @param {boolean} params.drawClip - Whether the window's corner or outline is drawn
     * @param {boolean} params.hasStyle - Whether a decoration style is resolved
     * @returns {boolean}
     */
    canApplyMask({drawClip, hasStyle}) {
        if (!drawClip || !hasStyle)
            return false;
        return getWindowClientType(this._win) !== WindowClientType.X11;
    }

    /**
     * Switches the overview visuals on or off.
     *
     * @param {boolean} inOverview
     * @param {object} readings - The decoration's current values this cannot read itself
     * @param {number} [readings.radius] - Resolved corner radius, logical px
     * @param {import('./frame.js').Insets|null} [readings.insets] - Resolved clip insets
     * @param {boolean} [readings.erase] - Whether the clip shader erases the ring
     * @param {number} [readings.scale] - Monitor scale for the window
     * @param {boolean} [readings.drawClip] - Whether the window's corner or outline is drawn
     * @param {boolean} [readings.hasStyle] - Whether a decoration style is resolved
     * @param {boolean} [readings.forceOverviewCorners] - Whether the user forces the legacy clip
     * @param {Clutter.Actor|null} [readings.shadow] - The desktop shadow clone's source
     * @returns {'mask'|'clip'|'square'} The overview outcome chosen for this pass
     */
    setMode(inOverview, readings = {}) {
        const wanted = Boolean(inOverview);
        // The probe's answer is cached per shaped texture, not per entry: once this window wears
        // our mask the probe's own early-out can never answer anything but NULL again, so a fresh
        // entry must reuse the first answer rather than ask a texture our mask has already moved
        // (see `_maskWouldChangeDesktop`).
        this._inOverview = wanted;

        this._canMask = this.canApplyMask({
            drawClip: readings.drawClip ?? false,
            hasStyle: readings.hasStyle ?? false,
        });
        this._radius = readings.radius ?? 0;
        this._insets = readings.insets ?? null;
        this._erase = readings.erase ?? false;
        this._scale = readings.scale ?? 1;
        this._shadowSource = readings.shadow ?? null;

        if (!this._inOverview) {
            this._release();
            return 'square';
        }

        // Three ways a window can be shown in the overview. Rounded and sharp comes from the
        // shaped-texture mask, and is only taken where it costs the desktop nothing; rounded and
        // blurry is the legacy offscreen clip, kept when the user forces corners; neither leaves
        // the thumbnail square, and as sharp as an undecorated window.
        const maskable = this._canMask && !this._maskWouldChangeDesktop();
        this._syncHooks();
        if (maskable)
            this._applyMask();
        else
            this._clearMask();
        // The shadow does not depend on the clip either way: a window can carry a shadow without
        // corners (prefer-crisp-text on a fractional scale).
        this._applyShadow();
        if (maskable)
            return 'mask';
        return readings.forceOverviewCorners ? 'clip' : 'square';
    }

    /** Drops every overview visual and hook: the overview ended, or the decoration is going away. */
    drop() {
        this._inOverview = false;
        // A new shaped texture for the same window starts a new probe history; the decoration
        // keeps no answer across its own teardown.
        this._probe = null;
        this._release();
    }

    _release() {
        this._clearMask();
        this._clearShadow();
        this._syncHooks();
    }

    /**
     * Connects, or drops, the preview-lifecycle hooks.
     *
     * The overview rebuilds a window's preview - and with it the card and its container - when
     * the window moves to another workspace, and a client can resize itself while the overview
     * is open. Either leaves the mask and the shadow clone attached to a card that no longer
     * exists, so both are re-applied when the hook fires.
     */
    _syncHooks() {
        if (this._inOverview) {
            if (!this._sizeId)
                this._sizeId = this._win.connect('size-changed', () => this._refresh());
            if (!this._workspaceId)
                this._workspaceId = this._win.connect('workspace-changed', () => this._refresh());
            return;
        }

        if (this._sizeId) {
            try {
                this._win.disconnect(this._sizeId);
            } catch {
                // Window already gone.
            }
            this._sizeId = 0;
        }

        if (this._workspaceId) {
            try {
                this._win.disconnect(this._workspaceId);
            } catch {
                // Window already gone.
            }
            this._workspaceId = 0;
        }
    }

    /**
     * Probes whether masking this window would move a path the desktop can see, so the overview
     * can leave that window alone instead. See `overviewMask.maskWouldChangeScreenshot`.
     *
     * A definitive answer is cached on the shaped texture's identity and never invalidated by a
     * mode change: the answer must come from before our mask ever touched the slot, because
     * afterwards the probe's own `should_get_via_offscreen()` early-out makes it answer NULL
     * deterministically. "Cannot tell" (`null`: the member is missing, or the readback threw) is
     * deliberately *not* cached - one transient failure must not lock a window square for the rest
     * of the session. The cache is dropped with the decoration (`drop()`); a replaced shaped
     * texture is a new key.
     *
     * @returns {boolean}
     */
    _maskWouldChangeDesktop() {
        const stex = getWindowActor(this._win)?.get_texture?.() ?? null;
        if (this._probe && this._probe.stex === stex)
            return this._probe.wouldChange;

        const probe = this._OverviewMask?.maskWouldChangeScreenshot;
        const answer = probe ? probe(stex) : null;
        if (answer === true || answer === false) {
            this._probe = {stex, wouldChange: answer};
            return answer;
        }

        // Cannot tell. Keep this pass safe (square) but leave the cache empty so a later reconcile
        // can ask a texture that has settled. The window is only square until the next entry.
        return true;
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
    _applyMask() {
        // The invariant: our rounded mask is only ever installed while the window is in the
        // overview. A reconcile that arrives after the overview ended retires instead of rounding.
        if (!this._inOverview)
            return;
        if (this._stex || !this._canMask || this._maskWouldChangeDesktop())
            return;

        const buildRoundedMask = this._OverviewMask?.buildRoundedMask;
        if (!buildRoundedMask)
            return;

        const actor = getWindowActor(this._win);
        const stex = actor?.get_texture?.() ?? null;
        const multi = stex?.get_texture?.() ?? null;
        const context = multi?.get_plane?.(0)?.get_context?.() ?? null;
        const container = getOverviewPreview(this._win)?.container ?? null;
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
        const insets = this._insets ?? ZERO_INSETS;

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
            radius: this._radius * bufferScale * maskScale,
            erase: this._erase,
        });
        if (!mask)
            return;

        stex.set_mask_texture(mask);

        this._stex = stex;
        this._container = container;
        this._containerDestroyId = container.connect('destroy', () => {
            // The preview can be torn down before the overview 'hidden' signal; drop the
            // reference so the teardown never touches a disposed actor.
            this._container = null;
            this._containerDestroyId = 0;
        });
        this._savedOpacity = container.get_opacity();
        container.set_opacity(Math.min(254, this._savedOpacity));
    }

    /**
     * Resolution factor for the overview corner mask.
     *
     * The mask is sampled through the window texture's own coordinates, so it only has to
     * resolve what the overview actually draws: a thumbnail never larger than
     * `OVERVIEW_PREVIEW_MAX_SCALE` of the window's logical size, on screen at the monitor
     * scale. In buffer texels that is `OVERVIEW_PREVIEW_MAX_SCALE * monitorScale / bufferScale`,
     * so a hidpi-buffer client on a low-dpi monitor gets downsampled, and a 1x client on a
     * hidpi monitor is capped at buffer resolution. A full-buffer mask would instead cost
     * a byte per client pixel — tens of megabytes for a 4K window — for detail no preview shows.
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
    _refresh() {
        if (!this._inOverview)
            return;
        // The card, or the client's buffer, changed, so the old geometry is retired and a fresh
        // mask built. The safety answer is not re-asked: `_maskWouldChangeDesktop` already
        // cached it for this shaped texture, and a re-probe now would only read our own mask.
        this._clearMask();
        if (this._canMask && !this._maskWouldChangeDesktop())
            this._applyMask();
        this._clearShadow();
        this._applyShadow();
    }

    /** Retires the overview mask and restores the preview container opacity. */
    _clearMask() {
        if (this._containerDestroyId) {
            try {
                this._container.disconnect(this._containerDestroyId);
            } catch {
                // Preview already gone.
            }
            this._containerDestroyId = 0;
        }

        if (this._container) {
            try {
                this._container.set_opacity(this._savedOpacity);
            } catch {
                // Preview already destroyed.
            }
            this._container = null;
        }

        if (this._stex) {
            const opaqueMask = this._OverviewMask?.opaqueMask;
            const context = this._stex.get_texture?.()?.get_plane?.(0)?.get_context?.() ?? null;
            if (opaqueMask && context) {
                try {
                    this._stex.set_mask_texture(opaqueMask(context));
                } catch {
                    // Shaped texture already gone.
                }
            }
            this._stex = null;
        }
    }

    /** Adds the shadow clone under the overview preview. */
    _applyShadow() {
        const OverviewShadow = this._OverviewShadowClass;
        if (this._shadow || !this._shadowSource || !OverviewShadow)
            return;

        const preview = getOverviewPreview(this._win);
        if (!preview)
            return;
        const {preview: previewActor, container} = preview;

        const width = getWindowFrameRect(this._win, {throwOnError: true})?.width ?? 0;
        if (!(width > 0))
            return;

        try {
            const shadow = new OverviewShadow(this._shadowSource, previewActor, container, width);
            shadow.connect('destroy', () => {
                // The preview owns the clone and destroys it before 'hidden'; null the
                // reference so teardown never calls into a disposed actor.
                if (this._shadow === shadow)
                    this._shadow = null;
            });
            this._shadow = shadow;
        } catch {
            this._shadow = null;
        }
    }

    /** Removes the overview shadow clone. */
    _clearShadow() {
        if (!this._shadow)
            return;
        try {
            this._shadow.destroy();
        } catch {
            // Preview already destroyed.
        }
        this._shadow = null;
    }
}
