/**
 * Property tests for the pure geometry/rules math (jasmine-gjs).
 *
 * These fuzz the invariants that the review found by hand - ordered slices, a body that fits
 * its actor, bands inside their monitor, a snapped rect that never inverts - across a wide
 * input space instead of a handful of examples. The PRNG is seeded, so a failure is
 * reproducible. Run: pnpm test
 */

import {
    SnapDirection,
    snapCoordToGrid,
    snapRectToGrid,
    snapSliceBoxesInto,
} from '../src/lib/snap.js';
import {bodyFrame, frameFromInsets, insetsFromRects} from '../src/lib/frame.js';
import {shadowGeometry, shadowSlices, SHADOW_PAD} from '../src/effects/shadowGeometry.js';
import {EFFECT_PADDING_EXTRA} from '../src/lib/clutterEffectPadding.generated.js';
import {
    RESIZE_BAND,
    RESIZE_BAND_REGIONS,
    computeResizeBands,
    edgeForPoint,
    normalizeConstrainedEdges,
} from '../src/lib/resizeBand.js';
import {buildRuleState, kindId, resolveRule, sameKind, sanitizeRules} from '../src/lib/rules.js';

const ITER = 400;
const EPS = 1e-9;

/** mulberry32: small, fast, deterministic. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const range = (rng, lo, hi) => lo + rng() * (hi - lo);
const pick = (rng, xs) => xs[Math.floor(rng() * xs.length)];
const finite = v => typeof v === 'number' && Number.isFinite(v);

const GOOD_SCALES = [0.5, 1, 1.25, 1.5, 2, 3];
const BAD_SCALES = [0, -1, -0.5, NaN, Infinity, -Infinity];

function makeBox() {
    return {
        x1: 0, y1: 0, x2: 0, y2: 0,
        init(x1, y1, x2, y2) {
            this.x1 = x1; this.y1 = y1; this.x2 = x2; this.y2 = y2;
        },
    };
}

describe('property: snap', () => {
    it('snaps within half a device pixel and is idempotent', () => {
        const rng = mulberry32(0x51a9);
        for (let i = 0; i < ITER; i++) {
            const value = range(rng, -2000, 2000);
            const scale = pick(rng, GOOD_SCALES);
            const dir = pick(rng, [SnapDirection.ROUND, SnapDirection.FLOOR, SnapDirection.CEIL]);
            const out = snapCoordToGrid(value, scale, dir);

            expect(finite(out)).toBeTrue();
            if (dir === SnapDirection.ROUND)
                expect(Math.abs(out - value)).toBeLessThanOrEqual(0.5 / scale + EPS);
            expect(Math.abs(snapCoordToGrid(out, scale, dir) - out)).toBeLessThanOrEqual(EPS);
        }
    });

    it('passes the input through unchanged for an unusable scale', () => {
        for (const scale of BAD_SCALES)
            expect(snapCoordToGrid(12.345, scale)).toBe(12.345);
    });

    it('never inverts a rect for a usable scale', () => {
        const rng = mulberry32(0x2ec7);
        for (let i = 0; i < ITER; i++) {
            const rect = {
                x: range(rng, -1000, 1000),
                y: range(rng, -1000, 1000),
                width: range(rng, 0, 800),
                height: range(rng, 0, 800),
            };
            const out = snapRectToGrid(rect, pick(rng, GOOD_SCALES));
            expect(out.width).toBeGreaterThanOrEqual(0);
            expect(out.height).toBeGreaterThanOrEqual(0);
            expect(finite(out.x)).toBeTrue();
            expect(finite(out.y)).toBeTrue();
        }
    });

    it('keeps all 8 slice boxes ordered and finite for any cast, corner and scale', () => {
        const rng = mulberry32(0xc0ffee);
        for (let i = 0; i < ITER; i++) {
            const cast = {
                x: range(rng, -300, 300),
                y: range(rng, -300, 300),
                width: range(rng, -50, 900),
                height: range(rng, -50, 900),
            };
            const corner = range(rng, 0, 150);
            const scale = pick(rng, [...GOOD_SCALES, ...BAD_SCALES]);
            const boxes = Array.from({length: 8}, makeBox);

            snapSliceBoxesInto(boxes, cast, corner, scale);

            for (const b of boxes) {
                expect(b.x1).toBeLessThanOrEqual(b.x2);
                expect(b.y1).toBeLessThanOrEqual(b.y2);
                expect(finite(b.x1) && finite(b.y1) && finite(b.x2) && finite(b.y2)).toBeTrue();
            }
        }
    });
});

describe('property: frame', () => {
    it('bodyFrame never exceeds the actor and never goes negative', () => {
        const rng = mulberry32(0x5eed);
        for (let i = 0; i < ITER; i++) {
            const size = {width: range(rng, 0, 1000), height: range(rng, 0, 1000)};
            const insets = {
                left: range(rng, 0, 250),
                top: range(rng, 0, 250),
                right: range(rng, 0, 250),
                bottom: range(rng, 0, 250),
            };
            const body = bodyFrame(size, insets);

            expect(body.width).toBeGreaterThanOrEqual(0);
            expect(body.height).toBeGreaterThanOrEqual(0);
            expect(body.width).toBeLessThanOrEqual(size.width + EPS);
            expect(body.height).toBeLessThanOrEqual(size.height + EPS);
            expect(body.x).toBeGreaterThanOrEqual(0);
            expect(body.y).toBeGreaterThanOrEqual(0);
            expect(body.x + body.width).toBeLessThanOrEqual(size.width + EPS);
            expect(body.y + body.height).toBeLessThanOrEqual(size.height + EPS);
        }
    });

    it('frameFromInsets places the body inside the actor for non-negative insets', () => {
        const rng = mulberry32(0xf00d);
        for (let i = 0; i < ITER; i++) {
            const size = {width: range(rng, 0, 1000), height: range(rng, 0, 1000)};
            const insets = {
                left: range(rng, 0, 100), top: range(rng, 0, 100),
                right: range(rng, 0, 100), bottom: range(rng, 0, 100),
            };
            const frame = frameFromInsets(size, insets);
            expect(frame.x + frame.width).toBeLessThanOrEqual(size.width + EPS);
            expect(frame.y + frame.height).toBeLessThanOrEqual(size.height + EPS);
        }
    });

    it('insetsFromRects is null or all non-negative', () => {
        const rng = mulberry32(0xabcd);
        for (let i = 0; i < ITER; i++) {
            const buffer = {
                x: range(rng, -200, 200), y: range(rng, -200, 200),
                width: range(rng, -20, 800), height: range(rng, -20, 800),
            };
            const frame = {
                x: range(rng, -300, 300), y: range(rng, -300, 300),
                width: range(rng, -20, 800), height: range(rng, -20, 800),
            };
            const insets = insetsFromRects(buffer, frame);
            if (insets === null)
                continue;
            for (const value of Object.values(insets))
                expect(value).toBeGreaterThanOrEqual(0);
        }
    });
});

describe('property: shadowGeometry', () => {
    it('slices stay ordered and their texture coords stay in [0,1]', () => {
        const rng = mulberry32(0x5ad0);
        for (let i = 0; i < ITER; i++) {
            const radius = range(rng, 0, 200);
            const geometry = shadowGeometry(radius);
            expect(geometry.corner).toBeGreaterThan(0);
            expect(geometry.window).toBe(2 * (geometry.corner - SHADOW_PAD));
            expect(geometry.buffer).toBeGreaterThan(geometry.window);
            expect(geometry.buffer).toBe(2 * geometry.corner + EFFECT_PADDING_EXTRA);

            const boxes = shadowSlices(geometry, range(rng, -30, 1200), range(rng, -30, 1200));
            expect(boxes.length).toBe(8);
            for (const b of boxes) {
                expect(b.x1).toBeLessThanOrEqual(b.x2);
                expect(b.y1).toBeLessThanOrEqual(b.y2);
                expect(b.s1).toBeLessThanOrEqual(b.s2);
                expect(b.t1).toBeLessThanOrEqual(b.t2);
                for (const s of [b.s1, b.s2, b.t1, b.t2]) {
                    expect(s).toBeGreaterThanOrEqual(0);
                    expect(s).toBeLessThanOrEqual(1);
                }
            }
        }
    });
});

describe('property: resizeBand', () => {
    it('gives no band for an unusable scale', () => {
        for (const scale of BAD_SCALES) {
            const bands = computeResizeBands({frame: {x: 0, y: 0, width: 100, height: 100}, scale});
            for (const region of RESIZE_BAND_REGIONS)
                expect(bands[region]).toBeNull();
        }
    });

    it('every band is finite, positive-sized and inside the monitor bounds', () => {
        const rng = mulberry32(0xbeef);
        for (let i = 0; i < ITER; i++) {
            const frame = {
                x: range(rng, -500, 500), y: range(rng, -500, 500),
                width: range(rng, 0, 1500), height: range(rng, 0, 1500),
            };
            const bounds = {
                x: range(rng, -200, 200), y: range(rng, -200, 200),
                width: range(rng, 1, 3000), height: range(rng, 1, 3000),
            };
            const bands = computeResizeBands({frame, bounds, scale: pick(rng, [1, 1.25, 2])});

            for (const region of RESIZE_BAND_REGIONS) {
                const b = bands[region];
                if (!b)
                    continue;
                expect(b.width).toBeGreaterThan(0);
                expect(b.height).toBeGreaterThan(0);
                expect(finite(b.x) && finite(b.y)).toBeTrue();
                expect(b.x).toBeGreaterThanOrEqual(bounds.x - EPS);
                expect(b.y).toBeGreaterThanOrEqual(bounds.y - EPS);
                expect(b.x + b.width).toBeLessThanOrEqual(bounds.x + bounds.width + EPS);
                expect(b.y + b.height).toBeLessThanOrEqual(bounds.y + bounds.height + EPS);
            }
        }
    });

    it('a point strictly inside the body has no resize direction', () => {
        const rng = mulberry32(0x1234);
        for (let i = 0; i < ITER; i++) {
            const frame = {
                x: range(rng, -300, 300), y: range(rng, -300, 300),
                width: range(rng, 20, 800), height: range(rng, 20, 800),
            };
            const x = range(rng, frame.x + 1, frame.x + frame.width - 1);
            const y = range(rng, frame.y + 1, frame.y + frame.height - 1);
            expect(edgeForPoint(frame, x, y)).toBeNull();
        }
    });

    it('a point just outside the ring has no resize direction', () => {
        const rng = mulberry32(0x99a);
        for (let i = 0; i < ITER; i++) {
            const frame = {
                x: range(rng, -300, 300), y: range(rng, -300, 300),
                width: range(rng, 20, 800), height: range(rng, 20, 800),
            };
            // Far left of the band's outer reach.
            const x = frame.x - RESIZE_BAND - range(rng, 1, 500);
            const y = range(rng, frame.y, frame.y + frame.height);
            expect(edgeForPoint(frame, x, y)).toBeNull();
        }
    });

    it('a maximized axis constrains both of its edges', () => {
        expect(normalizeConstrainedEdges({maximizedHorizontally: true}))
            .toEqual({top: false, right: true, bottom: false, left: true});
        expect(normalizeConstrainedEdges({maximizedVertically: true}))
            .toEqual({top: true, right: false, bottom: true, left: false});
    });
});

describe('property: rules', () => {
    const rng = mulberry32(0xd15ea5e);
    const identities = ['wechat', 'Firefox', 'org.example.App', 'my app', 'window:5', 'a:b', '%odd%'];
    const states = [
        'corners', 'shadow', 'resize',
        'corners,shadow', 'corners,resize', 'shadow,resize', 'corners,shadow,resize',
    ];

    function randomKind(identity) {
        const allowsResize = pick(rng, [true, false]);
        return {
            identity,
            clientType: pick(rng, ['wayland', 'x11']),
            windowType: Math.floor(range(rng, 0, 4)),
            hasParent: pick(rng, [true, false]),
            allowsResize,
            attachedDialog: pick(rng, [true, false]),
            hasRing: pick(rng, [true, false]),
            hasSsd: pick(rng, [true, false]),
            width: allowsResize ? null : Math.floor(range(rng, 1, 500)),
            height: allowsResize ? null : Math.floor(range(rng, 1, 500)),
        };
    }

    function toRecord(kind, state) {
        return {
            identity: kind.identity,
            client_type: kind.clientType,
            window_type: kind.windowType,
            has_parent: kind.hasParent,
            allows_resize: kind.allowsResize,
            attached_dialog: kind.attachedDialog,
            has_ring: kind.hasRing,
            has_ssd: kind.hasSsd,
            width: kind.width ?? 0,
            height: kind.height ?? 0,
            state,
            title: '',
        };
    }

    it('a random kind and state survive sanitize -> resolve', () => {
        for (let i = 0; i < ITER; i++) {
            const k = randomKind(pick(rng, identities));
            const state = pick(rng, states);
            const rules = sanitizeRules([toRecord(k, state)]);

            expect(rules.length).toBe(1);
            expect(sameKind(rules[0].kind, k)).toBeTrue();
            expect(buildRuleState(resolveRule(k, rules))).toBe(state);
        }
    });

    it('kindId identifies a kind up to identity case and distinguishes its fields', () => {
        for (let i = 0; i < ITER; i++) {
            const k = randomKind(pick(rng, identities));
            const spelled = {...k, identity: k.identity.toUpperCase()};
            expect(kindId(k)).toBe(kindId(spelled));
            expect(sameKind(k, spelled)).toBeTrue();

            const changed = {...k, hasRing: !k.hasRing};
            expect(kindId(changed)).not.toBe(kindId(k));
            expect(sameKind(k, changed)).toBeFalse();
        }
    });

    it('a no-op state is dropped, so resolve never sees it', () => {
        const k = randomKind('wechat');
        expect(sanitizeRules([toRecord(k, '')])).toEqual([]);
        expect(resolveRule(k, [])).toBeNull();
    });
});
