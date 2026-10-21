/**
 * The overview half of a window's decoration: the shaped-texture mask that rounds the preview, the opacity
 * bypass that makes Mutter consult it, and the preview shadow clone. All three hang on the client's own
 * actors rather than on a preview card.
 */

import {
    Diagnostic,
    overviewMaskRefusalWarning,
    windowIdentityLabel,
} from './diagnosticInvariants.js';
import {ZERO_INSETS} from './frame.js';
import {journal} from '../platform/journal.js';
import {WindowClientType} from './mutterRules.generated.js';
import {isPaintableFrame} from '../effects/clipParams.js';
import {getWorkspaceCount} from '../platform/display.js';
import {
    countSurfaceActorsCoveringBox,
    getWindowActor,
    getWindowDisplayTitle,
    getWindowFrameRect,
    getOverviewPreviews,
    getWindowSurfaceContainer,
    getWindowClientType,
    isWindowOnAllWorkspaces,
} from '../platform/window.js';

/**
 * GNOME Shell's cap on an overview thumbnail's scale, from `WINDOW_PREVIEW_MAXIMUM_SCALE`
 * (js/ui/workspace.js). No preview is drawn larger than this fraction of the window's
 * logical size, which is what bounds the resolution the corner mask ever has to resolve.
 */
const OVERVIEW_PREVIEW_MAX_SCALE = 0.95;

/**
 * Hard ceiling on either side of the overview corner mask, in texels. The arc stops looking polygonal at
 * roughly 0.7 mask texels per screen pixel and is indistinguishable from a full mask at 1.0, so the ceiling
 * only bites past ~4K-wide displays.
 */
const OVERVIEW_MASK_MAX_DIMENSION = 2560;

export class OverviewDecoration {
    /**
     * @param [options.OverviewMask] - {buildRoundedMask, opaqueMask} texture builders
     * @param [options.OverviewShadow] - Clutter.Clone subclass carrying the preview shadow
     */
    constructor(win, options = {}) {
        this._win = win;
        this._OverviewMask = options.OverviewMask ?? null;
        this._OverviewShadowClass = options.OverviewShadow ?? null;
        // Told when a card rebuild settles on a mode; the desktop clip follows it. Set only by
        // WindowDecoration, which owns the clip (see `_refresh`).
        this._onModeChange = options.onModeChange ?? null;

        this._inOverview = false;
        this._stex = null;
        this._maskKey = null;
        this._bypassContainer = null;
        this._savedBypassOpacity = 255;
        this._sizeId = 0;
        this._workspaceId = 0;
        this._shadows = [];

        // The decoration-derived readings from the last apply(). A card rebuild re-reads the
        // window, but these cannot change without another apply(), which refreshes them.
        this._canMask = false;
        this._radius = 0;
        this._insets = null;
        this._erase = false;
        this._scale = 1;
        this._shadowSource = null;
        // The source the mounted clones were built from, so a replaced desktop shadow actor
        // re-mounts them instead of leaving them on a destroyed one.
        this._mountedShadowSource = null;
        this._forceOverviewCorners = false;
        // A readiness refusal is a deferral (nothing cached); a refusal after the readiness gates
        // passed is the "square in the overview" defect. The diagnostic makes that one line per
        // episode, re-armed by an install or by leaving the overview.
        this._maskRefusalDiagnostic = new Diagnostic(options.journal ?? journal);
    }

    get inOverview() {
        return this._inOverview;
    }

    get stateView() {
        return {
            inOverview: this._inOverview,
            hasMask: Boolean(this._stex),
            hasShadow: this._shadows.length > 0,
            hasBypass: Boolean(this._bypassContainer),
        };
    }

    /**
     * Whether the overview can round this window through the shaped-texture mask: a window whose corner or
     * outline is not drawn has no mask to build. XWayland keeps the window's shape in the same slot, and GJS
     * cannot put it back (`set_mask_texture` rejects null), so overwriting it would deform the window.
     */
    canApplyMask({drawClip, hasStyle}) {
        if (!drawClip || !hasStyle)
            return false;
        const clientType = getWindowClientType(this._win);
        // An unreadable client type is "unknown", not "not X11": folding it in would read as
        // "maskable" and overwrite an XWayland window's shared shape mask, which Mutter rewrites
        // from the shape and GJS cannot restore (`set_mask_texture(null)` is rejected). Only a
        // client type we actually read may take the mask slot.
        if (clientType === null || clientType === undefined)
            return false;
        return clientType !== WindowClientType.X11;
    }

    /** Switches the overview visuals on or off, from the readings this cannot take for itself. */
    setMode(inOverview, readings = {}) {
        this._inOverview = Boolean(inOverview);

        this._canMask = this.canApplyMask({
            drawClip: readings.drawClip ?? false,
            hasStyle: readings.hasStyle ?? false,
        });
        this._radius = readings.radius ?? 0;
        this._insets = readings.insets ?? null;
        this._erase = readings.erase ?? false;
        this._scale = readings.scale ?? 1;
        this._shadowSource = readings.shadow ?? null;
        this._forceOverviewCorners = Boolean(readings.forceOverviewCorners);

        return this._settleMode();
    }

    /**
     * Whether the mask can round the window's visible corners. It lives on one shaped texture - the main
     * surface's - while every surface of the window's tree hangs on the same container, so a second
     * surface actor over the container's box paints corners the mask cannot reach. The sibling textures
     * are unreachable from GJS, so the boxes are the reading.
     */
    _maskReachesCorners() {
        return countSurfaceActorsCoveringBox(getWindowSurfaceContainer(this._win)) < 2;
    }

    /**
     * Applies the overview visuals for the readings already stored and returns the outcome now in
     * force. Both the entry path (`setMode`) and a card rebuild (`_refresh`) settle here, so the
     * mode they hand back is always the one that actually installed - not the one that was merely
     * attempted.
     *
     */
    _settleMode() {
        if (!this._inOverview) {
            this._release();
            return 'square';
        }

        // Three ways a window can be shown: sharp from the mask, blurry from the legacy offscreen clip the
        // user forced, or square. The mask only rounds the surface it is set on, so forcing corners also
        // hands the clip a window whose box a second surface paints; with the setting off nothing here
        // reads that.
        const forcedToClip = this._forceOverviewCorners && !this._maskReachesCorners();
        const maskable = this._canMask && this._maskReady() && !forcedToClip;
        this._syncHooks();
        // A mask is only one of the ways to round the preview; whether it actually landed decides
        // the mode, so a builder that declined still lets the forced legacy clip take over.
        let installed = false;
        if (maskable)
            installed = this._applyMask();
        else
            this._clearMask();
        // The shadow does not depend on the clip either way: a window can carry a shadow without
        // corners (prefer-crisp-text on a fractional scale).
        this._applyShadow();
        if (installed)
            return 'mask';
        return this._forceOverviewCorners ? 'clip' : 'square';
    }

    drop() {
        this._inOverview = false;
        this._release();
    }

    _release() {
        this._maskRefusalDiagnostic.reset();
        this._clearMask();
        this._clearShadow();
        this._syncHooks();
    }

    /**
     * Connects, or drops, the preview-lifecycle hooks: a workspace move rebuilds the cards a shadow clone is
     * mounted under, and a client resize moves where the mask's content belongs, so both installs are
     * re-applied when the hook fires.
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
     * Reads the shaped texture's own buffer state, distinguishing "no buffer yet" (nothing to mask) from the
     * buffered case, which can take one. Nothing is cached: the buffer's arrival earns a fresh pass.
     */
    _textureBufferKey(stex) {
        const multi = stex?.get_texture?.() ?? null;
        if (!multi)
            return null;
        const width = multi.get_width?.() ?? 0;
        const height = multi.get_height?.() ?? 0;
        if (!(width > 0) || !(height > 0))
            return null;
        return `${width}x${height}`;
    }

    /**
     * Whether the shaped texture is ready to take a mask. Neither missing branch is a refusal - no buffer
     * yet, or no positive allocation, both mean "not this pass" with nothing cached - and `isPaintableFrame`
     * is the same authority the clip uses.
     */
    _maskReady() {
        const actor = getWindowActor(this._win);
        const stex = actor?.get_texture?.() ?? null;
        return this._textureBufferKey(stex) !== null && isPaintableFrame(actor);
    }

    /**
     * Rounds the window's shaped texture during the overview. Mutter samples the mask with the window
     * colour's own minification filter, so a downscaled thumbnail keeps hardware mipmapping, and it skips the
     * mask on its opaque fast path, which is what the container bypass forces.
     */
    _applyMask() {
        // The invariant: our rounded mask is only ever installed while the window is in the
        // overview. A reconcile that arrives after the overview ended retires instead of rounding.
        if (!this._inOverview)
            return false;
        // Not this pass: a bufferless texture or an unallocated actor is a deferral, not a
        // refusal. Nothing is cached and the buffer's or the allocation's arrival earns a fresh
        // reconcile, so this must not be read as the window being stuck square.
        if (!this._canMask || !this._maskReady()) {
            this._maskRefusalDiagnostic.check(null);
            return false;
        }

        // Every gate below has passed the readiness check: the window has a buffer and a
        // paint-able actor, so a refusal here leaves a preview that should have been rounded
        // square. Name the gate; the latch makes it one journal line per episode.
        const buildRoundedMask = this._OverviewMask?.buildRoundedMask;
        if (!buildRoundedMask)
            return this._refuseMask('no mask builder is available');

        const actor = getWindowActor(this._win);
        const stex = actor?.get_texture?.() ?? null;
        const multi = stex?.get_texture?.() ?? null;
        const context = multi?.get_plane?.(0)?.get_context?.() ?? null;
        if (!stex || !context)
            return this._refuseMask('the shaped texture or its context is unavailable');

        const actorWidth = actor?.width ?? 0;
        const actorHeight = actor?.height ?? 0;
        const textureWidth = multi.get_width?.() ?? 0;
        const textureHeight = multi.get_height?.() ?? 0;
        if (!(actorWidth > 0) || !(actorHeight > 0) || !(textureWidth > 0) || !(textureHeight > 0))
            return this._refuseMask('the actor or texture has no positive size');

        // Insets and radius are logical; the texture carries the client's buffer.
        const bufferScale = textureWidth / actorWidth;
        const insets = this._insets ?? ZERO_INSETS;
        const key = this._maskKeyFor(textureWidth, textureHeight, bufferScale);

        // Wearing exactly this mask on exactly this texture: unchanged, so the install is not spent
        // again. Identity belongs in the condition, the key describes only the mask's content. The
        // bypass is re-asserted - the only path an unchanged-key pass takes - since a mask Mutter
        // never consults is not an install.
        if (this._stex === stex && this._maskKey === key) {
            this._applyOpacityBypass();
            return true;
        }

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
            return this._refuseMask('the mask builder returned nothing');

        stex.set_mask_texture(mask);

        this._stex = stex;
        this._maskKey = key;
        // The mask landed: re-arm the diagnostic so a later refusal speaks as its own episode.
        this._maskRefusalDiagnostic.check(null);
        this._applyOpacityBypass();
        return true;
    }

    /**
     * The readings the installed mask was built from: the buffer it masked, the scale, and the decoration
     * values that shape its content. "Already wearing the mask" holds only while this key is unchanged,
     * because Mutter clears the slot itself when the texture's destination size moves - and a display-scale
     * move reaches this decoration through no signal at all.
     */
    _maskKeyFor(textureWidth, textureHeight, bufferScale) {
        const {left = 0, top = 0, right = 0, bottom = 0} = this._insets ?? {};
        return [textureWidth, textureHeight, bufferScale, this._scale, this._radius,
            this._erase, left, top, right, bottom].join(':');
    }

    /**
     * Drops the window's surface container one step below opaque, which is what makes Mutter consult the mask:
     * its opaque fast path requires 255, and the shaped texture's paint opacity is this container's times the
     * window actor's. Every clone paints through the same container, so one actor covers all of them.
     */
    _applyOpacityBypass() {
        // Resolved here rather than taken from the clip target: the clip resolver refuses a container
        // the clip cannot use (unallocated, off-origin geometry, non-integer alignment) while the
        // shaped texture still paints through it, so its answer is not this one.
        const container = getWindowSurfaceContainer(this._win);
        if (!container)
            return;
        if (container === this._bypassContainer)
            return;
        // A rebuilt surface container arrives with a fresh actor: restore the one already lowered,
        // if it is still alive, then lower this one. Keying on existence alone left the new actor at
        // 255, so Mutter's opaque fast path ignored the mask and the preview went square.
        if (this._bypassContainer) {
            try {
                this._bypassContainer.set_opacity(this._savedBypassOpacity);
            } catch {
                // Previous container already destroyed; nothing left to restore.
            }
        }
        try {
            this._savedBypassOpacity = container.get_opacity();
            container.set_opacity(Math.min(254, this._savedBypassOpacity));
            this._bypassContainer = container;
        } catch {
            // The actor went away mid-settle; the next pass retries, and the exit restores
            // nothing because nothing was lowered.
            this._bypassContainer = null;
        }
    }

    /**
     * Records a mask refusal that happened although the window was ready, and says so once per episode. With
     * `forceOverviewCorners` the legacy clip is an intended rounding path, so the refusal is not the defect
     * this watches for.
     */
    _refuseMask(reason) {
        // A leg the user asked for is an intended rounding path, so it is not a refusal: it
        // re-arms the episode like a pass that never refused.
        if (this._forceOverviewCorners) {
            this._maskRefusalDiagnostic.check(null);
            return false;
        }
        const label = windowIdentityLabel({title: getWindowDisplayTitle(this._win)});
        this._maskRefusalDiagnostic.check(overviewMaskRefusalWarning(reason, label));
        return false;
    }

    /**
     * Resolution factor for the overview corner mask. The mask is sampled through the window texture's own
     * coordinates, so it only has to resolve what the overview draws: a thumbnail at most
     * `OVERVIEW_PREVIEW_MAX_SCALE` of the logical size, on screen at the monitor scale - a full-buffer mask
     * would cost a byte per client pixel for detail no preview shows.
     */
    _overviewMaskScale(textureWidth, textureHeight, bufferScale, monitorScale) {
        const longest = Math.max(textureWidth, textureHeight);
        const previewScale = OVERVIEW_PREVIEW_MAX_SCALE * monitorScale / (bufferScale || 1);
        const scale = Math.min(previewScale, OVERVIEW_MASK_MAX_DIMENSION / longest);
        return Math.min(1, Math.max(scale, 0.05));
    }

    /**
     * Re-applies the overview visuals after the card or the window changes: both installs are retired and
     * settled again, which re-resolves the previews the shadow clones mount against and re-reads the mask's
     * key - the one path that re-reads it without a window signal. The caller is handed what actually installed.
     */
    _refresh() {
        if (!this._inOverview)
            return;
        this._clearMask();
        this._clearShadow();
        this._onModeChange?.(this._settleMode());
    }

    _clearMask() {
        if (this._bypassContainer) {
            try {
                this._bypassContainer.set_opacity(this._savedBypassOpacity);
            } catch {
                // Window actor already destroyed.
            }
            this._bypassContainer = null;
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
        this._maskKey = null;
    }

    /**
     * How many previews the window should have: one per workspace it is shown on. The walk behind
     * `getOverviewPreviews` visits every actor in the scene, so it must not run on a pass that has nothing to
     * learn.
     */
    _expectedPreviewCount() {
        if (!isWindowOnAllWorkspaces(this._win))
            return 1;
        return Math.max(1, getWorkspaceCount());
    }

    /**
     * Mounts the shadow clone under every preview of the window: one clone per preview, because a
     * `Clutter.Clone` has one parent and the desktop shadow is a sibling of the window actor. The walk
     * runs only while the mounted set looks short, so a complete set costs nothing and a later card is
     * topped up on the next reconcile.
     */
    _applyShadow() {
        const OverviewShadow = this._OverviewShadowClass;
        if (!this._shadowSource || !OverviewShadow)
            return;
        // The source is the desktop shadow actor, and a window actor rebuild replaces it while the
        // mounted clones still reference the destroyed one. Keyed on the count alone the pass
        // returned early and handed the new source to nothing; keying on the source re-mounts the
        // set so every preview keeps its shadow.
        if (this._mountedShadowSource !== this._shadowSource) {
            this._clearShadow();
            this._mountedShadowSource = this._shadowSource;
        }
        if (this._shadows.length >= this._expectedPreviewCount())
            return;

        // The frame rect is read without `throwOnError`: this runs from window `size-changed`/
        // `workspace-changed` handlers, where a throw would escape a Clutter signal handler
        // instead of simply leaving the shadow unbuilt this pass.
        const width = getWindowFrameRect(this._win)?.width ?? 0;
        if (!(width > 0))
            return;

        for (const preview of getOverviewPreviews(this._win)) {
            if (this._shadows.some(entry => entry.preview === preview))
                continue;
            const container = preview?.window_container ?? null;
            if (!container)
                continue;
            try {
                const shadow = new OverviewShadow(this._shadowSource, preview, container, width);
                const entry = {preview, shadow};
                this._shadows.push(entry);
                shadow.connect('destroy', () => {
                    // The preview owns the clone and destroys it before 'hidden'; drop the entry
                    // so teardown never calls into a disposed actor.
                    const index = this._shadows.indexOf(entry);
                    if (index >= 0)
                        this._shadows.splice(index, 1);
                });
            } catch {
                // A half-built preview: the next settle tops the missing clones up.
            }
        }
    }

    _clearShadow() {
        const shadows = this._shadows;
        this._shadows = [];
        this._mountedShadowSource = null;
        for (const {shadow} of shadows) {
            try {
                shadow.destroy();
            } catch {
                // Preview already destroyed.
            }
        }
    }
}
