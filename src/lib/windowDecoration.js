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
 * @param {{x:number,y:number}|null} phase
 * @param {object|null} actor
 * @returns {{x:number,y:number,actor?:object}|null}
 */
function tagPhase(phase, actor) {
    if (!phase || !actor)
        return phase;
    return {...phase, actor};
}

/**
 * The journal sink for the edge-triggered diagnostics. `console.warn` is not writable, so the
 * sink is injectable and a spec can observe the line instead of the process log.
 * @param {string} message
 */
function warnToJournal(message) {
    console.warn(message);
}

/**
 * A live actor's extent, or null when the actor is gone or its read throws. The body the clip and
 * the shadow act on comes from actors we do not own, so a torn-down read is "unknown" and leaves
 * the settle to fall back rather than aborting the pass.
 * @param {{width:number,height:number}|null} actor
 * @returns {{width:number,height:number}|null}
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
 * The window's own size from this pass's reading, or null when neither rect is usable. The frame
 * rect is the logical window size a focus hand-off or an animation does not change; the buffer
 * rect is the fallback when the frame read is unavailable. It is the independent authority that
 * tells a body moving on its own from a window actually resizing.
 * @param {object|null} inputs - The pass's WindowReading
 * @returns {{width:number,height:number}|null}
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
        this._warn = options.warn ?? warnToJournal;

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
        // The settle reference points, advanced once per pass. `_lastBody` is the last settled
        // body, `_lastAuthority` the authority it was settled from, and `_lastWindowSize` the
        // window's own size at the pass. The pass hands them to the geometry path as the plan; the
        // clip and the shadow read the actors and the window's own size live at their own clock and
        // settle the body there, so the cut tracks the frame the compositor draws rather than
        // freezing between the manager's 50 ms passes. `_lastBody`/`_lastAuthority` are only
        // advanced when the pass's own settle acts on the fresh body, so the hold cannot latch.
        this._lastBody = null;
        this._lastAuthority = null;
        this._lastWindowSize = null;
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
     *   overview: {inOverview: boolean, hasMask: boolean, hasShadow: boolean, hasBypass: boolean},
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
     * A live, read-only view of the decoration's clip internals for the diagnostic reply. Unlike
     * the compact `stateView` contract the e2e asserts, this reaches into the live clip effect for
     * the values the width-shrink investigation needs. Every field is a read; nothing here mutates
     * state, probes, or queues a repaint. A value that cannot be reached is null, which the reply
     * renders as an explicit `unavailable`.
     *
     * @returns {object}
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
        // An unreadable scale must not postpone the decoration. This pass can be the first frame of
        // an actor Mutter has just re-created, and a postponed clip there is an *unclipped* frame -
        // square corners and a visible margin, the focus hand-off flicker the journal shows. An
        // approximate scale instead costs a fraction of a pixel of corner rounding for one frame,
        // and only until the next pass reads the monitor for real. The body itself is still guarded
        // against acting on a disagreeing read, by settleClipBody below.
        const scale = this._resolveScale(inputs) ?? 1.0;

        // Hand the geometry path the plan, not a resolved body: the actors and the window's own
        // size are read live at paint, so the clip's cut and the shadow's cast settle from them
        // there and track the frame the compositor is drawing. The pass advances the reference
        // points on its own debounced clock, which is what the between-pass hold compares against.
        const windowSize = readWindowExtent(inputs);
        this._bodyPlan = {
            previousWindowSize: this._lastWindowSize,
            previousBody: this._lastBody,
            previousAuthority: this._lastAuthority,
        };
        const passSettle = settleClipBody(readActorExtent(clipTarget), readActorExtent(winActor),
            this._lastBody, this._lastAuthority, windowSize, this._lastWindowSize,
            BODY_SETTLE_TOLERANCE);
        this._lastBody = passSettle.body;
        this._lastAuthority = passSettle.authority;
        this._lastWindowSize = windowSize;

        // One plan per pass: the insets the body uses, and the two meanings the clip shader gives
        // the ring. Every consumer below reads this instead of recombining the detector's answer.
        //
        // The ring hold exists for a ring that moves while nothing else does: the buffer and the
        // frame rects are read in one pass, and if they are updated a step apart the ring is
        // momentarily a mixture of both, which shows as the window edge stepping in and back. So a
        // ring that moved with the buffer standing still is held - the "subject itself unchanged"
        // case the state-ownership rule allows.
        //
        // The witness is the BUFFER, not the window's own size, and it has to be: the ring is
        // `buffer - frame`, so the buffer is the only quantity the ring's own pixels come from.
        // `readWindowExtent` prefers the frame rect, and across a rebuild the frame can stand still
        // while the ring legitimately changes - measured on an unmaximize, frame stayed at
        // 400x300 through nine ring changes (20 -> 25) while the buffer grew 440 -> 450. Asking
        // the frame whether the ring may move answers "no" for every one of those, which would hold
        // a correct ring indefinitely.
        //
        // That is not hypothetical. The hold used to compare the window's own size against itself,
        // because the comparison was made after `_lastWindowSize` had been overwritten with this
        // pass's value from the same `inputs` (windowDecoration.js read it twice, from one object).
        // The predicate was therefore constant false, so the hold fired on *every* ring change and
        // then compared against its own output: one wrong ring latched in and never came back. A
        // Firefox window that was first seen maximized kept ring 0 after being unmaximized, and the
        // clip and the shadow's cutout both followed the full surface - a 24px band of the client's
        // own shadowless CSD area between the window and its shadow.
        //
        // So the predicate is now the one it was always meant to be, and it is the buffer's. A
        // rebuild moves the buffer on every one of its steps, so the hold releases through all of
        // them; nothing else can latch, because any move at all re-opens the decision.
        const buffer = inputs?.bufferRect ?? null;
        const bufferMoved = !this._lastBuffer || !buffer ||
            buffer.x !== this._lastBuffer.x || buffer.y !== this._lastBuffer.y ||
            buffer.width !== this._lastBuffer.width || buffer.height !== this._lastBuffer.height;
        let ringNow = rawInsets;
        if (!bufferMoved && this._lastRing) {
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
        this._applyStyle(actions.style, this.ring.insets, actions.drawClip, scale);

        this._checkDiagnosticInvariants(inputs, winActor);

        // _syncClip only runs the overview transition when the clip's presence changed, so the
        // style this pass produced - and a desktop pass that has to take the clip back - is
        // applied to the overview state here.
        this.setOverviewMode(inOverview);
    }

    /**
     * The physical scale for this pass, or the last good one when the read is unknown.
     *
     * The monitor scale reaches the clip cut, the shadow cutout and the resize band in one pass,
     * so substituting 1.0 for an unknown read would jump an already-correct fractional display to
     * scale 1 and back. A read failure is transient - a topology change or a torn-down window - and
     * says nothing about the monitor, so keep the scale the display was last built at; it starts at
     * 1.0, the identity the scale=1 path is bit-identical to. The clip's own decision still sees the
     * null (the detector skips the clip under prefer-crisp-text) rather than guessing an integer
     * here. Deferring the whole pass would also freeze geometry that is not scale-driven, so this
     * keeps the last good scale and lets the rest of the pass apply.
     *
     * @param {object|null} inputs
     * @returns {number}
     */
    _resolveScale(inputs) {
        const scale = inputs?.monitorScale;
        if (typeof scale === 'number' && scale > 0 && Number.isFinite(scale))
            return scale;
        return this._scale ?? null;
    }

    /**
     * Updates decoration state when entering or exiting Shell overview.
     *
     * The overview's own visuals live in `this.overview`; this only hands it the readings it
     * cannot take for itself, then keeps the desktop clip in step with the choice it made. The
     * mask replaces the clip for every Wayland window, the legacy offscreen clip stays for
     * XWayland or when the user forces corners, and on exit the clip comes back.
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
                this.clip = ClipClass ? new ClipClass(this._St) : null;
                this.clipTarget = clipTarget;
                this.clipTarget?.add_effect?.(this.clip);
            } else {
                this._removeClipEffect();
                this.clip = null;
                this.clipTarget = null;
            }
        } else if (wanted) {
            // Re-pin when the effect is not actually on the wanted actor. The effect's own actor is
            // the source of truth: apply() records the wanted target in `this.clipTarget` before
            // calling here, so comparing the wanted target with that field is always false and a
            // moved target is silently ignored. `get_actor()` cannot drift from what is attached,
            // and `_removeClipEffect()` detaches from that same actor, so a replaced surface
            // container is followed rather than left cutting the old actor (or lost with it when
            // the old container goes away).
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
                this.shadow = ShadowClass ? new ShadowClass(winActor, this._container, this._St) : null;
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
            scale: this._resolveScale(inputs),
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
     * Runs this pass's diagnostic invariants: the conditions a healthy pass must satisfy, made loud
     * once per episode. The predicates are pure (`diagnosticInvariants.js`); the per-window latches
     * live here, and each speaks only after `INVARIANT_STRIKES` consecutive violating passes.
     *
     * The buffer-versus-allocation pair is this pass's own assembled reading - the `bufferRect` the
     * manager read from the Meta.Window against the window actor's live allocation. In health they
     * are equal, so a disagreement means one of the two reads lagged the other in this pass; that
     * is the right-edge transient the shadow-vs-authority warning cannot see, because there the
     * authority itself is the value that moved.
     *
     * The phase pair is checked only on the fallback path. There the clip folds the mirror into its
     * geometry, so a mirror that does not reproduce the phase Mutter applied moves our cut off the
     * buffer. On the container path the phase is read back from the transform and the mirror is
     * unused, so a disagreement there is not a defect.
     *
     * @param {object} inputs - The pass's assembled reading (bufferRect, wmClass, pid)
     * @param {object} winActor - The window actor
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
     * @returns {{mirror: object|null, applied: object|null}}
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
     * @param {string} key - The latch field name on this decoration
     * @param {string|null} warning - This pass's warning text, or null when healthy
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
        // The ring hold's witness goes with the ring. A decoration that is dropped for a reading it
        // could not take and rebuilt when the geometry reads again must not resume holding a ring
        // from before the gap - the buffer it was compared against is gone with it, so any later
        // comparison would be against a subject this decoration never saw.
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
