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
import {MIN_DECORABLE_SIZE} from './detector.js';
import {BODY_SETTLE_TOLERANCE, settleClipBody} from '../effects/clipParams.js';
import {
    bufferAllocationWarning,
    evaluateInvariant,
    freshInvariantState,
    phaseAlignmentWarning,
    windowIdentityLabel,
} from './diagnosticInvariants.js';
import {flatSafeInsets} from './frame.js';
import {normalizeConstrainedEdges} from './resizeBand.js';
import {OverviewDecoration} from './overviewDecoration.js';
import {resolveMonitorBounds, safeRead} from './window.js';
import {getWindowGroup, getDisplay, setActorBelowSibling} from '../platform/display.js';
import {getAppliedSubpixelPhase, getSurfaceContainer, getWindowActor, getWindowSubpixelOffset} from '../platform/window.js';

/**
 * Names the actor a phase read came from, so `phaseAlignmentWarning` can refuse a pair read from
 * two actors. A null read stays null; a read with no actor (an X11 zero, a spec stub) stays
 * untagged and is compared as before.
 */
function tagPhase(phase, actor) {
    if (!phase || !actor)
        return phase;
    return {...phase, actor};
}

/**
 * A live actor's extent, or null when the actor is gone or its read throws. The body the clip and
 * the shadow act on comes from actors we do not own, so a torn-down read is "unknown" and leaves
 * the settle to fall back rather than aborting the pass.
 */
function readActorExtent(actor) {
    if (!actor)
        return null;
    try {
        return {width: actor.width, height: actor.height};
    } catch {
        return null;
    }
}

/**
 * The window's own size from this pass's reading: the frame rect, else the buffer rect, or null when
 * neither is usable. It is the independent authority that separates a body moving on its own from a
 * window actually resizing.
 */
function readWindowExtent(inputs) {
    for (const rect of [inputs?.frameRect, inputs?.bufferRect]) {
        if (rect && rect.width > 0 && rect.height > 0)
            return {width: rect.width, height: rect.height};
    }
    return null;
}

export class WindowDecoration {
    /**
     * @param [options.container] - Usually getWindowGroup()
     * @param [options.display] - Usually getDisplay()
     * @param [options.St] - Usually imports.gi.St
     * @param [options.OverviewMask] - {buildRoundedMask, opaqueMask} texture builders
     * @param [options.OverviewShadow] - Clutter.Clone subclass carrying the preview shadow
     * @param [options.warn] - Journal sink for the edge-triggered diagnostics; a spec injects one
     */
    constructor(win, options = {}) {
        this._win = win;
        this._container = options.container ?? (getWindowGroup() ?? null);
        this._display = options.display ?? (getDisplay() ?? null);
        this._St = options.St ?? (globalThis.St ?? null);

        this._RoundedClipEffect = options.RoundedClipEffect ?? null;
        this._ShadowActor = options.ShadowActor ?? null;
        this._ResizeBand = options.ResizeBand ?? null;
        this._warn = options.warn ?? (message => console.warn(message));

        // The overview's own decoration (mask, container opacity, shadow clone) is a
        // lifecycle of its own; the desktop reads it for clip decisions but never reaches in.
        this.overview = new OverviewDecoration(win, {
            OverviewMask: options.OverviewMask ?? null,
            OverviewShadow: options.OverviewShadow ?? null,
            warn: this._warn,
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

        // Edge-triggered diagnostic latches, one per invariant, reset on agreement. They are
        // per-window because "one WARNING per episode" is a window's episode, not the session's.
        this._bufferActorLatch = freshInvariantState();
        this._phaseLatch = freshInvariantState();

        this._style = null;
        // Not 1.0: an unread scale is *unknown*, and `apply()` refuses to act on it. A decoration
        // rebuilt while the previous one kept its visuals must not read that as "scale = 1".
        this._scale = null;
        // The monitors' scales this pass's frame touches, with their `ceil` variants: the candidate
        // set the clip picks the FBO's scale from. Null is "incomplete", which abstains.
        this._scaleCandidates = null;
        // The settle reference points, advanced once per pass: the last settled body, its authority,
        // the window's own size then, and the pair-disagreement count that bounds the hold. The geometry
        // path decides no body from them, and they advance only when a pass acts on the fresh body.
        this._lastBody = null;
        this._lastAuthority = null;
        this._lastWindowSize = null;
        this._pairDisagreementStrikes = 0;
        // The size the window was first decided at, latched once and never moved: the visual floor
        // reads it so a drag cannot flip the decoration. Null while unreadable - 0, NaN or a frame
        // below the geometric floor is not a size. One decoration per Meta.Window, so a rebuilt
        // window judges its own size afresh.
        this._initialFrameSize = null;
        // The ring hold's witness. The declared ring is `buffer - frame`, so only a buffer that
        // moved can make a new ring real; see the ring plan below for why the window's own size
        // cannot answer that.
        this._lastBuffer = null;
        // The plan handed to the clip and the shadow for the paints after this pass.
        this._bodyPlan = null;
        // The manager's "force corners" setting for this pass; handed to the overview, which
        // picks the legacy offscreen clip over the mask for XWayland and the fallback cases.
        this._forceOverviewCorners = false;

        this.shadow = null;
        this.resizeBand = null;
    }

    get isActivelyClipped() {
        return Boolean(this.clip && this.drawClip);
    }

    get hasClip() {
        return Boolean(this.clip);
    }

    get hasShadow() {
        return Boolean(this.shadow);
    }

    get hasResizeBand() {
        return Boolean(this.resizeBand);
    }

    /**
     * The frame size this decoration first decided the window at, or null while the latch is open.
     */
    get initialFrameSize() {
        return this._initialFrameSize ? {...this._initialFrameSize} : null;
    }

    /**
     * Closes the initial-size latch from one pass's frame size, and returns the size it holds either
     * way. A frame that is 0, NaN, infinite or below the geometric floor is unreadable rather than
     * small: the latch stays open and the pass is judged without the visual floor.
     */
    latchInitialFrameSize({frameWidth, frameHeight} = {}) {
        // An apply pass only proves the rect is readable and non-zero, so a placeholder 1x1 or 20x20
        // frame reaches here. A frame too small to hold a rounded rect is not a picture to read a
        // size from, the same way 0 or NaN is not - and 30 is exactly enough, hence `>=`.
        if (!this._initialFrameSize && frameWidth >= MIN_DECORABLE_SIZE &&
            frameHeight >= MIN_DECORABLE_SIZE &&
            Number.isFinite(frameWidth) && Number.isFinite(frameHeight))
            this._initialFrameSize = {width: frameWidth, height: frameHeight};
        return this.initialFrameSize;
    }

    /**
     * Returns a fresh snapshot copy of the current decoration state flags.
     *
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
     * A live, read-only view of the decoration's clip internals for the diagnostic reply. This is not the
     * compact `stateView` contract the e2e asserts: it reaches into the live effect for the values the
     * width-shrink investigation needs. Every field is a read, and an unreachable value is null, which the
     * reply renders as `unavailable`.
     */
    get diagnosticsView() {
        const clip = this.clip;
        const hasClip = Boolean(clip);
        const target = safeRead(() => clip?.get_actor?.() ?? this.clipTarget, null);
        const shadow = safeRead(() => this.shadow?.diagnosticsView ?? null, null);

        return {
            clipTargetType: hasClip
                ? safeRead(() => target?.constructor?.$gtype?.name ?? 'unavailable', null)
                : null,
            clipTargetName: hasClip ? safeRead(() => target?.name ?? 'unavailable', null) : null,
            phaseInTransform: hasClip
                ? safeRead(() => Boolean(clip._phaseInTransform ?? this.clipPhaseInTransform), null)
                : null,
            clipFrame: hasClip ? safeRead(() => clip._frameVec ?? null, null) : null,
            clipInsets: hasClip ? safeRead(() => this.clipInsets ?? null, null) : null,
            clipScale: hasClip ? safeRead(() => clip._scale ?? null, null) : null,
            clipEnabled: hasClip ? safeRead(() => Boolean(clip.enabled), null) : null,
            clipSuspended: hasClip ? safeRead(() => Boolean(clip._suspended), null) : null,
            // The resolved target's live box, read alone from the clip's frame: on the container
            // path this is the surface container the clip's body authority names, and the pair with
            // `windowActorAllocation` in the reply shows which side moved when the shadow disagrees.
            containerBox: safeRead(() => target
                ? {x: target.x, y: target.y, width: target.width, height: target.height}
                : null, null),
            // The shadow's side of the same body, so one debug pick during the glitch shows the
            // clip's frame, the container it derived from, and the shadow box/cast/right band.
            shadowWidth: shadow?.width ?? null,
            shadowHeight: shadow?.height ?? null,
            shadowCast: shadow?.cast ?? null,
            shadowRightBand: shadow?.rightBand ?? null,
        };
    }

    /**
     * Safely retrieves the window compositor private actor.
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
     * @param [params.actor] - Window actor
     * @param [params.target] - A
     *        resolveClipTarget() result; resolved from the window when omitted
     */
    apply({actions, inputs, actor = null, target = null, inOverview = false, forceOverviewCorners = false}) {
        const winActor = this._getActor(actor);
        if (!winActor)
            return;

        this._forceOverviewCorners = Boolean(forceOverviewCorners);

        const resolvedTarget = target ?? resolveClipTarget(this._win, winActor, this._St);
        // A container that has not allocated yet defers the target choice: keep the target the clip
        // is already on rather than attach it to an unverified actor. With no earlier target, the
        // window actor - always present and verified - is the fallback. The manager watches the
        // container's notify::allocation and re-runs this resolution once it settles.
        if (resolvedTarget?.defer) {
            if (!this.clipTarget) {
                this.clipTarget = winActor;
                this.clipPhaseInTransform = false;
            }
        } else {
            this.clipTarget = resolvedTarget?.actor ?? null;
            this.clipPhaseInTransform = resolvedTarget?.phaseInTransform ?? false;
        }
        const clipTarget = this.clipTarget;
        const rawInsets = inputs.insets;
        // An unreadable scale must not postpone the decoration: this pass can be the first frame of an
        // actor Mutter just re-created, and a postponed clip there is an unclipped frame - square corners
        // and a visible margin. An approximate scale costs a fraction of a pixel for one frame; the body
        // stays guarded by settleClipBody.
        const readableScale = this._resolveScale(inputs);
        const scale = readableScale ?? 1.0;
        // The reconcile pass's candidate set, read from the same monitors the scale came from: it
        // is what the clip picks the FBO's scale from, so a paint re-reads no display. Null here
        // is "incomplete", and the clip abstains on it instead of picking from a partial set.
        this._scaleCandidates = inputs?.monitorScaleCandidates ?? null;

        // Hand the geometry path the plan, not a resolved body: the actors and the window's own size are
        // read live at paint, so the cut and the cast settle from them there and track the frame being drawn.
        const windowSize = readWindowExtent(inputs);
        this._bodyPlan = {
            previousWindowSize: this._lastWindowSize,
            previousBody: this._lastBody,
            previousAuthority: this._lastAuthority,
            pairDisagreementStrikes: this._pairDisagreementStrikes,
        };
        const passSettle = settleClipBody(readActorExtent(clipTarget), readActorExtent(winActor),
            this._lastBody, this._lastAuthority, windowSize, this._lastWindowSize,
            BODY_SETTLE_TOLERANCE, this._pairDisagreementStrikes);
        this._lastBody = passSettle.body;
        this._lastAuthority = passSettle.authority;
        this._lastWindowSize = windowSize;
        this._pairDisagreementStrikes = passSettle.pairDisagreementStrikes;

        // One plan per pass: the insets the body uses, and the meanings the clip shader gives the ring.
        // The ring hold covers a ring that moves while nothing else does; its witness is the BUFFER, since
        // the ring is `buffer - frame` and a rebuild moves the buffer at every step.
        const buffer = inputs?.bufferRect ?? null;
        const bufferMoved = !this._lastBuffer || !buffer ||
            buffer.x !== this._lastBuffer.x || buffer.y !== this._lastBuffer.y ||
            buffer.width !== this._lastBuffer.width || buffer.height !== this._lastBuffer.height;
        let ringNow = rawInsets;
        // A null ring is the frame-not-inside-buffer case, not a moved ring: it cannot be compared,
        // so the hold is skipped and the previous ring is not resurrected from an unreadable pass.
        if (!bufferMoved && this._lastRing && rawInsets) {
            const drifted = Math.abs((this._lastRing.left ?? 0) - (rawInsets.left ?? 0)) >= 1 ||
                Math.abs((this._lastRing.top ?? 0) - (rawInsets.top ?? 0)) >= 1 ||
                Math.abs((this._lastRing.right ?? 0) - (rawInsets.right ?? 0)) >= 1 ||
                Math.abs((this._lastRing.bottom ?? 0) - (rawInsets.bottom ?? 0)) >= 1;
            if (drifted)
                ringNow = this._lastRing;
        }
        this._lastBuffer = buffer;
        this._lastRing = ringNow;
        this.ring = {
            insets: actions.ring.safeInset && (actions.drawClip || actions.drawShadow)
                ? flatSafeInsets(scale) : ringNow,
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
        this._applyStyle(actions.style, this.ring.insets, actions.drawClip, scale, readableScale);

        this._checkDiagnosticInvariants(inputs, winActor);

        // _syncClip only runs the overview transition when the clip's presence changed, so the
        // style this pass produced - and a desktop pass that has to take the clip back - is
        // applied to the overview state here.
        this.setOverviewMode(inOverview);
    }

    /**
     * The physical scale for this pass, or the last good one when the read is unknown. Substituting 1.0
     * would jump an already-correct fractional display to scale 1 and back, since one pass feeds the clip
     * cut, the shadow cutout and the resize band; a failed read is transient. The clip still sees the null.
     */
    _resolveScale(inputs) {
        const scale = inputs?.monitorScale;
        if (typeof scale === 'number' && scale > 0 && Number.isFinite(scale))
            return scale;
        return this._scale ?? null;
    }

    /**
     * Updates decoration state when entering or exiting the Shell overview: it hands `this.overview` the
     * readings it cannot take for itself, then keeps the desktop clip in step with the choice the overview
     * made - the mask for every Wayland window, the offscreen clip for XWayland or a forced setting, and the
     * clip back on exit.
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

    _syncClip(wantEffect, clipTarget = null, insets = null, inOverview = false) {
        // Clip effect requires valid insets (null indicates frame does not fit inside buffer).
        const wanted = wantEffect && Boolean(insets);
        const hasClip = Boolean(this.clip);

        if (wanted !== hasClip) {
            if (wanted) {
                const ClipClass = this._RoundedClipEffect;
                this.clip = ClipClass ? new ClipClass(this._St) : null;
                this.clipTarget = clipTarget;
                this.clipTarget?.add_effect?.(this.clip);
            } else {
                this._removeClipEffect();
                this.clip = null;
                this.clipTarget = null;
            }
        } else if (wanted) {
            // Re-pin when the effect is not on the wanted actor. The effect's own `get_actor()` is the source
            // of truth: comparing against `this.clipTarget` is always false, since apply() records the wanted
            // target before calling here, so a moved target would be silently ignored. `_removeClipEffect()`
            // detaches from that same actor.
            if (clipTarget !== (this.clip?.get_actor?.() ?? null)) {
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

    _syncShadow(wantShadow, actor = null) {
        const winActor = this._getActor(actor);
        if (!winActor)
            return;

        const hasShadow = Boolean(this.shadow);
        if (wantShadow !== hasShadow) {
            if (wantShadow) {
                const ShadowClass = this._ShadowActor;
                this.shadow = ShadowClass ? new ShadowClass(winActor, this._container, this._St) : null;
            } else {
                this.shadow?.destroy?.();
                this.shadow = null;
            }
        }
    }

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
            scale: this._resolveScale(inputs),
            constrainedEdges,
        });
    }

    _applyStyle(style, insets, drawClip, scale = 1.0, lastGoodScale = scale) {
        this._style = style;
        // Only a readable reading becomes the last good one. The substituted 1.0 still lays this
        // pass out through `scale`, but storing it would hand 1.0 to every later unreadable pass.
        this._scale = lastGoodScale;
        // Record what is drawn, not what was asked: a pass whose insets are null has no clip to
        // attach, so the overview must not later mask a corner the desktop never shows.
        this.drawClip = Boolean(this.clip && drawClip && style.radius > 0);

        this._syncClipParams();
        this.clip?.setBodyPlan?.(this._bodyPlan);
        if (this.shadow) {
            // Both cuts read the same phase source: the shadow follows the clip's resolved target
            // strategy (see shadowPhaseOffset). Its body authority is that same target, so the two
            // derive the body from one source and a transient container/actor disagreement cannot
            // shrink the shadow's band while the clip's cut stays put.
            this.shadow.setPhaseInTransform?.(this.clipPhaseInTransform);
            this.shadow.setClipTarget?.(this.clipTarget);
            this.shadow.setBodyPlan?.(this._bodyPlan);
            this.shadow.setScale?.(scale);
            this.shadow.setShadowInsets?.(insets);
            this.shadow.setShadowStyle?.({
                ...style,
                radius: this.clip && drawClip ? style.radius : 0,
            });
        }
    }

    /**
     * Runs this pass's diagnostic invariants: the conditions a healthy pass must satisfy, made loud once per
     * episode. The predicates are pure, the per-window latches live here, and each speaks after
     * `INVARIANT_STRIKES` consecutive violations. The buffer-versus-allocation pair is this pass's own
     * reading; the phase pair is compared on the fallback path only.
     */
    _checkDiagnosticInvariants(inputs, winActor) {
        const label = windowIdentityLabel(inputs ?? {});
        const bufferRect = inputs?.bufferRect ?? null;
        const actorBox = winActor
            ? {x: winActor.x ?? 0, y: winActor.y ?? 0, width: winActor.width, height: winActor.height}
            : null;
        this._fireInvariant('_bufferActorLatch',
            bufferAllocationWarning(bufferRect, actorBox, label));

        if (!this.clipPhaseInTransform && this._win) {
            const {mirror, applied} = this._readPhases();
            this._fireInvariant('_phaseLatch', phaseAlignmentWarning(mirror, applied, label));
        } else {
            this._phaseLatch = freshInvariantState();
        }
    }

    /**
     * The two subpixel-phase reads, in one seam so a spec can drive both states without a Clutter
     * container. The mirror is the reconstructed phase; the applied read is what Mutter put on the
     * surface container's transform.
     *
     */
    _readPhases() {
        // One container, both reads: the mirror folds that container's layout and the applied read
        // is that same actor's transform, so the caller's comparison is between one authority.
        // Tagging each read with the actor it came from lets the predicate refuse a mismatched
        // pair instead of reporting a position as if it were a phase.
        const actor = getWindowActor(this._win);
        const container = actor ? getSurfaceContainer(actor, this._win, this._St) : null;
        return {
            mirror: tagPhase(getWindowSubpixelOffset(this._win, this._St, container), container),
            applied: tagPhase(getAppliedSubpixelPhase(this._win, this._St, container), container),
        };
    }

    /**
     * Advances one latch by one pass and logs the text when this pass is the episode's first
     * sustained violation.
     * @param key - The latch field name on this decoration
     * @param warning - This pass's warning text, or null when healthy
     */
    _fireInvariant(key, warning) {
        const {state, message} = evaluateInvariant(this[key], warning);
        this[key] = state;
        if (message)
            this._warn(message);
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
                scaleCandidates: this._scaleCandidates,
            });
        }
    }

    /**
     * Restacks shadow actor below the window actor and syncs resize band stack order.
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
        // The ring hold's witness goes with the ring: a decoration dropped for a reading it could not take
        // must not resume holding a ring from before the gap, because the buffer it was compared against is
        // gone with it.
        this._lastBuffer = null;
        this._lastRing = null;
        this.overview.drop();
        this._syncClip(false);
        this._syncShadow(false);
        this._syncResizeBand(false, null, null);
    }

    _removeClipEffect() {
        if (!this.clip)
            return;

        // Detach from the actor the effect is really on, not the bookkeeping field: after apply()
        // records a new target the field may already name the new actor while the effect is still
        // on the old one, and removing from the new actor would strand the clip on the old one.
        const actor = this.clip.get_actor?.() ?? this.clipTarget;
        if (!actor)
            return;

        try {
            actor.remove_effect?.(this.clip);
        } catch {
            // Target already gone.
        }
    }

    /**
     * Phased teardown: destroys the resize band (no stray clicks), drops the overview decoration, then
     * detaches the clip and shadow actors unless the caller keeps the visuals for a close animation. The
     * signals, the debounce and the first-frame idle belong to the manager and are torn down there.
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
