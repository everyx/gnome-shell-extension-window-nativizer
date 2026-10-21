/**
 * Shadow geometry unit tests: slice ordering under degenerate window sizes (jasmine-gjs).
 * Run: pnpm test
 */

import {clipTargetReadChanged, settleUndecided, shadowBodyWarning, shadowCastRect, shadowGeometry, shadowLayout, shadowPhaseOffset, shadowSlices, shadowTranslation, SHADOW_BODY_TOLERANCE, SHADOW_PAD}
    from '../src/effects/shadowGeometry.js';
import {clipFrameFor, snapActorBodyFrame, snapSliceRects} from '../src/lib/snap.js';
import {FLAT_SAFE_INSET} from '../src/lib/frame.js';
import {getAppliedSubpixelPhase, getWindowSubpixelOffset} from '../src/platform/window.js';
import {resolveClipPhase} from '../src/lib/clipTarget.js';
import {ADWAITA_STYLE} from '../src/lib/adwaitaStyle.generated.js';
import {checkDecorationEligibility} from '../src/lib/detector.js';

describe('shadowGeometry', () => {
    it('sizes the bake buffer from pad, radius and the Cogl offscreen padding', () => {
        const {corner, window, buffer} = shadowGeometry(12);
        expect(corner).toBe(2 * SHADOW_PAD + 12);
        expect(window).toBe(2 * (SHADOW_PAD + 12));
        expect(buffer).toBeGreaterThan(window);
    });

    it('guarantees seamless texture coordinate continuity at slice junctions', () => {
        const geometry = shadowGeometry(15);
        const slices = shadowSlices(geometry, 800, 600);
        // At the junction between corner and edge slices, texture coordinates meet at
        // the settled midpoint (edge), guaranteeing C0 continuity across quads
        expect(slices[0].s2).toBeCloseTo(slices[4].s1, 6);
        expect(slices[1].s1).toBeCloseTo(slices[4].s1, 6);
        expect(slices[2].s2).toBeCloseTo(slices[5].s1, 6);
        expect(slices[3].s1).toBeCloseTo(slices[5].s1, 6);

        expect(slices[0].t2).toBeCloseTo(slices[6].t1, 6);
        expect(slices[2].t1).toBeCloseTo(slices[6].t1, 6);
        expect(slices[1].t2).toBeCloseTo(slices[7].t1, 6);
        expect(slices[3].t1).toBeCloseTo(slices[7].t1, 6);
    });
});

describe('shadowCastRect', () => {
    const buffer = {width: 400, height: 300};
    // The shadow actor is bound to the buffer 2*PAD larger, so this is its live size.
    const actorSize = {width: buffer.width + SHADOW_PAD * 2, height: buffer.height + SHADOW_PAD * 2};
    const ring = (left, top, right, bottom) => ({left, top, right, bottom});

    it('leaves a hollow middle exactly the frame, for any declared ring', () => {
        const rings = [
            ring(0, 0, 0, 0),
            ring(25, 25, 25, 25),
            ring(SHADOW_PAD, SHADOW_PAD, SHADOW_PAD, SHADOW_PAD),
            ring(115, 115, 115, 115),
            ring(0, 24, 0, 24),
        ];
        for (const declared of rings) {
            const cast = shadowCastRect(actorSize, declared);
            // The eight slices leave the body hollow SHADOW_PAD in from every cast edge.
            const hollow = {
                x: cast.x + SHADOW_PAD,
                y: cast.y + SHADOW_PAD,
                width: cast.width - SHADOW_PAD * 2,
                height: cast.height - SHADOW_PAD * 2,
            };
            // The body the clip draws, moved into the shadow actor's coordinates: the actor is
            // bound to the window actor SHADOW_PAD out, so the body sits SHADOW_PAD in from zero.
            const body = snapActorBodyFrame(buffer, declared, 1);
            const frameInActor = {
                x: body.x + SHADOW_PAD,
                y: body.y + SHADOW_PAD,
                width: body.width,
                height: body.height,
            };
            expect(hollow).withContext(`ring ${JSON.stringify(declared)}`).toEqual(frameInActor);
        }
    });

    it('falls back to the whole actor, exactly like the clip, when the ring outruns the buffer', () => {
        // The inset is debounced and the actor is not, so a shrinking window can carry a ring its
        // buffer no longer holds. The clip falls back to the whole buffer there; the cast has to
        // fall back to the whole padded actor, or the shadow would hug a body the clip does not
        // draw - the one case where deriving the two from different rects still shows.
        const small = {width: 20, height: 100};
        const smallActor = {width: small.width + SHADOW_PAD * 2, height: small.height + SHADOW_PAD * 2};
        const declared = ring(30, 30, 30, 30);
        const body = snapActorBodyFrame(small, declared, 1);
        expect(body).toEqual({x: 0, y: 0, width: small.width, height: small.height});
        expect(shadowCastRect(smallActor, declared)).toEqual({
            x: 0, y: 0,
            width: smallActor.width,
            height: smallActor.height,
        });
    });

    it('snaps cast rect symmetrically across physical fractional scales', () => {
        const declared = ring(25, 25, 25, 25);
        const scale = 1.3333333;
        const cast1x = shadowCastRect(actorSize, declared, 1.0);
        const cast133x = shadowCastRect(actorSize, declared, scale);
        expect(cast1x.width - SHADOW_PAD * 2).toBe(buffer.width - 50);

        // Hollow width matches physical integer margin subtraction divided by scale:
        const expectedPhysWidth = Math.round(buffer.width * scale) - 2 * Math.round(25 * scale);
        const actualPhysWidth = Math.round((cast133x.width - SHADOW_PAD * 2) * scale);
        expect(actualPhysWidth).toBe(expectedPhysWidth);
    });
});

describe('shadowTranslation', () => {
    // ShadowActor itself is not unit-reachable here: it extends Clutter.Actor, and the Clutter
    // typelib is not installed. Its _syncTranslation delegates the arithmetic to this pure
    // function, so this is the composition that the actor's translation is written from.
    it('puts the shadow at the window actor translation plus the subpixel offset', () => {
        expect(shadowTranslation({translation_x: 4, translation_y: -3}, {x: 0.25, y: -0.25}))
            .toEqual({x: 4.25, y: -3.25});
    });

    it('treats a missing window actor translation as zero', () => {
        expect(shadowTranslation({}, {x: 0.25, y: -0.25})).toEqual({x: 0.25, y: -0.25});
        expect(shadowTranslation(null, {x: 0.25, y: -0.25})).toEqual({x: 0.25, y: -0.25});
    });
});

describe('clip cut and shadow cutout share one physical edge', () => {
    const ring = (left, top, right, bottom) => ({left, top, right, bottom});

    // The shadow actor is bound to the window actor grown by SHADOW_PAD per side.
    const shadowActorFor = size => ({
        width: size.width + SHADOW_PAD * 2,
        height: size.height + SHADOW_PAD * 2,
    });

    // The phase the clip and the shadow actually resolve at a scale, read by walking the window
    // actor across one logical pixel. The surface container carries a non-zero layout offset so
    // the walk exercises the container term too. Integer scales contribute only zero.
    const phasesFor = scale => {
        const original = globalThis.global;
        const container = {x: 0.5, y: 0, width: 1920, height: 1080};
        const actor = {x: 0, y: 0, get_children: () => [container]};
        const win = {
            get_client_type: () => 0, // WAYLAND
            get_monitor: () => 0,
            get_compositor_private: () => actor,
            // A readable frame, so the scan answers a phase instead of treating the frame as
            // unreadable. Without it the walk only ever saw the mirror's unknown answer.
            get_frame_rect: () => ({x: 0, y: 0, width: 1920, height: 1080}),
        };
        globalThis.global = {
            display: {
                get_n_monitors: () => 1,
                get_monitor_scale: () => scale,
                get_monitor_geometry: () => ({x: 0, y: 0, width: 1920, height: 1080}),
            },
        };
        try {
            const seen = [];
            for (let x = 0; x < 8; x++) {
                actor.x = x;
                const phase = getWindowSubpixelOffset(win);
                if (!seen.some(s => Math.abs(s.x - phase.x) < 1e-9 && Math.abs(s.y - phase.y) < 1e-9))
                    seen.push(phase);
            }
            return seen;
        } finally {
            globalThis.global = original;
        }
    };

    it('lands the clip frame edge on the shadow hole edge at every phase', () => {
        const sizes = [
            {width: 400, height: 300},
            {width: 652, height: 502},
        ];
        const insetsCases = [
            ring(0, 0, 0, 0),
            FLAT_SAFE_INSET,
            ring(25, 25, 25, 25),
            ring(0, 24, 0, 24),
        ];
        const scales = [1.0, 1.25, 4 / 3, 2.0];
        let worst = 0;

        for (const size of sizes) {
            for (const insets of insetsCases) {
                for (const scale of scales) {
                    for (const phase of phasesFor(scale)) {
                        const clip = clipFrameFor(size, insets, scale, phase);
                        const cast = shadowCastRect(shadowActorFor(size), insets, scale);
                        // Shadow actor local -> window actor local: the bind constraint puts its
                        // origin SHADOW_PAD out, the hole sits SHADOW_PAD back in, and the actor
                        // translation carries the phase, so the PADs cancel and only the same
                        // phase the clip folded in is left. Both edges are the window actor's body.
                        const hole = {
                            x: cast.x + phase.x,
                            y: cast.y + phase.y,
                            right: cast.x + cast.width - SHADOW_PAD * 2 + phase.x,
                            bottom: cast.y + cast.height - SHADOW_PAD * 2 + phase.y,
                        };
                        const clipEdges = {x: clip.x, y: clip.y, right: clip.x + clip.width, bottom: clip.y + clip.height};
                        const context = `size ${size.width}x${size.height} insets ${JSON.stringify(insets)} ` +
                            `scale ${scale} phase ${JSON.stringify(phase)}`;
                        for (const edge of ['x', 'y', 'right', 'bottom']) {
                            const diff = Math.abs(clipEdges[edge] * scale - hole[edge] * scale);
                            worst = Math.max(worst, diff);
                            expect(diff).withContext(`${edge} ${context}`).toBeLessThanOrEqual(1e-6);
                        }
                    }
                }
            }
        }

        // One shared derivation: the disagreement is floating noise, not a physical fraction. A
        // one-physical-pixel tolerance could not see the third-of-a-pixel gap this fix closes.
        expect(worst).toBeLessThanOrEqual(1e-6);
    });
});

describe('shadowSlices', () => {
    const expectOrdered = boxes => {
        expect(boxes.length).toBe(8);
        for (const b of boxes) {
            expect(b.x1).toBeLessThanOrEqual(b.x2);
            expect(b.y1).toBeLessThanOrEqual(b.y2);
            expect(b.s1).toBeLessThanOrEqual(b.s2);
            expect(b.t1).toBeLessThanOrEqual(b.t2);
        }
    };

    it('keeps every slice ordered for degenerate and negative cast sizes', () => {
        for (const [w, h] of [[0, 0], [1, 1], [0, 50], [50, 0], [3, 2], [-5, -5], [4, -1]])
            expectOrdered(shadowSlices(shadowGeometry(12), w, h));
    });

    it('clamps the corner to half the smaller side so corners never cross', () => {
        const boxes = shadowSlices(shadowGeometry(100), 10, 4);
        // corner = min(pad+100, 10/2, 4/2) = 2
        expect(boxes[0].x2).toBe(2);
        expect(boxes[0].y2).toBe(2);
        // each corner meets its two edge strips with no gap and no overlap
        expect(boxes[0].x2).toBe(boxes[4].x1); // top-left corner -> top edge strip
        expect(boxes[0].y2).toBe(boxes[6].y1); // top-left corner -> left edge strip
        expect(boxes[1].x1).toBe(boxes[4].x2); // top edge strip -> top-right corner
        expect(boxes[2].y1).toBe(boxes[6].y2); // left edge strip -> bottom-left corner
    });

    it('places the four corners at their baked positions for a full-size window', () => {
        const {corner} = shadowGeometry(12);
        const boxes = shadowSlices(shadowGeometry(12), 400, 300);
        expect(boxes[0].x2).toBe(corner);
        expect(boxes[1].x1).toBe(400 - corner);
        expect(boxes[2].y1).toBe(300 - corner);
    });

    it('shows a narrow cast exactly as much of the corner as it draws, in bake px', () => {
        const {corner, buffer} = shadowGeometry(15);
        const cast = corner + 20;
        const c = cast / 2;
        const boxes = shadowSlices({corner, window: 2 * (SHADOW_PAD + 15), buffer}, cast, 400);

        // The quad is smaller than the bake's corner...
        expect(boxes[0].x2).toBeCloseTo(c, 6);
        // ...and samples that many bake px of it, so the mapping is 1:1 and the cutout, the arc
        // and the falloff all stay where the bake put them.
        expect((boxes[0].s2 - boxes[0].s1) * buffer).toBeCloseTo(c, 6);
        expect((boxes[0].t2 - boxes[0].t1) * buffer).toBeCloseTo(c, 6);
        // The far corner mirrors it from the other end of the bake.
        expect((boxes[3].s2 - boxes[3].s1) * buffer).toBeCloseTo(c, 6);
        expect((boxes[3].t2 - boxes[3].t1) * buffer).toBeCloseTo(c, 6);
    });

    it('keeps the arc inside what a corner shows, at every size the detector decorates', () => {
        // The two constants the shadow's correctness rests on - the size a window starts being
        // decorated at, and how far the arc reaches in from the cast edge - are the same
        // inequality: 2*radius + 2*SHADOW_PAD == 2*(SHADOW_PAD + radius). Read the floor off the
        // detector rather than restating it, so lowering it here would fail this test rather than
        // silently cutting the arc off the window's corners.
        const radius = ADWAITA_STYLE.window.radius;
        const {corner, buffer} = shadowGeometry(radius);
        const arcReach = SHADOW_PAD + radius;
        let floor = 1;
        // No latched initial size, so the floor read here is the geometric one the cast is built
        // on: the visual floor only ever raises the size a window carries its decoration at.
        while (!checkDecorationEligibility({frameWidth: floor, frameHeight: floor}).eligible)
            floor++;

        for (let frame = floor; frame <= 2 * corner; frame++) {
            const cast = frame + SHADOW_PAD * 2;
            const boxes = shadowSlices({corner, window: 2 * arcReach, buffer}, cast, 400);
            const shown = (boxes[0].s2 - boxes[0].s1) * buffer;
            expect(shown).withContext(`frame ${frame}`).toBeCloseTo(Math.min(corner, cast / 2), 6);
            expect(shown).withContext(`frame ${frame}`).toBeGreaterThanOrEqual(arcReach - 1e-6);
        }
    });
});

describe('shadowLayout', () => {
    const zero = {left: 0, top: 0, right: 0, bottom: 0};
    // The actor is bound to the window actor grown by SHADOW_PAD per side.
    const actorFor = (width, height) => ({
        width: width + SHADOW_PAD * 2,
        height: height + SHADOW_PAD * 2,
    });

    it('returns the same geometry for the same style and size on a second paint', () => {
        const style = {radius: 12};
        const first = shadowLayout(style, actorFor(400, 300), zero, 1);
        // The actor stores the decision on the style; mimic that and run again.
        style.cast = Object.freeze(first.cast);
        style.slices = first.slices;
        style.corner = first.corner;

        const second = shadowLayout(style, actorFor(400, 300), zero, 1);
        expect(second.castChanged).toBe(false);
        expect(second.cast).toEqual(first.cast);
        expect(second.slices).toBe(first.slices);
        expect(second.corner).toBe(first.corner);
    });

    it('changes the cast and the slices when the actor size changes', () => {
        const style = {radius: 12};
        const first = shadowLayout(style, actorFor(400, 300), zero, 1);
        style.cast = Object.freeze(first.cast);
        style.slices = first.slices;
        style.corner = first.corner;

        const second = shadowLayout(style, actorFor(500, 300), zero, 1);
        expect(second.castChanged).toBe(true);
        expect(second.cast).not.toEqual(first.cast);
        expect(second.slices).not.toEqual(first.slices);
        expect(second.slices).toEqual(shadowSlices(shadowGeometry(12), second.cast.width, second.cast.height));
    });

    it('reuses the slice table when only the cast origin moves', () => {
        // The origin slides without a resize: both insets keep the same body width, so the slice
        // texture and corner are still correct and only the snapped positions change.
        const style = {radius: 12};
        const actor = actorFor(400, 300);
        const rightRing = {left: 0, top: 0, right: 10, bottom: 0};
        const leftRing = {left: 10, top: 0, right: 0, bottom: 0};
        const first = shadowLayout(style, actor, rightRing, 1);
        style.cast = Object.freeze(first.cast);
        style.slices = first.slices;
        style.corner = first.corner;

        const second = shadowLayout(style, actor, leftRing, 1);
        expect(second.castChanged).toBe(true);
        expect(second.cast.width).toBe(first.cast.width);
        expect(second.cast.x).not.toBe(first.cast.x);
        expect(second.slices).toBe(first.slices);
        expect(second.corner).toBe(first.corner);
    });

});

describe('shadow body authority (one body for the clip and the shadow)', () => {
    const zero = {left: 0, top: 0, right: 0, bottom: 0};
    // The actor box the bind constraint gives the shadow: the window actor grown by PAD a side.
    const boundShadowBox = body => ({
        width: body.width + SHADOW_PAD * 2,
        height: body.height + SHADOW_PAD * 2,
    });

    it('follows the clip authority even when the shadow box disagrees, right band included', () => {
        // The clip derives its body from resolveClipSize(target, windowActor). Force the
        // disagreement a client focus/refocus hack produced: a surface container wider than the
        // window actor while the shadow is still bound to the actor. Pre-fix the fifth argument was
        // ignored, the cast was derived from the smaller actor box, and the right strip of the
        // larger clip body went unpainted (28px reproduces the observed missing band).
        const windowBody = {width: 400, height: 300};
        const containerBody = {width: 428, height: 300};

        const layout = shadowLayout({radius: 12}, boundShadowBox(windowBody), zero, 1, {
            targetSize: containerBody,
            windowActorSize: windowBody,
            windowSize: windowBody,
            bodyPlan: null,
        });

        // The cast and its hole describe the authority body, not the bound box.
        const hole = {
            x: layout.cast.x + SHADOW_PAD,
            y: layout.cast.y + SHADOW_PAD,
            width: layout.cast.width - SHADOW_PAD * 2,
            height: layout.cast.height - SHADOW_PAD * 2,
        };
        expect(hole.width).toBe(containerBody.width);
        expect(hole.height).toBe(containerBody.height);
        expect(layout.cast.width).toBe(containerBody.width + SHADOW_PAD * 2);
        expect(layout.authority).toEqual(containerBody);

        // The snapped right band (slice 7) reaches the cast's right edge, so the PAD beyond the
        // body's right edge is painted rather than left as the missing strip.
        const rects = snapSliceRects(layout.cast, layout.corner, 1);
        const bodyRight = hole.x + hole.width;
        const castRight = layout.cast.x + layout.cast.width;
        expect(rects[7].x2).toBeCloseTo(castRight, 6);
        expect(rects[7].x1).toBeLessThanOrEqual(bodyRight);
        expect(rects[7].x2).toBeGreaterThanOrEqual(bodyRight);
    });

    it('carries the settle\'s verdict, so the warning can tell its work from a defect', () => {
        const zero2 = {left: 0, top: 0, right: 0, bottom: 0};
        // The observed e2e shape: the container trails after a resize, the window's own size confirms
        // the actor, so the settle acts on the actor. Decided, therefore not a defect to report.
        const decided = shadowLayout({radius: 12}, boundShadowBox({width: 700, height: 520}), zero2, 1, {
            targetSize: {width: 450, height: 300},
            windowActorSize: {width: 700, height: 520},
            windowSize: {width: 700, height: 520},
            bodyPlan: {previousBody: {width: 700, height: 520},
                previousAuthority: {width: 700, height: 520},
                previousWindowSize: {width: 700, height: 520}},
        });
        expect(decided.authority).toEqual({width: 450, height: 300});
        expect(decided.body).toEqual({width: 700, height: 520});
        expect(settleUndecided(decided.unsettled, decided.pairDisagreementStrikes)).toBeFalse();

        // Neither read is confirmed by the window's own size: the settle holds and says so.
        const undecided = shadowLayout({radius: 12}, boundShadowBox({width: 804, height: 600}), zero2, 1, {
            targetSize: {width: 796, height: 600},
            windowActorSize: {width: 804, height: 600},
            windowSize: {width: 800, height: 600},
            bodyPlan: {previousBody: {width: 800, height: 600},
                previousAuthority: {width: 800, height: 600},
                previousWindowSize: {width: 800, height: 600}},
        });
        expect(undecided.unsettled).toBeTrue();
        expect(settleUndecided(undecided.unsettled, undecided.pairDisagreementStrikes)).toBeTrue();
    });

    it('is a no-op when the container and the window actor agree', () => {
        const body = {width: 400, height: 300};
        const withAuthority = shadowLayout({radius: 12}, boundShadowBox(body), zero, 1, {
            targetSize: body,
            windowActorSize: body,
            windowSize: body,
        });
        const withoutAuthority = shadowLayout({radius: 12}, boundShadowBox(body), zero, 1);
        expect(withAuthority.cast).toEqual(withoutAuthority.cast);
        expect(withAuthority.slices).toEqual(withoutAuthority.slices);
    });

    it('keeps the previous cast while the target and actor disagree, then restores once the body stops moving', () => {
        const body = {width: 400, height: 300};
        const style = {radius: 12};
        // The actor is bound to the window body grown by PAD a side, so it follows the body.
        const shadowBoxFor = b => boundShadowBox(b);

        // A settled pass: the target and the window actor agree on the body.
        const first = shadowLayout(style, shadowBoxFor(body), zero, 1, {
            targetSize: body,
            windowActorSize: body,
            windowSize: body,
            bodyPlan: null,
        });
        style.cast = Object.freeze(first.cast);
        style.slices = first.slices;
        style.corner = first.corner;

        // The transient: the target reads 2px narrower than the window actor, so the plan holds
        // the previous body. The cast (and its hole, the clip's cut) does not follow the unsettled
        // read; the fresh authority is still returned for the warning. The window's own size is
        // still the previous one, so the pair disagreement is not read as a resize.
        const held = shadowLayout(style, shadowBoxFor(body), zero, 1, {
            targetSize: {width: 398, height: 300},
            windowActorSize: body,
            windowSize: body,
            bodyPlan: {previousBody: body, previousAuthority: body,
                previousWindowSize: body},
        });
        expect(held.body).toEqual(body);
        expect(held.cast).toEqual(first.cast);
        expect(held.castChanged).toBeFalse();
        expect(held.authority).toEqual({width: 398, height: 300});

        // The reads agree again on a 2px-wider body and the authority stops moving at that read:
        // the fresh body is acted on, so the deferral cannot latch to the held one.
        const restored = shadowLayout(style, shadowBoxFor(body), zero, 1, {
            targetSize: {width: 402, height: 300},
            windowActorSize: {width: 402, height: 300},
            windowSize: body,
            bodyPlan: {previousBody: body, previousAuthority: {width: 402, height: 300},
                previousWindowSize: body},
        });
        expect(restored.body).toEqual({width: 402, height: 300});
        expect(restored.cast).not.toEqual(first.cast);
    });

    it('follows the live window actor at every relayout while a drag is in flight', () => {
        // The paint-clock regression this change fixes: the body was settled once per debounced
        // pass and frozen, so between passes the cast trailed the actor the compositor was drawing
        // by up to ~8px. The plan is fixed for the pass, but the layout settles the body from the
        // live reads each time, so the cast tracks the actor at every frame.
        const style = {radius: 12};
        // One pass's plan: the reference points and the window's own size as of the previous pass.
        const plan = {
            previousBody: {width: 800, height: 600},
            previousAuthority: {width: 800, height: 600},
            previousWindowSize: {width: 800, height: 600},
        };
        const bodies = [802, 804, 806, 808];
        const targetReads = [800, 802, 804, 806];
        for (let i = 0; i < bodies.length; i++) {
            const windowActor = {width: bodies[i], height: 600};
            const container = {width: targetReads[i], height: 600};
            const layout = shadowLayout(style, boundShadowBox(windowActor), zero, 1, {
                targetSize: container,
                windowActorSize: windowActor,
                windowSize: windowActor,
                bodyPlan: plan,
            });
            const hole = layout.cast.width - SHADOW_PAD * 2;
            expect(hole).withContext(`relayout ${i}: live actor ${bodies[i]}`)
                .toBeCloseTo(windowActor.width, 0);
            expect(hole).withContext(`relayout ${i}: container ${targetReads[i]}`)
                .not.toBeCloseTo(container.width, 0);
        }
    });
});

describe('shadowBodyWarning (the body-authority invariant)', () => {
    const shadowBox = body => ({
        width: body.width + SHADOW_PAD * 2,
        height: body.height + SHADOW_PAD * 2,
    });

    it('names both extents with two decimals and the signed delta beyond the tolerance', () => {
        const warning = shadowBodyWarning(
            {width: 428, height: 300},
            shadowBox({width: 400, height: 300}),
            {width: 400, height: 300});
        expect(warning).toContain('Shadow body authority');
        // The compared shadow extent is the body, not the padded shadow box, and every extent
        // carries a decimal so a sub-pixel disagreement is visible rather than rounded to equal.
        expect(warning).toContain('428.00x300.00');
        expect(warning).toContain('400.00x300.00');
        expect(warning).toContain('by 28.00x0.00px');
    });

    it('stays silent when the authority and the body agree', () => {
        expect(shadowBodyWarning(
            {width: 400, height: 300},
            shadowBox({width: 400, height: 300}),
            {width: 400, height: 300})).toBeNull();
    });

    it('stays silent for a sub-pixel container/actor difference the old tolerance flagged', () => {
        // `buffer / scale` on a fractional monitor leaves a sub-pixel residue between the
        // container's logical body and the actor's integer allocation; it is not movement. 0.8px
        // sits below the 1px tolerance and above the old 0.5px one, so it pins the change.
        expect(shadowBodyWarning(
            {width: 400.8, height: 300},
            shadowBox({width: 400, height: 300}),
            {width: 400, height: 300})).toBeNull();
    });

    it('stays silent within the documented tolerance', () => {
        expect(shadowBodyWarning(
            {width: 400 + SHADOW_BODY_TOLERANCE, height: 300},
            shadowBox({width: 400, height: 300}),
            {width: 400, height: 300})).toBeNull();
    });

    it('fires on the 2px focus hand-off transient the tolerance must not hide', () => {
        const warning = shadowBodyWarning(
            {width: 398, height: 300},
            shadowBox({width: 400, height: 300}),
            {width: 400, height: 300});
        expect(warning).toContain('398.00x300.00');
        expect(warning).toContain('-2.00x0.00px');
    });

    it('stays silent when the authority is unknown', () => {
        expect(shadowBodyWarning(null, shadowBox({width: 400, height: 300}),
            {width: 400, height: 300})).toBeNull();
    });
});

describe('settleUndecided (when a disagreement is a fact about the window)', () => {
    it('is true while the settle holds its previous body', () => {
        expect(settleUndecided(true, 1)).toBeTrue();
        expect(settleUndecided(true, 0)).toBeTrue();
    });

    it('is true once the settle has spent its strikes and gave up on a confirmation', () => {
        expect(settleUndecided(false, 2)).toBeTrue();
        expect(settleUndecided(undefined, 3)).toBeTrue();
    });

    it('is false when the settle acted on the read the window own size confirmed', () => {
        // The two reads disagree, and the window's own size names the fresh one. The authority being
        // different is then the settle working, not a defect: this is the shape the e2e log audit saw.
        expect(settleUndecided(false, 0)).toBeFalse();
        expect(settleUndecided(undefined, 0)).toBeFalse();
    });
});

describe('clipTargetReadChanged (a changed target read schedules a relayout)', () => {
    const size = (width, height) => ({width, height});

    it('reports a resized container that keeps the same reference', () => {
        // The hole this predicate closes: a surface container resized in place hands the shadow a
        // new body while its own bound box never moves, so no other signal would repaint it.
        const container = {width: 400, height: 300};
        expect(clipTargetReadChanged(container, container, size(400, 300), size(428, 300))).toBeTrue();
        expect(clipTargetReadChanged(container, container, size(400, 300), size(400, 320))).toBeTrue();
    });

    it('reports nothing when the reference and the read both stand still', () => {
        const container = {width: 400, height: 300};
        expect(clipTargetReadChanged(container, container, size(400, 300), size(400, 300))).toBeFalse();
        expect(clipTargetReadChanged(null, null, null, null)).toBeFalse();
    });

    it('reports a changed reference even when the read is identical', () => {
        const first = {width: 400, height: 300};
        const second = {width: 400, height: 300};
        expect(clipTargetReadChanged(first, second, size(400, 300), size(400, 300))).toBeTrue();
        expect(clipTargetReadChanged(first, null, size(400, 300), null)).toBeTrue();
    });

    it('treats a read that became unknown as a change in both directions', () => {
        const container = {width: 400, height: 300};
        expect(clipTargetReadChanged(container, container, size(400, 300), null)).toBeTrue();
        expect(clipTargetReadChanged(container, container, null, size(400, 300))).toBeTrue();
    });
});

describe('shadowPhaseOffset (the shadow cuts on the clip target\'s phase source)', () => {
    /**
     * Installs a one-monitor display for the callback so the mirror resolves a known phase.
     * @param {number} scale
     * @param {Function} run
     * @returns {*}
     */
    function withDisplay(scale, run) {
        const original = globalThis.global;
        globalThis.global = {
            display: {
                get_n_monitors: () => 1,
                get_monitor_scale: () => scale,
                get_monitor_geometry: () => ({x: 0, y: 0, width: 1920, height: 1080}),
            },
        };
        try {
            return run();
        } finally {
            globalThis.global = original;
        }
    }

    const matrix = ({tx = 0, ty = 0, sx = 1, sy = 1} = {}) => ({
        get_x_translation: () => tx,
        get_y_translation: () => ty,
        get_x_scale: () => sx,
        get_y_scale: () => sy,
    });

    /**
     * A Wayland window whose surface container is the only non-foreign child and whose cached
     * transform carries `applied` as the phase Mutter applied (on top of the container's layout
     * origin). The displayed mirror phase comes from actor.x.
     * @param {number} scale
     * @param {number} actorX
     * @param {{x: number, y: number}} applied
     * @returns {object} The fake Meta.Window
     */
    function phaseWindow(scale, actorX, applied = null) {
        return withDisplay(scale, () => {
            const container = {x: 0, y: 0, width: 500, height: 400, translation_x: 0, translation_y: 0};
            if (applied) {
                container.get_transform = () => matrix({
                    tx: container.x + applied.x,
                    ty: container.y + applied.y,
                });
            }
            const actor = {x: actorX, y: 0, get_children: () => [container]};
            return {
                get_client_type: () => 0, // WAYLAND
                get_compositor_private: () => actor,
                get_frame_rect: () => ({x: 0, y: 0, width: 1920, height: 1080}),
            };
        });
    }

    it('reads back exactly the phase the mirror predicts when the transform carries it', () => {
        // The container path relies on the target's transform carrying the buffer phase; the read
        // must recover precisely that number, or both cuts move together to a wrong place.
        const scale = 1.25;
        withDisplay(scale, () => {
            const win = phaseWindow(scale, 241, {x: -0.2, y: 0});
            const mirror = getWindowSubpixelOffset(win);
            const applied = getAppliedSubpixelPhase(win);

            expect(mirror.x).toBeCloseTo(-0.2, 6);
            expect(applied.x).toBeCloseTo(mirror.x, 6);
            expect(applied.y).toBeCloseTo(mirror.y, 6);
            // The shadow's chosen source on the container path is that applied read.
            expect(shadowPhaseOffset(win, true)).toEqual(applied);
        });
    });

    it('uses the applied phase, not the mirror, when a drag has the two a frame apart', () => {
        // shadowPhaseOffset on the container path is the drift check: the transform is what was
        // painted and must win, even though the mirror reads a different (leading) value.
        const scale = 1.25;
        withDisplay(scale, () => {
            const win = phaseWindow(scale, 241, {x: 0.8, y: 0});
            const mirror = getWindowSubpixelOffset(win);

            expect(getAppliedSubpixelPhase(win)).toEqual({x: 0.8, y: 0});
            expect(shadowPhaseOffset(win, true)).toEqual({x: 0.8, y: 0});
            expect(mirror.x).not.toBeCloseTo(0.8, 6);

            // On the fallback path the clip folds the mirror into its frame, so the shadow keeps
            // the mirror too, even though a container transform is readable.
            expect(shadowPhaseOffset(win, false)).toEqual(mirror);
        });
    });

    it('falls back to the mirror when the applied read is unavailable', () => {
        // No get_transform (or a non-unit scale, ambiguous container, non-Wayland client): the
        // read answers null and the documented fallback is the mirror.
        const scale = 1.25;
        withDisplay(scale, () => {
            const win = phaseWindow(scale, 241);
            const mirror = getWindowSubpixelOffset(win);

            expect(getAppliedSubpixelPhase(win)).toBeNull();
            expect(shadowPhaseOffset(win, true)).toEqual(mirror);
            expect(shadowPhaseOffset(win, false)).toEqual(mirror);
        });
    });

    it('falls back to the mirror for a non-finite applied read', () => {
        // A half-torn-down container can hand back a NaN transform; it must not reach the actor.
        const scale = 1.25;
        withDisplay(scale, () => {
            const win = phaseWindow(scale, 241, {x: NaN, y: NaN});
            const mirror = getWindowSubpixelOffset(win);

            expect(getAppliedSubpixelPhase(win)).toBeNull();
            expect(shadowPhaseOffset(win, true)).toEqual(mirror);
        });
    });

    it('answers null when the fallback scan cannot read a monitor geometry', () => {
        // The mirror is the shadow's fallback source; an unreadable monitor geometry is unknown,
        // not zero, and the actor keeps its last good phase instead of translating by zero.
        const original = globalThis.global;
        globalThis.global = {
            display: {
                get_n_monitors: () => 1,
                get_monitor_scale: () => 1.25,
                get_monitor_geometry: () => null,
            },
        };
        try {
            const win = {
                get_client_type: () => 0, // WAYLAND
                get_compositor_private: () => ({x: 240, y: 0}),
                get_frame_rect: () => ({x: 0, y: 0, width: 1920, height: 1080}),
            };
            expect(getWindowSubpixelOffset(win)).toBeNull();
            expect(shadowPhaseOffset(win, false)).toBeNull();
        } finally {
            globalThis.global = original;
        }
    });

    it('keeps the clip and the shadow on one history phase across an unknown read and recovery', () => {
        // The clip folds the mirror into its frame and the shadow translates by it, each keeping
        // its own last good value (`_lastPhase` / `_lastOffset`). They stay on one line only while
        // both read the same source and both drop an unknown read. Drive that pair through a
        // failure and its recovery: after the failure both histories must hold the same
        // pre-failure phase (never a fabricated zero), and after recovery they must move together.
        const original = globalThis.global;
        const container = {x: 0, y: 0, width: 500, height: 400, translation_x: 0, translation_y: 0};
        const actor = {x: 241, y: 0, get_children: () => [container]};
        const win = {
            get_client_type: () => 0, // WAYLAND
            get_compositor_private: () => actor,
            get_frame_rect: () => ({x: 0, y: 0, width: 1920, height: 1080}),
        };
        // Both consumers' "keep the last good phase" rule, seeded with the same zero.
        let clipLast = {x: 0, y: 0};
        let shadowLast = {x: 0, y: 0};
        const step = () => {
            const clip = resolveClipPhase({phaseInTransform: false}, win);
            const shadow = shadowPhaseOffset(win, false);
            if (clip)
                clipLast = clip;
            if (shadow)
                shadowLast = shadow;
            return {clip, shadow};
        };
        const display = geometry => ({
            display: {
                get_n_monitors: () => 1,
                get_monitor_scale: () => 1.25,
                get_monitor_geometry: () => geometry,
            },
        });

        try {
            globalThis.global = display({x: 0, y: 0, width: 1920, height: 1080});
            const first = step();
            expect(first.clip).toEqual(getWindowSubpixelOffset(win));
            expect(first.shadow).toEqual(first.clip);
            expect(first.clip.x).toBeCloseTo(-0.2, 6);
            expect(clipLast).toEqual(shadowLast);

            // An unreadable monitor geometry: both reads answer null, so neither history records
            // it and both keep the same last good phase - never the fabricated zero.
            globalThis.global = display(null);
            const failed = step();
            expect(failed.clip).toBeNull();
            expect(failed.shadow).toBeNull();
            expect(clipLast).toEqual(first.clip);
            expect(shadowLast).toEqual(first.shadow);
            expect(clipLast).toEqual(shadowLast);
            expect(clipLast).not.toEqual({x: 0, y: 0});

            // The display recovers and the window has moved: both reads land on the new phase and
            // the two histories move together.
            globalThis.global = display({x: 0, y: 0, width: 1920, height: 1080});
            actor.x = 242;
            const recovered = step();
            expect(recovered.clip).toEqual(getWindowSubpixelOffset(win));
            expect(recovered.clip.x).toBeCloseTo(0.4, 6);
            expect(recovered.shadow).toEqual(recovered.clip);
            expect(clipLast).toEqual(recovered.clip);
            expect(shadowLast).toEqual(recovered.shadow);
            expect(clipLast).toEqual(shadowLast);
        } finally {
            globalThis.global = original;
        }
    });
});

describe('shadow slice destination span (one derivation from the UV span)', () => {
    // The corner/edge texture shows `c / buffer` of the bake (shadowSlices), so the destination
    // quad must span exactly `c` logical px. Snapping both cutlines on its own re-derived the
    // span, scaling the bake by up to ~0.6% instead of mapping 1:1: at 1.25x the corner came out
    // 71.2 px for a 71 px UV span, 71.33 at 1.5x and 71.43 at 1.75x. This pins the agreement and
    // would catch a regression to per-cutline snapping.
    const cornerSpanFor = (index, slices, rects, buffer, axis) => {
        const s = axis === 'x' ? [slices[index].s1, slices[index].s2] : [slices[index].t1, slices[index].t2];
        const r = axis === 'x' ? [rects[index].x1, rects[index].x2] : [rects[index].y1, rects[index].y2];
        return {uv: (s[1] - s[0]) * buffer, dest: r[1] - r[0]};
    };

    it('maps every corner span 1:1 across the scale matrix', () => {
        const geometry = shadowGeometry(ADWAITA_STYLE.window.radius);
        // Full-size casts only: below two corners the monotonic clamp in snapSliceRects can pull the
        // far cutline in to stop an inversion, which is a deliberate degenerate-size guard rather
        // than the rescale this spec pins (the crop for that case is covered in shadowSlices).
        const casts = [
            {x: 0.25, y: 0.2, width: 400, height: 300},
            {x: 12.4, y: -3.6, width: 652, height: 502},
        ];
        for (const cast of casts) {
            const slices = shadowSlices(geometry, cast.width, cast.height);
            for (const scale of [1.0, 1.25, 4 / 3, 1.5, 1.75, 2.0]) {
                const rects = snapSliceRects(cast, geometry.corner, scale);
                for (const index of [0, 1, 2, 3]) {
                    for (const axis of ['x', 'y']) {
                        const {uv, dest} = cornerSpanFor(index, slices, rects, geometry.buffer, axis);
                        expect(uv)
                            .withContext(`slice ${index} ${axis} cast ${JSON.stringify(cast)} scale ${scale}`)
                            .toBeCloseTo(dest, 6);
                    }
                }
            }
        }
    });
});
