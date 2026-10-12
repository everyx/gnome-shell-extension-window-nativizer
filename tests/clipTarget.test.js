/**
 * clipTarget unit tests: resolving clip target actor across native and foreign-injected windows (jasmine-gjs).
 * Run: pnpm test
 */

import {WindowClientType} from '../src/lib/mutterRules.generated.js';
import {
    clipFrameForTarget,
    getX11SurfaceChild,
    isForeignWidget,
    isCompatibleSurfaceGeometry,
    isIntegerAlignedSurfaceBox,
    resolveClipTarget,
} from '../src/lib/clipTarget.js';

const CLIP_SIZE = {width: 500, height: 400};
const CLIP_INSETS = {left: 8, top: 8, right: 8, bottom: 8};
const CLIP_SCALE = 1.25;

/**
 * Installs a one-monitor display at `scale` for the callback, so the subpixel phase
 * getWindowSubpixelOffset resolves is a known number.
 * @param {number} scale
 * @param {Function} run
 * @returns {*} The callback's return value
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

/**
 * A Wayland window whose surface container sits at local (0,0) so it is geometry-compatible by
 * default; the phase then comes from the window actor's stage position.
 * @param {{actorX?: number, container?: object, children?: Array<object>}} [options]
 * @returns {object}
 */
function phaseWindow({actorX = 0, container = {x: 0, y: 0, width: 500, height: 400}, children} = {}) {
    const actor = {x: actorX, y: 0, get_children: () => children ?? [container]};
    return {
        get_client_type: () => WindowClientType.WAYLAND,
        get_buffer_rect: () => ({x: 0, y: 0, width: 500, height: 400}),
        get_frame_rect: () => ({x: 0, y: 0, width: 500, height: 400}),
        get_compositor_private: () => actor,
    };
}

class MockStWidget {
    constructor(name = 'BlurActor') {
        this.name = name;
    }
}

class MockSurfaceActor {
    constructor(name = 'MetaSurfaceActor', {x = 0, y = 0, width = 500, height = 400} = {}) {
        this.name = name;
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;
    }
}

const mockSt = {
    Widget: MockStWidget,
};

function createMockActor({children = []} = {}) {
    return {
        name: 'MetaWindowActor',
        get_first_child: () => children[0] ?? null,
        get_children: () => children,
    };
}

function createMockWindow({clientType = WindowClientType.WAYLAND, buffer = {x: 0, y: 0, width: 500, height: 400}} = {}) {
    return {
        get_client_type: () => clientType,
        get_buffer_rect: () => buffer,
    };
}

describe('clipTarget', () => {
    describe('isForeignWidget', () => {
        it('returns false for null, undefined, or regular actors', () => {
            expect(isForeignWidget(null, mockSt)).toBe(false);
            expect(isForeignWidget(undefined, mockSt)).toBe(false);
            expect(isForeignWidget(new MockSurfaceActor(), mockSt)).toBe(false);
            expect(isForeignWidget({constructor: {name: 'MetaSurfaceActorWayland'}}, mockSt)).toBe(false);
        });

        it('detects MockStWidget instance via St namespace', () => {
            const widget = new MockStWidget();
            expect(isForeignWidget(widget, mockSt)).toBe(true);
        });

        it('detects widget via constructor name heuristic', () => {
            const stWidget = {constructor: {name: 'St_Widget'}};
            const stBin = {constructor: {name: 'StWidget'}};
            expect(isForeignWidget(stWidget)).toBe(true);
            expect(isForeignWidget(stBin)).toBe(true);
        });
    });

    describe('isIntegerAlignedSurfaceBox', () => {
        it('accepts integer boxes and rejects fractional or missing ones', () => {
            expect(isIntegerAlignedSurfaceBox({width: 500, height: 400})).toBe(true);
            expect(isIntegerAlignedSurfaceBox({width: 500.4, height: 400})).toBe(false);
            expect(isIntegerAlignedSurfaceBox({width: 500, height: 400.5})).toBe(false);
            expect(isIntegerAlignedSurfaceBox(null)).toBe(false);
            expect(isIntegerAlignedSurfaceBox({})).toBe(false);
        });
    });

    describe('isCompatibleSurfaceGeometry', () => {
        const win = createMockWindow({buffer: {x: 100, y: 100, width: 500, height: 400}});
        it('accepts candidate starting at (0, 0) matching buffer width and height', () => {
            const candidate = {x: 0, y: 0, width: 500, height: 400};
            expect(isCompatibleSurfaceGeometry(candidate, win)).toBe(true);
        });

        it('rejects a fractional x origin that would round to zero', () => {
            // 0.4 logical px is half a physical pixel at 1.25x: near zero is not zero here.
            const candidate = {x: 0.4, y: 0, width: 500, height: 400};
            expect(isCompatibleSurfaceGeometry(candidate, win)).toBe(false);
        });

        it('rejects a fractional negative y origin that would round to zero', () => {
            const candidate = {x: 0, y: -0.4, width: 500, height: 400};
            expect(isCompatibleSurfaceGeometry(candidate, win)).toBe(false);
        });

        it('still accepts float residue at the origin', () => {
            const candidate = {x: 1e-7, y: -1e-7, width: 500, height: 400};
            expect(isCompatibleSurfaceGeometry(candidate, win)).toBe(true);
        });

        it('rejects candidate with non-zero local origin offset', () => {
            const candidate = {x: 10, y: 0, width: 500, height: 400};
            expect(isCompatibleSurfaceGeometry(candidate, win)).toBe(false);
        });

        it('rejects candidate with mismatched dimensions', () => {
            const candidateWrongWidth = {x: 0, y: 0, width: 480, height: 400};
            const candidateWrongHeight = {x: 0, y: 0, width: 500, height: 380};
            expect(isCompatibleSurfaceGeometry(candidateWrongWidth, win)).toBe(false);
            expect(isCompatibleSurfaceGeometry(candidateWrongHeight, win)).toBe(false);
        });

        it('accepts candidate with unallocated dimensions (width/height 0)', () => {
            const candidateUnallocated = {x: 0, y: 0, width: 0, height: 0};
            expect(isCompatibleSurfaceGeometry(candidateUnallocated, win)).toBe(true);
        });

        it('accepts candidate when window buffer cannot be queried', () => {
            const winNoBuffer = {get_buffer_rect: () => null};
            const candidate = {x: 0, y: 0, width: 500, height: 400};
            expect(isCompatibleSurfaceGeometry(candidate, winNoBuffer)).toBe(true);
        });
    });

    describe('resolveClipTarget', () => {
        it('returns null if actor is missing', () => {
            const win = createMockWindow();
            expect(resolveClipTarget(win, null, mockSt)).toBeNull();
        });

        describe('Wayland surface container target (keeps the subpixel phase out of the FBO)', () => {
            it('returns the surface container, whose own transform carries the phase', () => {
                const win = createMockWindow({clientType: WindowClientType.WAYLAND});
                const surface = new MockSurfaceActor();
                const actor = createMockActor({children: [surface]});

                expect(resolveClipTarget(win, actor, mockSt))
                    .toEqual({actor: surface, phaseInTransform: true});
            });

            it('falls back to the window actor when the container geometry is incompatible', () => {
                const win = createMockWindow({clientType: WindowClientType.WAYLAND, buffer: {width: 500, height: 400}});
                const surfaceWithOffset = new MockSurfaceActor('MetaSurfaceContainerActorWayland', {x: 12, y: 12, width: 476, height: 376});
                const actor = createMockActor({children: [surfaceWithOffset]});

                expect(resolveClipTarget(win, actor, mockSt))
                    .toEqual({actor, phaseInTransform: false});
            });

            it('falls back to the window actor when the container box is not integer-aligned', () => {
                // Clutter's offscreen origin/size only equal the shader's FBO_OFFSET/FBO_EXTRA when the
                // actor box is integer-aligned; a fractional container width can move the origin by a
                // logical pixel, which the shader cannot express, so the clip must not attach to it.
                const win = createMockWindow({clientType: WindowClientType.WAYLAND, buffer: {width: 500, height: 400}});
                const fractional = new MockSurfaceActor('MetaSurfaceContainerActorWayland', {x: 0, y: 0, width: 500.4, height: 400});
                const actor = createMockActor({children: [fractional]});

                expect(resolveClipTarget(win, actor, mockSt))
                    .toEqual({actor, phaseInTransform: false});
            });

            it('falls back to the window actor when the container origin is a fractional offset', () => {
                // 0.4 logical px is half a physical pixel at 1.25x - the phase the two cuts are most
                // likely to part on. Rounding the origin to zero would accept it as aligned.
                const win = createMockWindow({clientType: WindowClientType.WAYLAND, buffer: {width: 500, height: 400}});
                const offset = new MockSurfaceActor('MetaSurfaceContainerActorWayland', {x: 0.4, y: 0, width: 500, height: 400});
                const actor = createMockActor({children: [offset]});

                expect(resolveClipTarget(win, actor, mockSt))
                    .toEqual({actor, phaseInTransform: false});
            });

            it('keeps the container when the buffer cannot be read (fail-open)', () => {
                const win = {get_client_type: () => WindowClientType.WAYLAND, get_buffer_rect: () => null};
                const surface = new MockSurfaceActor();
                const actor = createMockActor({children: [surface]});

                expect(resolveClipTarget(win, actor, mockSt))
                    .toEqual({actor: surface, phaseInTransform: true});
            });

            it('keeps the container when it has no allocation yet (fail-open)', () => {
                const win = createMockWindow({clientType: WindowClientType.WAYLAND, buffer: {width: 500, height: 400}});
                const unallocated = new MockSurfaceActor('MetaSurfaceContainerActorWayland', {width: 0, height: 0});
                const actor = createMockActor({children: [unallocated]});

                expect(resolveClipTarget(win, actor, mockSt))
                    .toEqual({actor: unallocated, phaseInTransform: true});
            });

            it('returns first child on XWayland when surface child exists', () => {
                const win = createMockWindow({clientType: WindowClientType.X11});
                const surface = new MockSurfaceActor();
                const actor = createMockActor({children: [surface]});

                expect(resolveClipTarget(win, actor, mockSt))
                    .toEqual({actor: surface, phaseInTransform: true});
            });

            it('falls back to window actor on XWayland when first child is missing', () => {
                const win = createMockWindow({clientType: WindowClientType.X11});
                const actor = createMockActor({children: []});

                expect(resolveClipTarget(win, actor, mockSt))
                    .toEqual({actor, phaseInTransform: false});
            });
        });

        describe('identification rule combinations (mirrors getSurfaceContainer)', () => {
            it('falls back to the window actor when more than one non-foreign child is present', () => {
                const win = createMockWindow({clientType: WindowClientType.WAYLAND});
                const surface = new MockSurfaceActor('MetaSurfaceContainerActorWayland');
                const background = new MockSurfaceActor('MetaBackgroundActor');
                const actor = createMockActor({children: [surface, background]});

                // Mutter adds extra non-foreign children (the fullscreen background actor), so the
                // container is only chosen when the tree is unambiguous.
                expect(resolveClipTarget(win, actor, mockSt))
                    .toEqual({actor, phaseInTransform: false});
            });

            it('falls back to the window actor when every child is foreign', () => {
                const win = createMockWindow({clientType: WindowClientType.WAYLAND});
                const actor = createMockActor({children: [new MockStWidget(), new MockStWidget()]});

                expect(resolveClipTarget(win, actor, mockSt))
                    .toEqual({actor, phaseInTransform: false});
            });
        });

        describe('Compatibility path (foreign St.Widget injected, e.g. Blur my Shell)', () => {
            it('bypasses blur widget and targets surface container on Wayland when geometry matches', () => {
                const win = createMockWindow({clientType: WindowClientType.WAYLAND, buffer: {width: 500, height: 400}});
                const blurWidget = new MockStWidget('BlurMyShellActor');
                const surfaceContainer = new MockSurfaceActor('MetaSurfaceContainerActorWayland', {x: 0, y: 0, width: 500, height: 400});
                const actor = createMockActor({children: [blurWidget, surfaceContainer]});

                expect(resolveClipTarget(win, actor, mockSt))
                    .toEqual({actor: surfaceContainer, phaseInTransform: true});
            });

            it('falls back to window actor on Wayland if surface container geometry is incompatible', () => {
                const win = createMockWindow({clientType: WindowClientType.WAYLAND, buffer: {width: 500, height: 400}});
                const blurWidget = new MockStWidget('BlurMyShellActor');
                // Surface has unexpected offset / padding
                const surfaceWithOffset = new MockSurfaceActor('MetaSurfaceContainerActorWayland', {x: 12, y: 12, width: 476, height: 376});
                const actor = createMockActor({children: [blurWidget, surfaceWithOffset]});

                // Incompatible coordinate space -> safe fallback to defaultTarget (actor)
                expect(resolveClipTarget(win, actor, mockSt))
                    .toEqual({actor, phaseInTransform: false});
            });

            it('bypasses blur widget and targets surface child on XWayland when geometry matches', () => {
                const win = createMockWindow({clientType: WindowClientType.X11, buffer: {width: 550, height: 487}});
                const blurWidget = new MockStWidget('BlurMyShellActor');
                const surfaceActor = new MockSurfaceActor('MetaSurfaceActorX11', {x: 0, y: 0, width: 550, height: 487});
                const actor = createMockActor({children: [blurWidget, surfaceActor]});

                expect(resolveClipTarget(win, actor, mockSt))
                    .toEqual({actor: surfaceActor, phaseInTransform: true});
            });

            it('gracefully falls back to the window actor if only foreign widgets are present', () => {
                const winWayland = createMockWindow({clientType: WindowClientType.WAYLAND});
                const blurWidget = new MockStWidget();
                const actorWayland = createMockActor({children: [blurWidget]});

                // On Wayland, default target is actor
                expect(resolveClipTarget(winWayland, actorWayland, mockSt))
                    .toEqual({actor: actorWayland, phaseInTransform: false});

                const winX11 = createMockWindow({clientType: WindowClientType.X11});
                const actorX11 = createMockActor({children: [blurWidget]});

                // On XWayland the default is the first non-foreign child; with only a foreign blur
                // widget present there is none, so the window actor is used. It must never be the
                // widget: attaching the clip to a plugin's actor loses the window's clip.
                expect(resolveClipTarget(winX11, actorX11, mockSt))
                    .toEqual({actor: actorX11, phaseInTransform: false});
            });

            it('never attaches the X11 clip to a foreign St.Widget when the surface actor is incompatible', () => {
                const win = createMockWindow({clientType: WindowClientType.X11, buffer: {width: 550, height: 487}});
                const blurWidget = new MockStWidget('BlurMyShellActor');
                // The real surface is present but mid-resize, so its geometry does not match the buffer.
                const surfaceMidResize = new MockSurfaceActor('MetaSurfaceActorX11', {x: 0, y: 0, width: 540, height: 480});
                const actor = createMockActor({children: [blurWidget, surfaceMidResize]});

                const target = resolveClipTarget(win, actor, mockSt);
                expect(target.actor).not.toBe(blurWidget);
                expect(target).toEqual({actor: surfaceMidResize, phaseInTransform: false});
            });

            it('skips a foreign first child and returns the plain surface child on X11', () => {
                const blurWidget = new MockStWidget();
                const surface = new MockSurfaceActor('MetaSurfaceActorX11');
                expect(getX11SurfaceChild(createMockActor({children: [blurWidget, surface]}), mockSt)).toBe(surface);
                expect(getX11SurfaceChild(createMockActor({children: [blurWidget]}), mockSt)).toBeNull();
            });
        });
    });

    describe('clipFrameForTarget (the actual frame the effect computes, per phase strategy)', () => {
        it('uses the plain snapped frame when the target carries the phase in its transform', () => {
            withDisplay(CLIP_SCALE, () => {
                const win = phaseWindow({actorX: 0.5});
                const target = resolveClipTarget(win, win.get_compositor_private(), mockSt);
                expect(target.phaseInTransform).toBe(true);

                // The container path ignores the window phase: the actor's own transform applies it
                // outside the offscreen FBO. 0.5 * 1.25 rounds to 1 physical px, so the phase would
                // be 0.3 logical px were it folded in - it is deliberately not.
                const frame = clipFrameForTarget(CLIP_SIZE, CLIP_INSETS, CLIP_SCALE, target, win);
                expect(frame).toEqual({x: 8, y: 8, width: 484, height: 384});
            });
        });

        it('folds the window subpixel offset when the target does not carry the phase', () => {
            withDisplay(CLIP_SCALE, () => {
                // A size-mismatched container still identifies the phase term for
                // getWindowSubpixelOffset, but fails the clip geometry check, so the clip falls back
                // to the window actor - the path that must fold the offset into its own geometry.
                const win = phaseWindow({
                    actorX: 0.5,
                    container: {x: 0, y: 0, width: 476, height: 376},
                });
                const target = resolveClipTarget(win, win.get_compositor_private(), mockSt);
                expect(target.phaseInTransform).toBe(false);

                // actor.x = 0.5, scale 1.25 -> 0.625 rounds to 1 -> 0.8 - 0.5 = 0.3 logical px.
                const frame = clipFrameForTarget(CLIP_SIZE, CLIP_INSETS, CLIP_SCALE, target, win);
                expect(frame.x).toBeCloseTo(8.3, 6);
                expect(frame.y).toBeCloseTo(8, 6);
                expect(frame.width).toBe(484);
                expect(frame.height).toBe(384);
            });
        });

        it('treats a missing target as the fallback path', () => {
            withDisplay(CLIP_SCALE, () => {
                const win = phaseWindow({actorX: 0.5});
                const frame = clipFrameForTarget(CLIP_SIZE, CLIP_INSETS, CLIP_SCALE, null, win);
                expect(frame.x).toBeCloseTo(8.3, 6);
            });
        });
    });
});
