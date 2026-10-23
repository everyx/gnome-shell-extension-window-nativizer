/** Mask, opacity bypass and shadow clone hang on the client's own actors, not on a preview card. */

/** What the desktop reads before the first setMode: the same defaults setMode normalises to. */
const NO_READINGS = Object.freeze({
    radius: 0, insets: null, erase: false, scale: 1,
    shadow: null, forceOverviewCorners: false,
});

import {
    Diagnostic,
    overviewMaskRefusalWarning,
    windowIdentityLabel,
} from './diagnosticInvariants.js';
import {ZERO_INSETS} from './frame.js';
import {journal} from '../platform/journal.js';
import {Subscriptions} from './subscriptions.js';
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

/** Thumbnails never scale past this fraction, which bounds the resolution the mask needs. */
const OVERVIEW_PREVIEW_MAX_SCALE = 0.95;

/** At 0.7 texels per screen pixel the arc is smooth, so this ceiling only bites past ~4K wide. */
const OVERVIEW_MASK_MAX_DIMENSION = 2560;

export class OverviewDecoration {
    /** @param options.OverviewShadow - a Clutter.Clone subclass, carrying one parent only. */
    constructor(win, options = {}) {
        this._win = win;
        this._OverviewMask = options.OverviewMask ?? null;
        this._OverviewShadowClass = options.OverviewShadow ?? null;
        // Only WindowDecoration sets this: it owns the clip that follows the mode a rebuild settles.
        this._onModeChange = options.onModeChange ?? null;

        this._inOverview = false;
        this._destroyed = false;
        this._stex = null;
        this._maskKey = null;
        this._bypassContainer = null;
        this._savedBypassOpacity = 255;
        this._hooks = new Subscriptions();
        // Both hooks or neither: a connect that throws in between must not read as installed.
        this._hooksInstalled = false;
        this._shadows = [];

        // Taken from the last apply(), so a card rebuild can re-read them; nothing else can change them.
        this._canMask = false;
        // What the last setMode was told, kept as one record: every reader below takes it whole.
        this._readings = NO_READINGS;
        // The source the mounted clones came from, so a replaced desktop shadow actor re-mounts them.
        this._mountedShadowSource = null;
        // Past readiness, a refusal is the square-overview defect, latched to one line per episode.
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

    /** XWayland keeps its shape in the mask slot and GJS cannot restore it, so it gets no mask. */
    canApplyMask({drawClip, hasStyle}) {
        if (!drawClip || !hasStyle)
            return false;
        const clientType = getWindowClientType(this._win);
        // Unreadable means unknown, not "not X11": folding it in would overwrite an unrestorable shape.
        if (clientType === null || clientType === undefined)
            return false;
        return clientType !== WindowClientType.X11;
    }

    setMode(inOverview, readings = {}) {
        this._inOverview = Boolean(inOverview) && !this._destroyed;

        this._canMask = this.canApplyMask({
            drawClip: readings.drawClip ?? false,
            hasStyle: readings.hasStyle ?? false,
        });
        this._readings = {
            radius: readings.radius ?? 0,
            insets: readings.insets ?? null,
            erase: readings.erase ?? false,
            scale: readings.scale ?? 1,
            shadow: readings.shadow ?? null,
            forceOverviewCorners: Boolean(readings.forceOverviewCorners),
        };

        return this._settleMode();
    }

    /** A second surface over the container's box paints corners the one-surface mask cannot reach. */
    _maskReachesCorners() {
        return countSurfaceActorsCoveringBox(getWindowSurfaceContainer(this._win)) < 2;
    }

    /** Both setMode and _refresh settle here, so the mode returned is the one that installed. */
    _settleMode() {
        if (this._destroyed || !this._inOverview) {
            this._release();
            return 'square';
        }

        // Mask, forced clip or square: forcing also needs the mask to reach every painted corner.
        const forcedToClip = this._readings.forceOverviewCorners && !this._maskReachesCorners();
        const maskable = this._canMask && this._maskReady() && !forcedToClip;
        this._syncHooks();
        let installed = false;
        if (maskable)
            installed = this._applyMask();
        else
            this._clearMask();
        // A shadow does not need corners: prefer-crisp-text on a fractional scale has one without them.
        this._applyShadow();
        if (installed)
            return 'mask';
        return this._readings.forceOverviewCorners ? 'clip' : 'square';
    }

    /** Re-entrant release; destroy() is terminal. */
    drop() {
        this._inOverview = false;
        this._release();
    }

    destroy() {
        this._destroyed = true;
        this.drop();
    }

    _release() {
        this._maskRefusalDiagnostic.reset();
        this._clearMask();
        this._clearShadow();
        this._syncHooks();
    }

    /**
     * A workspace move rebuilds the clone's card, a resize moves the mask: both re-install. They are
     * one unit, so the retry starts from an empty pair - a connect that failed in between must not
     * leave the other one looking like a complete install for the rest of the episode.
     */
    _syncHooks() {
        if (!this._inOverview) {
            this._hooks.disconnectAll();
            this._hooksInstalled = false;
            return;
        }
        if (this._hooksInstalled)
            return;
        this._hooks.disconnectAll();
        this._hooks.connect(this._win, 'size-changed', () => this._refresh());
        this._hooks.connect(this._win, 'workspace-changed', () => this._refresh());
        this._hooksInstalled = true;
    }

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

    /** A missing buffer or allocation is a deferral, not a refusal; the clip checks the same way. */
    _maskReady() {
        const actor = getWindowActor(this._win);
        const stex = actor?.get_texture?.() ?? null;
        return this._textureBufferKey(stex) !== null && isPaintableFrame(actor);
    }

    /** Sampled with the texture's minification filter, so a downscaled thumbnail keeps mipmapping. */
    _applyMask() {
        // The invariant: a rounded mask lives only in the overview, so a late reconcile retires instead.
        if (!this._inOverview)
            return false;
        // Deferral, not refusal: nothing is cached, so this must not read as the window being stuck square.
        if (!this._canMask || !this._maskReady()) {
            this._maskRefusalDiagnostic.check(null);
            return false;
        }

        // Past readiness a refusal leaves the preview square, so name the gate; the latch caps it at one.
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
        const insets = this._readings.insets ?? ZERO_INSETS;
        const key = this._maskKeyFor(textureWidth, textureHeight, bufferScale);

        // Same mask, same texture: skip the rebuild but re-assert the bypass, or Mutter skips the mask.
        if (this._stex === stex && this._maskKey === key) {
            this._applyOpacityBypass();
            return true;
        }

        const maskScale = this._overviewMaskScale(textureWidth, textureHeight, bufferScale, this._readings.scale || 1);
        const mask = buildRoundedMask(context, {
            width: textureWidth * maskScale,
            height: textureHeight * maskScale,
            frameX: insets.left * bufferScale * maskScale,
            frameY: insets.top * bufferScale * maskScale,
            frameW: (actorWidth - insets.left - insets.right) * bufferScale * maskScale,
            frameH: (actorHeight - insets.top - insets.bottom) * bufferScale * maskScale,
            radius: this._readings.radius * bufferScale * maskScale,
            erase: this._readings.erase,
        });
        if (!mask)
            return this._refuseMask('the mask builder returned nothing');

        stex.set_mask_texture(mask);

        this._stex = stex;
        this._maskKey = key;
        this._maskRefusalDiagnostic.check(null);
        this._applyOpacityBypass();
        return true;
    }

    /** Mutter clears the mask slot on a destination-size move that reaches us through no signal. */
    _maskKeyFor(textureWidth, textureHeight, bufferScale) {
        const {left = 0, top = 0, right = 0, bottom = 0} = this._readings.insets ?? {};
        return [textureWidth, textureHeight, bufferScale, this._readings.scale, this._readings.radius,
            this._readings.erase, left, top, right, bottom].join(':');
    }

    /** The opaque fast path needs 255; the texture's opacity is this container's times the actor's. */
    _applyOpacityBypass() {
        // Not the clip's container: its resolver refuses ones the shaped texture still paints through.
        const container = getWindowSurfaceContainer(this._win);
        if (!container)
            return;
        if (container === this._bypassContainer)
            return;
        // Restore the old actor first: a rebuilt container at 255 makes Mutter's fast path skip the mask.
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
            // Gone mid-settle: the next pass retries, and nothing was lowered, so the exit restores nothing.
            this._bypassContainer = null;
        }
    }

    /** With forced corners the clip is intended, so a refusal there is not the defect watched for. */
    _refuseMask(reason) {
        // A leg the user asked for is no refusal: it re-arms the episode like a pass that never refused.
        if (this._readings.forceOverviewCorners) {
            this._maskRefusalDiagnostic.check(null);
            return false;
        }
        const label = windowIdentityLabel({title: getWindowDisplayTitle(this._win)});
        this._maskRefusalDiagnostic.check(overviewMaskRefusalWarning(reason, label));
        return false;
    }

    /** Sampled in texture coordinates, so it need only resolve what the overview draws on screen. */
    _overviewMaskScale(textureWidth, textureHeight, bufferScale, monitorScale) {
        const longest = Math.max(textureWidth, textureHeight);
        const previewScale = OVERVIEW_PREVIEW_MAX_SCALE * monitorScale / (bufferScale || 1);
        const scale = Math.min(previewScale, OVERVIEW_MASK_MAX_DIMENSION / longest);
        return Math.min(1, Math.max(scale, 0.05));
    }

    /** Re-resolves the previews and re-reads the mask key: the one path no window signal triggers. */
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

    /** One per workspace shown on; the walk it gates visits every scene actor, so spare it. */
    _expectedPreviewCount() {
        if (!isWindowOnAllWorkspaces(this._win))
            return 1;
        return Math.max(1, getWorkspaceCount());
    }

    /** One per preview: a Clutter.Clone has one parent, and the shadow sits beside the window actor. */
    _applyShadow() {
        const OverviewShadow = this._OverviewShadowClass;
        if (!this._readings.shadow || !OverviewShadow)
            return;
        // Keyed on the source: a rebuild replaces it, so a count-only check left clones on the dead actor.
        if (this._mountedShadowSource !== this._readings.shadow) {
            this._clearShadow();
            this._mountedShadowSource = this._readings.shadow;
        }
        if (this._shadows.length >= this._expectedPreviewCount())
            return;

        // Read without throwOnError: a throw would escape a Clutter signal handler, not skip this pass.
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
                const shadow = new OverviewShadow(this._readings.shadow, preview, container, width);
                const entry = {preview, shadow};
                this._shadows.push(entry);
                shadow.connect('destroy', () => {
                    // The preview destroys it on 'hidden', so drop the entry or teardown touches a disposed actor.
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
