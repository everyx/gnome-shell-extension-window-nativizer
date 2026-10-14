/**
 * Pure shadow geometry: the baked square and how it slices across a window.
 *
 * Kept free of GI imports so the degenerate-size rules stay unit-testable; the Cogl
 * bake lives in shadowTexture.js.
 */

import {ADWAITA_STYLE} from '../lib/adwaitaStyle.generated.js';
import {EFFECT_PADDING_ORIGIN, EFFECT_PADDING_EXTRA} from '../lib/clutterEffectPadding.generated.js';
import {clipFrameFor, ZERO_PHASE} from '../lib/snap.js';
import {resolveClipSize} from './clipParams.js';
import {getAppliedSubpixelPhase, getWindowSubpixelOffset} from '../platform/window.js';

// Padding in px, derived from maximum Gaussian reach over all shadow layers.
export const SHADOW_PAD = ADWAITA_STYLE.shadowPad;

/**
 * How far the clip's body authority and the shadow's own box may differ before it is a defect.
 *
 * The clip's cut and the shadow's body are the same rectangle by construction and the pick data
 * showed them equal (frameRect == bufferRect == windowActorAllocation), so a healthy window is
 * exact. Half a logical pixel absorbs float residue and the odd lagging read without hiding a
 * real disagreement, which moves the body by whole pixels (the observed missing band was 28px).
 */
export const SHADOW_BODY_TOLERANCE = 0.5;

// Offscreen padding matching Mutter clutter-actor-box conventions (2px origin, 3px extra).
const BAKE_ORIGIN = EFFECT_PADDING_ORIGIN;
const BAKE_EXTRA = EFFECT_PADDING_EXTRA;

/**
 * Canonical square 2*(pad+radius) with middle 2*pad (settled strip).
 * Corner slice spans 2*pad+radius so the cutline sits at the settled profile (C0 continuity).
 * @param {number} radius - Corner radius in px
 * @returns {{corner:number,window:number,buffer:number}} sizes in px
 */
export function shadowGeometry(radius) {
    const corner = 2 * SHADOW_PAD + radius;
    const window = 2 * (SHADOW_PAD + radius);
    return {
        corner,
        window,
        buffer: 2 * corner + BAKE_EXTRA,
    };
}

/**
 * Computes the cast rect from an already-resolved body size.
 *
 * `shadowCastRect` is the "actor box in, body out" form; this is the form the shadow uses when
 * the body comes from the clip's authority rather than from its own bound box. Both expand the
 * phase-free `clipFrameFor` body by SHADOW_PAD, so the hole is the clip's frame edge either way.
 *
 * @param {{width: number, height: number}} bodySize - Body extent in px
 * @param {import('../lib/frame.js').Insets} [insets] - Ring the client declared, per side
 * @param {number} [scale=1.0] - Physical scale factor
 * @returns {{x:number,y:number,width:number,height:number}} Cast rect in actor coords
 */
export function shadowCastRectForBody(bodySize, insets, scale = 1.0) {
    const body = clipFrameFor(bodySize, insets, scale, ZERO_PHASE);
    return {
        x: body.x,
        y: body.y,
        width: body.width + SHADOW_PAD * 2,
        height: body.height + SHADOW_PAD * 2,
    };
}

/**
 * Computes the cast rect from actor live size by snapping the body frame and expanding by SHADOW_PAD.
 *
 * The cast's hole is the clip's frame edge: both call `clipFrameFor` on the same body, so the two
 * are one expression rather than two derivations that happen to agree. The phase is deliberately
 * `ZERO_PHASE` here - the shadow actor carries it as a translation (`_syncTranslation`), which
 * keeps the cast actor-local for drag invariance; only the translation can supply the correction.
 *
 * @param {{width: number, height: number}} actorSize - Shadow actor's live size in px
 * @param {import('../lib/frame.js').Insets} [insets] - Ring the client declared, per side
 * @param {number} [scale=1.0] - Physical scale factor
 * @returns {{x:number,y:number,width:number,height:number}} Cast rect in actor coords
 */
export function shadowCastRect(actorSize, insets, scale = 1.0) {
    return shadowCastRectForBody({
        width: actorSize.width - SHADOW_PAD * 2,
        height: actorSize.height - SHADOW_PAD * 2,
    }, insets, scale);
}

/**
 * Builds the WARNING text for a shadow box that no longer describes the clip's body, or null.
 *
 * The clip's body authority is `resolveClipSize(targetRead, windowActorRead)` - the same call the
 * clip's paint makes, so this is a check of the shadow against the cut it must line up with, not
 * against the shadow itself. The shadow's box is bound to the window actor, so on a healthy
 * window the authority and the box agree; a client focus/refocus hack can resize the actor against
 * the surface container for a moment, the cut stays on the container, and the shadow's right band
 * shrinks - the transient that used to be silent. The text names the authority and the shadow box
 * (plus the window actor when it is known) so a journalctl hit identifies which side moved.
 *
 * @param {{width:number,height:number}|null} authority - The clip's resolved body
 * @param {{width:number,height:number}|null} shadowBox - The shadow actor's live box
 * @param {{width:number,height:number}|null} [windowActorBox] - The window actor's live box
 * @returns {string|null} Warning text, or null when they agree within SHADOW_BODY_TOLERANCE
 */
export function shadowBodyWarning(authority, shadowBox, windowActorBox = null) {
    if (!authority || !shadowBox)
        return null;
    const bodyWidth = shadowBox.width - SHADOW_PAD * 2;
    const bodyHeight = shadowBox.height - SHADOW_PAD * 2;
    if (Math.abs(authority.width - bodyWidth) <= SHADOW_BODY_TOLERANCE &&
        Math.abs(authority.height - bodyHeight) <= SHADOW_BODY_TOLERANCE)
        return null;

    const actor = windowActorBox
        ? ` (window actor ${round2(windowActorBox.width)}x${round2(windowActorBox.height)})`
        : '';
    return `[window-nativizer] Shadow body authority ${round2(authority.width)}x${round2(authority.height)} ` +
        `disagrees with the shadow box ${round2(shadowBox.width)}x${round2(shadowBox.height)}${actor} ` +
        `by more than ${SHADOW_BODY_TOLERANCE}px`;
}

/**
 * Whether a fresh clip-target read differs from the one the shadow last laid out from, so the
 * caller must schedule another layout.
 *
 * The shadow's body authority is the target's *read*, not its identity. A surface container
 * resized in place keeps the same object and hands the shadow a different extent, so comparing
 * only the reference (the original `setClipTarget` did) leaves the cast on the previous read. The
 * shadow's own box is bound to the window actor and does not move for a container-only resize, so
 * no other signal schedules the repaint either: the manager's `notify::allocation` watch re-runs
 * `apply()`, but every setter on the shadow early-returns when its input is unchanged. An unknown
 * read (the actor is gone or its size threw) is itself a change from a known one, so a torn-down
 * target still schedules the layout that falls back through `resolveClipSize`.
 *
 * @param {object|null} previousTarget - The target object the shadow last used
 * @param {object|null} nextTarget - The target object this pass resolved
 * @param {{width:number,height:number}|null} previousSize - The size read from `previousTarget`
 * @param {{width:number,height:number}|null} nextSize - The size read from `nextTarget`
 * @returns {boolean}
 */
export function clipTargetReadChanged(previousTarget, nextTarget, previousSize, nextSize) {
    if (previousTarget !== nextTarget)
        return true;
    if (!previousSize || !nextSize)
        return Boolean(previousSize) !== Boolean(nextSize);
    return previousSize.width !== nextSize.width || previousSize.height !== nextSize.height;
}

/**
 * @param {number} value
 * @returns {number}
 */
function round2(value) {
    return Math.round(value * 100) / 100;
}

/**
 * The shadow actor's translation for a window actor: the window actor's own translation plus the
 * subpixel offset, so the shadow keeps the window's animation while its cutout lands on the same
 * physical phase as the buffer. `ShadowActor._syncGeometry` writes this, then assigns only the
 * axes that moved; keeping the composition here lets it be asserted without a Clutter actor.
 *
 * @param {{translation_x?: number, translation_y?: number}} windowActor
 * @param {{x: number, y: number}} offset - Subpixel phase the shadow cuts on
 * @returns {{x: number, y: number}}
 */
export function shadowTranslation(windowActor, offset) {
    return {
        x: (windowActor?.translation_x ?? 0) + offset.x,
        y: (windowActor?.translation_y ?? 0) + offset.y,
    };
}

/**
 * The shadow actor's layout position for a window actor under a Clutter scale/pivot transform.
 *
 * SHADOW_PAD is baked into the shadow actor twice: its layout box is the window's frame expanded
 * by PAD, and its own local cutout starts PAD in from that box. At scale 1 the two cancel; under a
 * scale applied about a pivot they do not, because the layout offset is in parent space and the
 * local one is scaled by the actor's own transform. The transformed cutout then lands
 * `PAD * (1 - scale) * (1 - 2 * pivot)` away from the window's visual box - visible as bare
 * desktop through a MosaicWM-style miniaturise (scale 0.5, pivot 0 leaves half a pad).
 *
 * Deriving the layout position from the window actor's transform rather than from its layout box
 * cancels the two pads at any scale and pivot: the shadow expands about the same pivot as the
 * window, so the only term that has to move is its origin.
 *
 * @param {{x?, y?, scale_x?, scale_y?, pivot_point?}} windowActor
 * @param {number} [pad=SHADOW_PAD]
 * @returns {{x: number, y: number}} Layout position for the shadow actor
 */
export function shadowLayoutPosition(windowActor, pad = SHADOW_PAD) {
    const x = windowActor?.x ?? 0;
    const y = windowActor?.y ?? 0;
    const scaleX = windowActor?.scale_x ?? 1;
    const scaleY = windowActor?.scale_y ?? 1;
    const pivotX = windowActor?.pivot_point?.x ?? 0;
    const pivotY = windowActor?.pivot_point?.y ?? 0;
    return {
        x: x - pad * (scaleX + 2 * pivotX * (1 - scaleX)),
        y: y - pad * (scaleY + 2 * pivotY * (1 - scaleY)),
    };
}

/**
 * The subpixel phase the shadow must translate by, chosen by the same strategy as the clip.
 *
 * On the container path the clip's target carries the phase in its own transform and the clip's
 * local frame is phase-free, so the shadow reads that applied transform back with
 * `getAppliedSubpixelPhase` - one source for both cuts, so a drag cannot move one a frame before
 * the other and a reconstructed monitor cannot name a different monitor than Mutter's cached
 * pointer. On the fallback path the clip folds the mirrored phase into its own frame, so the
 * shadow must use the same mirror. The read is not authoritative for every frame: whenever it is
 * unavailable (non-Wayland, ambiguous container, non-unit matrix scale, or a throw) the mirror
 * is the documented fallback, exactly as on the fallback path.
 *
 * @param {object|null} win - Meta.Window behind the shadow's window actor
 * @param {boolean} phaseInTransform - The resolved clip target's strategy
 * @param {object|null} [St] - The St namespace the clip target path uses, for the fallback read
 * @returns {{x: number, y: number}|null} Phase, or null when neither source can answer; the
 *          caller keeps its last good phase so the shadow stays on the clip's line
 */
export function shadowPhaseOffset(win, phaseInTransform, St = null) {
    if (phaseInTransform) {
        const applied = getAppliedSubpixelPhase(win, St);
        if (applied)
            return applied;
    }
    return getWindowSubpixelOffset(win, St);
}

/**
 * 8 rects (4 corners 1:1, 4 edges stretched from 1px strip), no middle — hollow mask.
 *
 * Sizes are clamped to the non-negative axis: a window mid-resize can pass a degenerate
 * or transiently negative cast, and unclamped corner math would then emit slices whose
 * x1 > x2 (inverted texture coordinates) instead of an empty one.
 *
 * When the cast is narrower than two corners, the corner quads shrink to `c` - and what they
 * sample shrinks with them. Everything the bake encodes is positioned in bake px: the body's
 * SDF cutout, the arc, the Gaussian falloff. Sampling the whole corner into a smaller quad
 * scales all of it, so the cutout stops landing on the frame and the shadow pulls away from
 * the window. Measured on a 60x180 window (cast 116x236, c = 58 against a corner of 71): the
 * cutout, which belongs SHADOW_PAD in from the cast edge, came out 5px inside it, leaving a
 * white gap between the window and its shadow. Showing `c` bake px instead keeps the mapping
 * 1:1, so nothing baked moves.
 *
 * That never eats an arc: the decoration floor is the same inequality. `MIN_DECORABLE_SIZE`
 * (detector.js) starts a window at `2 * radius`, which puts the cast at `2 * radius +
 * 2 * SHADOW_PAD` = `2 * (SHADOW_PAD + radius)` - and `SHADOW_PAD + radius` is exactly how far
 * the arc reaches in from the cast edge, so `c` always covers it.
 *
 * @param {{corner:number,window:number,buffer:number}} geometry
 * @param {number} width - Padded rect width in px
 * @param {number} height - Padded rect height in px
 * @returns {Array<{x1:number,y1:number,x2:number,y2:number,s1:number,t1:number,s2:number,t2:number}>}
 */
export function shadowSlices({corner, window, buffer}, width, height) {
    const safeW = Math.max(0, width);
    const safeH = Math.max(0, height);
    const c = Math.max(0, Math.min(corner, safeW / 2, safeH / 2));
    const o = BAKE_ORIGIN;
    const near = o / buffer;
    const span = corner / buffer;
    const strip = 1 / buffer;
    const far = (buffer - corner - 1) / buffer;
    const edge = (o + SHADOW_PAD + window / 2) / buffer;
    const right = Math.max(c, safeW - c);
    const bottom = Math.max(c, safeH - c);

    // Bake px the corner shows: all of them when the cast is wide enough for both corners (which
    // is the only size the bake was sized for), `c` of them - the outer ones - when it is not.
    const shown = c / buffer;
    const innerNear = near + shown;
    const outerFar = far + span;
    const innerFar = outerFar - shown;

    return [
        {x1: 0, y1: 0, x2: c, y2: c, s1: near, t1: near, s2: innerNear, t2: innerNear},
        {x1: right, y1: 0, x2: safeW, y2: c, s1: innerFar, t1: near, s2: outerFar, t2: innerNear},
        {x1: 0, y1: bottom, x2: c, y2: safeH, s1: near, t1: innerFar, s2: innerNear, t2: outerFar},
        {x1: right, y1: bottom, x2: safeW, y2: safeH, s1: innerFar, t1: innerFar, s2: outerFar, t2: outerFar},
        {x1: c, y1: 0, x2: right, y2: c, s1: edge, t1: near, s2: edge + strip, t2: innerNear},
        {x1: c, y1: bottom, x2: right, y2: safeH, s1: edge, t1: innerFar, s2: edge + strip, t2: outerFar},
        {x1: 0, y1: c, x2: c, y2: bottom, s1: near, t1: edge, s2: innerNear, t2: edge + strip},
        {x1: right, y1: c, x2: safeW, y2: bottom, s1: innerFar, t1: edge, s2: outerFar, t2: edge + strip},
    ];
}

/**
 * Decides the shadow layout for one paint: the cast rect, the slices, the corner, plus
 * whether the cast moved enough to rebuild the slices, and the body authority it used.
 *
 * `bodySource` is the clip's own authority: the target's read and the window actor's read, fed
 * through `resolveClipSize` so the shadow and the clip agree on their body by construction. The
 * shadow's box is bound to the window actor and normally agrees with the target, so this is a
 * no-op there; when a focus/refocus hack parts them, the cast and the slices follow the clip's
 * body instead of the smaller box. Without `bodySource` (unit callers that own their box) the
 * body is the actor box minus SHADOW_PAD per side, today's behaviour.
 *
 * `style` carries the previous cast/slices/corner (absent on a fresh style), so the slice
 * rebuild only runs when the cast moved or the style is new - the cache policy `_relayout`
 * used to hold. The snapped quads are deliberately not here: only the caller knows whether
 * it is going to write boxes this paint, so it snaps them from the cast and corner returned.
 *
 * @param {{radius:number, cast?:object, slices?:Array<object>, corner?:number}} style
 * @param {{width:number, height:number}} actorSize - The shadow actor's live size in px
 * @param {import('../lib/frame.js').Insets} [insets] - Ring the client declared, per side
 * @param {number} [scale=1.0] - Physical scale factor
 * @param {{targetSize:object|null, windowActorSize:object|null}|null} [bodySource] - The clip's authority
 * @returns {{cast:object, slices:Array<object>, corner:number, castChanged:boolean, authority:object|null}}
 */
export function shadowLayout(style, actorSize, insets, scale = 1.0, bodySource = null) {
    const authority = bodySource
        ? resolveClipSize(bodySource.targetSize, bodySource.windowActorSize)
        : null;
    const cast = authority
        ? shadowCastRectForBody(authority, insets, scale)
        : shadowCastRect(actorSize, insets, scale);
    const previous = style.cast;
    const castChanged = !previous ||
        previous.x !== cast.x || previous.y !== cast.y ||
        previous.width !== cast.width || previous.height !== cast.height;

    let slices = style.slices;
    let corner = style.corner;
    if (castChanged || !slices) {
        const geometry = shadowGeometry(style.radius);
        slices = shadowSlices(geometry, cast.width, cast.height);
        corner = geometry.corner;
    }

    return {cast, slices, corner, castChanged, authority};
}
