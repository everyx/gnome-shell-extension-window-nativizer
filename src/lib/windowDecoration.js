import {resolveClipTarget} from './clipTarget.js';
import {MIN_DECORABLE_SIZE} from './detector.js';
import {BodyPlan, readActorSize, windowSizeFrom} from '../effects/bodyPlan.js';
import {decorationPass} from '../effects/decorationPass.js';
import {insetsMoved, rectEquals} from '../platform/rect.js';
import {
    Diagnostic,
    bufferAllocationWarning,
    phaseAlignmentWarning,
    windowIdentityLabel,
} from './diagnosticInvariants.js';
import {flatSafeInsets} from './frame.js';
import {journal} from '../platform/journal.js';
import {normalizeConstrainedEdges} from './resizeBand.js';
import {OverviewDecoration} from './overviewDecoration.js';
import {resolveMonitorBounds, safeRead} from './window.js';
import {getWindowGroup, getDisplay, setActorBelowSibling} from '../platform/display.js';
import {getSurfaceContainer} from '../platform/surfaceContainer.js';
import {getWindowActor} from '../platform/window.js';
import {getAppliedSubpixelPhase, getWindowSubpixelOffset} from '../platform/windowPhase.js';

/** Owns one window's clip, shadow and resize band; injected options keep it unit-testable. */
export class WindowDecoration {
    /** Every option is a seam: omit it and the real Shell object is used. */
    constructor(win, options = {}) {
        this._win = win;
        this._container = options.container ?? (getWindowGroup() ?? null);
        this._display = options.display ?? (getDisplay() ?? null);
        this._St = options.St ?? (globalThis.St ?? null);

        this._RoundedClipEffect = options.RoundedClipEffect ?? null;
        this._ShadowActor = options.ShadowActor ?? null;
        this._ResizeBand = options.ResizeBand ?? null;
        this._journal = options.journal ?? journal;

        // The overview's decoration owns its lifecycle; the desktop reads its mode, nothing more.
        this.overview = new OverviewDecoration(win, {
            OverviewMask: options.OverviewMask ?? null,
            OverviewShadow: options.OverviewShadow ?? null,
            journal: this._journal,
            // A card rebuild can settle on another mode; follow what installed, not what was asked.
            onModeChange: mode => this._syncOverviewClip(mode),
        });

        this.clip = null;
        this.clipTarget = null;
        // The resolved target's phase strategy; the clip effect reads it at attach/repin time.
        this.clipPhaseInTransform = true;
        // The pass's container, so the reads and the clip name one actor; undefined = not supplied.
        this.surfaceContainer = undefined;

        // Edge-triggered, one per invariant, re-armed on agreement; an episode belongs to a window.
        this._bufferActorDiagnostic = new Diagnostic(this._journal);
        this._phaseDiagnostic = new Diagnostic(this._journal);

        // Not 1.0: it holds the last good scale for later passes, since unread means unknown.
        this._scale = null;
        // Reference points kept across passes; they advance only when a pass acts on a fresh body.
        this.bodyPlan = new BodyPlan();
        // Latched once, never moved: the visual floor reads it, so a drag cannot flip the corners.
        this._initialFrameSize = null;
        // The hold's witness: the ring is buffer - frame, so only a moved buffer makes a ring real.
        // The buffer and the ring are one record because neither is ever read without the other.
        this._witness = null;
        // The last pass both cuts painted: the one record a mode change re-pushes outside a pass.
        this._pass = null;
        // The force-corners flag for this pass; the overview then picks the legacy offscreen clip.
        this._forceOverviewCorners = false;

        this.shadow = null;
        this.resizeBand = null;
    }

    get isActivelyClipped() {
        return Boolean(this.clip && this._pass?.drawClip);
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

    /** The size the window was first decided at, or null while the latch is open. */
    get initialFrameSize() {
        return this._initialFrameSize;
    }

    /** Closes the latch; below the floor is unreadable, not small. */
    latchInitialFrameSize({frameWidth, frameHeight} = {}) {
        if (!this._initialFrameSize && frameWidth >= MIN_DECORABLE_SIZE &&
            frameHeight >= MIN_DECORABLE_SIZE &&
            Number.isFinite(frameWidth) && Number.isFinite(frameHeight))
            this._initialFrameSize = {width: frameWidth, height: frameHeight};
        return this.initialFrameSize;
    }

    get stateView() {
        return {
            hasClip: Boolean(this.clip),
            drawClip: Boolean(this._pass?.drawClip),
            isActivelyClipped: this.isActivelyClipped,
            hasShadow: this.hasShadow,
            hasResizeBand: this.hasResizeBand,
            ring: this._pass?.ring ? {...this._pass.ring} : null,
            overview: this.overview.stateView,
        };
    }

    /** Live clip internals for the diagnostic reply; an unreadable value is null, not an error. */
    get diagnosticsView() {
        const clip = this.clip;
        const hasClip = Boolean(clip);
        const target = safeRead(() => clip?.get_actor?.() ?? this.clipTarget, null);
        const shadow = safeRead(() => this.shadow?.diagnosticsView ?? null, null);
        // The effect answers for its own fields; this view only composes the answers.
        const effect = hasClip ? safeRead(() => clip.diagnosticsView ?? null, null) : null;

        return {
            clipTargetType: hasClip
                ? safeRead(() => target?.constructor?.$gtype?.name ?? 'unavailable', null)
                : null,
            clipTargetName: hasClip ? safeRead(() => target?.name ?? 'unavailable', null) : null,
            phaseInTransform: hasClip
                ? safeRead(() => Boolean(effect?.phaseInTransform ?? this.clipPhaseInTransform), null)
                : null,
            clipFrame: effect?.frame ?? null,
            clipInsets: hasClip ? safeRead(() => this._pass?.ring?.insets ?? null, null) : null,
            clipScale: effect?.scale ?? null,
            clipEnabled: hasClip ? safeRead(() => Boolean(clip.enabled), null) : null,
            clipSuspended: hasClip ? safeRead(() => Boolean(effect?.suspended), null) : null,
            // The target's live box: one pick shows which side moved when shadow and clip disagree.
            containerBox: safeRead(() => target
                ? {x: target.x, y: target.y, width: target.width, height: target.height}
                : null, null),
            shadowWidth: shadow?.width ?? null,
            shadowHeight: shadow?.height ?? null,
            shadowCast: shadow?.cast ?? null,
            shadowRightBand: shadow?.rightBand ?? null,
        };
    }

    _getActor(actor = null) {
        if (actor)
            return actor;
        return getWindowActor(this._win);
    }

    /** Applies one pass's actions and readings; the target comes from the window when omitted. */
    apply(request) {
        const winActor = this._getActor(request.actor ?? null);
        if (!winActor)
            return;

        const read = this._readPass(request, winActor);
        this._drawPass(read, winActor);
        this._settlePass(read, winActor);
    }

    /**
     * Everything this pass reads, before anything is written: target, scale, witness, the plan it
     * settles against, and the ring those compose into. Only the resolved target and the two inputs
     * the overview reads later stay on `this`; the rest travels in the record, so no read can be
     * reordered behind a write that would change it.
     */
    _readPass({
        actions, inputs, target = null, surfaceContainer = undefined,
        inOverview = false, forceOverviewCorners = false,
    }, winActor) {
        this._forceOverviewCorners = Boolean(forceOverviewCorners);

        const resolvedTarget = target ??
            resolveClipTarget(this._win, winActor, this._St, surfaceContainer);
        // null means this pass found none, which _readPhases must tell apart from undefined.
        this.surfaceContainer = surfaceContainer;
        // An unallocated container defers: never attach the clip to an unverified actor mid-pass.
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
        // An unreadable scale must not postpone the clip: an unclipped frame is worse than 1.0.
        const readableScale = this._resolveScale(inputs);

        // Judged before anything draws: a pass that throws later must still speak or re-arm.
        this._checkDiagnosticInvariants(inputs, winActor);

        // Hand it the plan, not a body: actors are read live at paint, so the cut tracks the frame.
        // The same rule as the paint's live read, over this pass's snapshot.
        const windowSize = windowSizeFrom(inputs?.frameRect, inputs?.bufferRect);
        const passPlan = this.bodyPlan.settle;

        // Hold a ring that drifts while nothing else moves: the buffer witnesses it, not the frame.
        const buffer = inputs?.bufferRect ?? null;
        const witness = this._witness;
        let ringNow = rawInsets;
        // The hold is for a buffer that did not move: a null ring is frame-not-inside-buffer, not a
        // drifted one, and insetsMoved answers false for it.
        if (rectEquals(witness?.buffer, buffer) && insetsMoved(witness?.ring, rawInsets))
            ringNow = witness.ring;
        const scale = readableScale ?? 1.0;
        const ring = {
            insets: actions.ring.safeInset && (actions.drawClip || actions.drawShadow)
                ? flatSafeInsets(scale) : ringNow,
            clear: actions.ring.clear,
            erase: actions.ring.clear || actions.ring.safeInset,
        };

        return {
            actions, inputs, inOverview, ring, ringNow, buffer, windowSize, passPlan,
            scale, readableScale, scaleCandidates: inputs?.monitorScaleCandidates ?? null,
            clipTarget, phaseInTransform: this.clipPhaseInTransform,
        };
    }

    /** The writes, in the order the devices need them; the pass is recorded once they exist. */
    _drawPass(read, winActor) {
        const {actions, ring, inOverview} = read;

        this._syncClip(actions.drawClip || actions.ring.clear, read.clipTarget, ring.insets, inOverview);

        // A cleared ring defers to the client's shadow, but never while our clip is in place.
        const deferToClientShadow = actions.ring.clear && !this.clip;
        this._syncShadow(actions.drawRing || (!deferToClientShadow && actions.drawShadow), winActor);

        this._syncResizeBand(actions.drawResize, read.inputs, ring.insets, winActor);

        // Only a readable scale is stored: the substituted 1.0 lays out this pass and no more.
        this._scale = read.readableScale;
        // Record what is drawn, not asked: the overview must not mask a corner no clip ever cut.
        const drawnClip = Boolean(this.clip && actions.drawClip && actions.style.radius > 0);
        const pass = decorationPass({
            style: actions.style,
            ring,
            drawClip: drawnClip,
            scale: read.scale,
            readableScale: read.readableScale,
            scaleCandidates: read.scaleCandidates,
            bodyPlan: read.passPlan,
            clipTarget: read.clipTarget,
            phaseInTransform: read.phaseInTransform,
            // Not snapshotted: the overview owns this answer and setMode refuses while it is
            // destroyed, so the value is read from the owner rather than from the request.
            inOverview: this.overview.inOverview,
        });
        this._pass = pass;
        this.clip?.applyPass(pass);
        // Both cuts read one phase source and body: a transient disagreement cannot split them.
        this.shadow?.applyPass(pass);

        // Presence changes only in _syncClip, so this pass's style is pushed here, and can throw.
        this.setOverviewMode(inOverview);
    }

    /** Written last: a throw must not advance the episode, though an attached effect stays. */
    _settlePass(read, winActor) {
        this.bodyPlan.next({
            targetSize: readActorSize(read.clipTarget),
            windowActorSize: readActorSize(winActor),
            windowSize: read.windowSize,
        });
        this._witness = {buffer: read.buffer, ring: read.ringNow};
    }

    /** Falls back to the last good scale, so a transient miss cannot jump a fractional display. */
    _resolveScale(inputs) {
        const scale = inputs?.monitorScale;
        if (typeof scale === 'number' && scale > 0 && Number.isFinite(scale))
            return scale;
        return this._scale ?? null;
    }

    /** Hands the overview what it cannot read, then keeps the clip on the mode it chose. */
    setOverviewMode(inOverview, clipInsets = this.clip ? this._pass?.ring?.insets ?? null : null) {
        const pass = this._pass;
        const mode = this.overview.setMode(inOverview, {
            radius: pass?.style?.radius ?? 0,
            insets: clipInsets,
            erase: this.clip ? Boolean(pass?.ring?.erase) : false,
            scale: this._scale,
            drawClip: Boolean(pass?.drawClip),
            hasStyle: Boolean(pass?.style),
            forceOverviewCorners: this._forceOverviewCorners,
            shadow: this.shadow,
        });

        this._syncOverviewClip(mode);
    }

    /** Re-hands the pass: an overview mode change outside a pass must restate its parameters. */
    _pushPass() {
        if (!this.clip || !this._pass)
            return;
        this.clip.applyPass?.(decorationPass({...this._pass, inOverview: this.overview.inOverview}));
    }

    /** Keeps the clip on the mode that installed: a pass, or a card rebuild under a resize. */
    _syncOverviewClip(mode) {
        if (!this.clip)
            return;
        // The desktop just has the clip on; enabled is computed once, so resume and enable agree.
        const enabled = this.overview.inOverview ? mode === 'clip' : true;
        if (enabled)
            this.clip.resume?.();
        this.clip.set_enabled(enabled);
        this._pushPass();
    }

    _syncClip(wantEffect, clipTarget = null, insets = null, inOverview = false) {
        const wanted = wantEffect && Boolean(insets);
        const hasClip = Boolean(this.clip);

        if (wanted !== hasClip) {
            if (wanted) {
                const ClipClass = this._RoundedClipEffect;
                this.clip = ClipClass
                    ? new ClipClass(this._St, {journal: this._journal})
                    : null;
                this.clipTarget = clipTarget;
                this.clipTarget?.add_effect?.(this.clip);
            } else {
                this._removeClipEffect();
                this.clip = null;
                this.clipTarget = null;
            }
        } else if (wanted) {
            // Re-pin against the effect's get_actor(): clipTarget already names the new one.
            if (clipTarget !== (this.clip?.get_actor() ?? null)) {
                this._removeClipEffect();
                this.clipTarget = clipTarget;
                this.clipTarget?.add_effect?.(this.clip);
            }
        }
        // A re-pin restates the phase strategy too; the setter is a no-op while unchanged.
        if (this.clip)
            this.clip.setPhaseInTransform?.(this.clipPhaseInTransform);
        // A clip that appears is suppressed at once, not at the end of the pass: the overview must
        // never hold an enabled clip, even between these two calls.
        if (wanted !== hasClip)
            this.setOverviewMode(inOverview, this.clip ? insets : null);
    }

    _syncShadow(wantShadow, actor = null) {
        const winActor = this._getActor(actor);
        if (!winActor)
            return;

        const hasShadow = Boolean(this.shadow);
        if (wantShadow !== hasShadow) {
            if (wantShadow) {
                const ShadowClass = this._ShadowActor;
                this.shadow = ShadowClass
                    ? new ShadowClass(winActor, this._container, this._St, {journal: this._journal})
                    : null;
            } else {
                this.shadow?.destroy();
                this.shadow = null;
            }
        }
    }

    _syncResizeBand(want, inputs, insets, actor = null) {
        if (!want) {
            this.resizeBand?.destroy();
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
            // A window that is being deallocated, or a monitor that just went away.
        }

        const constrainedEdges = normalizeConstrainedEdges({
            maximizedHorizontally: inputs?.maximizedHorizontally,
            maximizedVertically: inputs?.maximizedVertically,
        });

        this.resizeBand?.setGeometry({
            insets: insets ?? null,
            bounds,
            // Null bounds is unknown, not unclipped: full strips swallow the next monitor's clicks.
            boundsUnknown: bounds === null,
            scale: this._resolveScale(inputs),
            constrainedEdges,
        });
    }


    /** Judges this pass's invariants; each speaks once per episode, after consecutive strikes. */
    _checkDiagnosticInvariants(inputs, winActor) {
        const label = windowIdentityLabel(inputs ?? {});
        const bufferRect = inputs?.bufferRect ?? null;
        const actorBox = winActor
            ? {x: winActor.x ?? 0, y: winActor.y ?? 0, width: winActor.width, height: winActor.height}
            : null;
        this._bufferActorDiagnostic.check(bufferAllocationWarning(bufferRect, actorBox, label));

        // No phase pair is agreement, not a skip: checking null re-arms, skipping leaves it armed.
        const {mirror, applied} = this.clipPhaseInTransform || !this._win
            ? {mirror: null, applied: null}
            : this._readPhases();
        this._phaseDiagnostic.check(phaseAlignmentWarning(mirror, applied, label));
    }

    /** Both phase reads in one seam: the mirror is rebuilt, the applied read comes from Mutter. */
    _readPhases() {
        // One container for both reads: the pass's when supplied, else the one resolved here.
        let container = this.surfaceContainer;
        if (container === undefined) {
            const actor = getWindowActor(this._win);
            container = actor ? getSurfaceContainer(actor, this._win, this._St) : null;
        }
        // No container means no pair: handing null down would let each reader resolve its own, and
        // a mirror folded from one actor against another's transform is a phase against a position.
        if (!container)
            return {mirror: null, applied: null};
        return {
            mirror: getWindowSubpixelOffset(this._win, this._St, container),
            applied: getAppliedSubpixelPhase(this._win, this._St, container),
        };
    }

    restack(actor = null) {
        const winActor = this._getActor(actor);
        if (!winActor)
            return;

        if (this.shadow && this._container)
            setActorBelowSibling(this.shadow, winActor, this._container);

        this.resizeBand?.restack();
    }

    resetBandCursor() {
        this.resizeBand?.resetCursor();
    }

    undecorate() {
        this._pass = null;
        // The witness goes with the ring: a ring from before the gap must not be held across it.
        this._witness = null;
        this.bodyPlan.reset();
        // A report describes the pass that ended, so the next episode starts unheard.
        this._bufferActorDiagnostic.reset();
        this._phaseDiagnostic.reset();
        this.overview.drop();
        this._syncClip(false);
        this._syncShadow(false);
        this._syncResizeBand(false, null, null);
    }

    _removeClipEffect() {
        if (!this.clip)
            return;

        // A queued disable must not reach an effect this pass is detaching or losing with its actor.
        this.clip.cancelPendingDisable?.();

        // Detach from the effect's real actor, not clipTarget, which may already name the next one.
        const actor = this.clip.get_actor?.() ?? this.clipTarget;
        if (!actor)
            return;

        try {
            actor.remove_effect?.(this.clip);
        } catch {
            // The effect went away with its actor.
        }
    }

    /** Phased teardown; a close animation may keep the visuals, the manager keeps the signals. */
    destroy({keepVisualsForClose = false} = {}) {
        try {
            this.resizeBand?.destroy();
        } catch {
            // The band may already be destroyed.
        }
        this.resizeBand = null;

        this.overview.destroy();

        // Keeping the visuals keeps the effect, so _removeClipEffect does not run and would leave
        // its queued disable behind: an idle firing after the actor is gone reaches a disposed one.
        if (keepVisualsForClose)
            this.clip?.cancelPendingDisable();

        if (!keepVisualsForClose) {
            this._removeClipEffect();
            this.clip = null;
            this.clipTarget = null;

            try {
                this.shadow?.destroy();
            } catch {
                // The shadow may already be gone.
            }
            this.shadow = null;
        }
    }
}
