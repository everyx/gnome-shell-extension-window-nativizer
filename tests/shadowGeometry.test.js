/**
 * Shadow geometry unit tests: slice ordering under degenerate window sizes (jasmine-gjs).
 * Run: pnpm test
 */

import {shadowCastRect, shadowGeometry, shadowLayout, shadowSlices, SHADOW_PAD} from '../src/effects/shadowGeometry.js';
import {snapActorBodyFrame} from '../src/lib/snap.js';
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

});
