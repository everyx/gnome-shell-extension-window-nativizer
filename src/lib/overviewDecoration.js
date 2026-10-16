/**
 * OverviewDecoration: the overview half of a window's decoration.
 *
 * While the shell overview is shown, a window's preview is decorated differently from its
 * desktop actor. Three things happen, and this owns the lifecycle of all three:
 *
 * - an A_8 mask on the window's shaped texture supplies the rounded corners, so the thumbnail
 *   rides Mutter's own mipmapped pipeline instead of an offscreen FBO;
 * - the window's **surface container** drops one step below opaque, because Mutter consults the
 *   mask only on its blended path (`use_opaque_region = opaque_region && paint_opacity == 255`),
 *   and every preview clone paints the window actor through that container;
 * - a clone of the desktop shadow is mounted under each preview.
 *
 * The mask and the bypass hang on the client's own actor tree rather than on a preview card: one
 * shaped texture and one surface container are what every clone of the window paints, so one
 * install covers a window that has several previews (a window shown on all workspaces has one per
 * workspace) and one that gains a card after this pass. The card itself is only needed by the
 * shadow, because a `Clutter.Clone` has one parent and the desktop shadow - a sibling of the
 * window actor in the window group - is not part of what a preview clones.
 *
 * The mask's content is derived from readings that can move without another `apply()` (the client's
 * buffer, its scale, the resolved insets), and Mutter clears the slot underneath us whenever the
 * shaped texture's destination size changes, so what is installed is keyed on those readings and
 * re-run when the key moves.
 */

import {ZERO_INSETS} from './frame.js';
import {
    evaluateInvariant,
    freshInvariantState,
    overviewMaskRefusalWarning,
    windowIdentityLabel,
} from './diagnosticInvariants.js';
import {WindowClientType} from './mutterRules.generated.js';
import {isPaintableFrame} from '../effects/clipParams.js';
import {getWorkspaceCount} from '../platform/display.js';
import {
    getWindowActor,
    getWindowDisplayTitle,
    getWindowFrameRect,
    getOverviewPreviews,
    getWindowSurfaceContainer,
    getWindowClientType,
    isWindowOnAllWorkspaces,
} from '../platform/window.js';

/** The journal sink for the mask-refusal warning; injected by a spec to observe the line. */
function defaultWarn(message) {
    console.warn(message);
}

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
     * @param {object} [options.OverviewMask] - {buildRoundedMask, opaqueMask} texture builders
     * @param {Function} [options.OverviewShadow] - Clutter.Clone subclass carrying the preview shadow
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
        this._forceOverviewCorners = false;
        // A readiness refusal is a deferral (nothing cached); a refusal after the readiness gates
        // passed is the "square in the overview" defect. The latch makes that one line per
        // episode, re-armed by an install or by leaving the overview.
        this._warn = options.warn ?? defaultWarn;
        this._maskRefusalLatch = freshInvariantState();
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
            hasShadow: this._shadows.length > 0,
            hasBypass: Boolean(this._bypassContainer),
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
        const clientType = getWindowClientType(this._win);
        // An unreadable client type is "unknown", not "not X11": folding it in would read as
        // "maskable" and overwrite an XWayland window's shared shape mask, which Mutter rewrites
        // from the shape and GJS cannot restore (`set_mask_texture(null)` is rejected). Only a
        // client type we actually read may take the mask slot.
        if (clientType === null || clientType === undefined)
            return false;
        return clientType !== WindowClientType.X11;
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
     * Applies the overview visuals for the readings already stored and returns the outcome now in
     * force. Both the entry path (`setMode`) and a card rebuild (`_refresh`) settle here, so the
     * mode they hand back is always the one that actually installed - not the one that was merely
     * attempted.
     *
     * @returns {'mask'|'clip'|'square'}
     */
    _settleMode() {
        if (!this._inOverview) {
            this._release();
            return 'square';
        }

        // Three ways a window can be shown in the overview. Rounded and sharp comes from the
        // shaped-texture mask, and every Wayland window takes it; rounded and blurry is the
        // legacy offscreen clip, kept when the user forces corners; neither leaves the thumbnail
        // square, and as sharp as an undecorated window. A mask can only round the surface it is
        // set on, so a window whose visible corners another surface of the same window paints
        // keeps square previews; that admitted square, like XWayland's, is tracked upstream
        // (issue #27) and is what `force-overview-corners` exists for.
        const maskable = this._canMask && this._maskReady();
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

    /** Drops every overview visual and hook: the overview ended, or the decoration is going away. */
    drop() {
        this._inOverview = false;
        this._release();
    }

    _release() {
        this._maskRefusalLatch = freshInvariantState();
        this._clearMask();
        this._clearShadow();
        this._syncHooks();
    }

    /**
     * Connects, or drops, the preview-lifecycle hooks.
     *
     * The overview rebuilds a window's preview when the window moves to another workspace, and a
     * client can resize itself while the overview is open. A rebuild replaces the cards a shadow
     * clone is mounted under, and a resize can move where the mask's content belongs, so both are
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
     * Reads the shaped texture's own buffer state. A window whose preview is built before the
     * client's first buffer arrives has no shape to mask, so this distinguishes "no buffer yet"
     * from the buffered case that can take one. Nothing is cached: the buffer's arrival earns a
     * fresh pass.
     *
     * @param {object|null} stex - MetaShapedTexture, or a stand-in in a spec
     * @returns {string|null} A key for the buffer the texture holds, or null when it holds none yet
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
     * Whether the shaped texture is ready to take a mask this pass. Neither missing branch is a
     * refusal: a texture with no buffer yet, and a window actor without a positive allocation,
     * both mean "not this pass", with nothing cached, so the buffer's or the allocation's
     * arrival earns a fresh reconcile. `isPaintableFrame` is the same authority the clip uses.
     *
     * @returns {boolean}
     */
    _maskReady() {
        const actor = getWindowActor(this._win);
        const stex = actor?.get_texture?.() ?? null;
        return this._textureBufferKey(stex) !== null && isPaintableFrame(actor);
    }

    /**
     * Rounds the window's shaped texture during the overview.
     *
     * Mutter samples the mask with the same minification filter as the window colour, so a
     * downscaled thumbnail keeps hardware mipmapping. Mutter skips the mask on its opaque fast
     * path, so the window's surface container is pulled one step below 255 to force the blended
     * path (`_applyOpacityBypass`); the 1/255 alpha that costs is imperceptible.
     *
     * @returns {boolean} Whether the window wears the mask after this call: true when it was
     *   already installed or was installed now, false when a missing texture, context, size or
     *   mask left it square
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
            this._maskRefusalLatch = freshInvariantState();
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

        // Wearing exactly this mask already, on exactly this texture: the outcome is unchanged and
        // `set_mask_texture` is not spent again. The texture's identity belongs in the condition
        // because that is what the invariant means - this texture wears the mask - and the key
        // describes only the mask's content: a swap that kept every reading equal is invisible to
        // it, and Mutter does destroy and rebuild surface actors (`meta_wayland_actor_surface_
        // reset_actor()` clears one and constructs the next).
        //
        // The bypass is re-asserted on this path too. It is idempotent, and this is the only path a
        // pass with an unchanged key takes: a pass that could not lower the container (the actor
        // was momentarily unreadable) would otherwise never retry, leaving a mask installed that
        // Mutter never consults.
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
        // The mask landed: re-arm the latch so a later refusal speaks as its own episode.
        this._maskRefusalLatch = freshInvariantState();
        this._applyOpacityBypass();
        return true;
    }

    /**
     * The readings the installed mask was built from: the buffer that was masked, the scale its
     * texels map through, and the decoration values that shape the mask's content.
     *
     * "Already wearing the mask" is only true while this key is unchanged. Mutter clears the slot
     * itself whenever the shaped texture's destination size moves (`update_size()` drops the mask
     * on a size change, and the buffer-scale and viewport setters invalidate that size), and a
     * size change that is not a window resize — a display-scale move, a fractional-scale
     * renegotiation — reaches this decoration through no signal at all. Comparing the key turns
     * the install into a reading of this pass instead of a memory of an earlier one.
     *
     * @param {number} textureWidth - Window buffer width, texture px
     * @param {number} textureHeight - Window buffer height, texture px
     * @param {number} bufferScale - Buffer texels per logical pixel
     * @returns {string}
     */
    _maskKeyFor(textureWidth, textureHeight, bufferScale) {
        const {left = 0, top = 0, right = 0, bottom = 0} = this._insets ?? {};
        return [textureWidth, textureHeight, bufferScale, this._scale, this._radius,
            this._erase, left, top, right, bottom].join(':');
    }

    /**
     * Drops the window's surface container one step below opaque, which is what makes Mutter
     * consult the mask at all: its opaque fast path is `opaque_region && paint_opacity == 255`,
     * and the shaped texture's paint opacity is this container's, times the window actor's - which
     * the preview clone replaces with the clone's own opacity, one level above this actor.
     *
     * The bypass belongs on the client's container rather than on a preview card. Every clone of
     * the window paints through the same container, so one actor covers all of them: the previews
     * of a window shown on all workspaces, and any card the overview builds after this pass. A
     * card's own opacity is also what the shell may animate, so it was never ours to hold.
     */
    _applyOpacityBypass() {
        if (this._bypassContainer)
            return;
        const container = getWindowSurfaceContainer(this._win);
        if (!container)
            return;
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
     * Records a mask refusal that happened although the window was ready, and says so once per
     * episode. With `forceOverviewCorners` the legacy clip is an intended rounding path, not a
     * square preview, so the refusal is not the defect this watches.
     *
     * @param {string} reason - Which gate refused
     * @returns {false} Always false, so call sites stay `return this._refuseMask(...)`
     */
    _refuseMask(reason) {
        if (this._forceOverviewCorners) {
            this._maskRefusalLatch = freshInvariantState();
            return false;
        }
        const label = windowIdentityLabel({title: getWindowDisplayTitle(this._win)});
        const {state, message} = evaluateInvariant(this._maskRefusalLatch,
            overviewMaskRefusalWarning(reason, label));
        this._maskRefusalLatch = state;
        if (message)
            this._warn(message);
        return false;
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

    /**
     * Re-applies the overview visuals after the card, or the window, changes.
     *
     * Both installs are retired first and settled again: that re-resolves the previews the shadow
     * clones are mounted against, and re-reads the readings the mask is keyed on - a card rebuild
     * can arrive together with a buffer change, and this is the one path that re-reads them without
     * a window signal. The mode can differ from the entry's - a mask that declined can land now, or
     * one that landed can decline - so the caller is handed what actually installed and keeps the
     * desktop clip in step.
     */
    _refresh() {
        if (!this._inOverview)
            return;
        this._clearMask();
        this._clearShadow();
        this._onModeChange?.(this._settleMode());
    }

    /** Retires the overview mask and restores the surface container's opacity. */
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
     * How many previews the window should have: one per workspace it is shown on.
     *
     * This is the size of the mounted set that ends a resolution, and it is read from two facts
     * rather than from the stage: the stage walk behind `getOverviewPreviews` visits every actor
     * in the scene (2189 with five windows open on this machine, 3.6ms a call), so it must not run
     * on a pass that has nothing to learn.
     *
     * @returns {number}
     */
    _expectedPreviewCount() {
        if (!isWindowOnAllWorkspaces(this._win))
            return 1;
        return Math.max(1, getWorkspaceCount());
    }

    /**
     * Mounts the shadow clone under every preview of the window.
     *
     * One clone per preview, because a `Clutter.Clone` has one parent: the desktop shadow is a
     * sibling of the window actor in the window group, so no preview's clone of the window actor
     * carries it, and each preview needs its own.
     *
     * The previews are resolved by walking the stage, which is why the walk only runs while the
     * mounted set looks short against `_expectedPreviewCount()`: a complete set costs nothing, and
     * a card the overview builds after this pass - a workspace is added, the entry animation is
     * still constructing the views - is topped up on the next reconcile. A clone that goes away
     * with its card lowers the count and re-arms the walk the same way.
     */
    _applyShadow() {
        const OverviewShadow = this._OverviewShadowClass;
        if (!this._shadowSource || !OverviewShadow)
            return;
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

    /** Removes every overview shadow clone. */
    _clearShadow() {
        const shadows = this._shadows;
        this._shadows = [];
        for (const {shadow} of shadows) {
            try {
                shadow.destroy();
            } catch {
                // Preview already destroyed.
            }
        }
    }
}
