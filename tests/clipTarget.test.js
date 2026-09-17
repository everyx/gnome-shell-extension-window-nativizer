/**
 * clipTarget unit tests: resolving clip target actor across native and foreign-injected windows (jasmine-gjs).
 * Run: pnpm test
 */

import {WindowClientType} from '../src/lib/mutterRules.generated.js';
import {
    isForeignWidget,
    hasForeignInjectedWidget,
    isCompatibleSurfaceGeometry,
    resolveClipTarget,
} from '../src/lib/clipTarget.js';

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

    describe('hasForeignInjectedWidget', () => {
        it('returns false for null or childless actor', () => {
            expect(hasForeignInjectedWidget(null, mockSt)).toBe(false);
            expect(hasForeignInjectedWidget(createMockActor({children: []}), mockSt)).toBe(false);
        });

        it('returns false for native window actors with only surface children', () => {
            const surface = new MockSurfaceActor();
            const actor = createMockActor({children: [surface]});
            expect(hasForeignInjectedWidget(actor, mockSt)).toBe(false);
        });

        it('detects foreign widget when inserted at index 0 (Blur my Shell pattern)', () => {
            const blurWidget = new MockStWidget();
            const surface = new MockSurfaceActor();
            const actor = createMockActor({children: [blurWidget, surface]});
            expect(hasForeignInjectedWidget(actor, mockSt)).toBe(true);
        });

        it('detects foreign widget when inserted at a later index', () => {
            const surface = new MockSurfaceActor();
            const foreignWidget = new MockStWidget();
            const actor = createMockActor({children: [surface, foreignWidget]});
            expect(hasForeignInjectedWidget(actor, mockSt)).toBe(true);
        });
    });

    describe('isCompatibleSurfaceGeometry', () => {
        const win = createMockWindow({buffer: {x: 100, y: 100, width: 500, height: 400}});

        it('accepts candidate starting at (0, 0) matching buffer width and height', () => {
            const candidate = {x: 0, y: 0, width: 500, height: 400};
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

        describe('Fast path (no foreign widgets injected - zero side effects)', () => {
            it('returns window actor on Wayland', () => {
                const win = createMockWindow({clientType: WindowClientType.WAYLAND});
                const surface = new MockSurfaceActor();
                const actor = createMockActor({children: [surface]});

                const target = resolveClipTarget(win, actor, mockSt);
                expect(target).toBe(actor);
            });

            it('returns first child on X11 when surface child exists', () => {
                const win = createMockWindow({clientType: WindowClientType.X11});
                const surface = new MockSurfaceActor();
                const actor = createMockActor({children: [surface]});

                const target = resolveClipTarget(win, actor, mockSt);
                expect(target).toBe(surface);
            });

            it('falls back to window actor on X11 when first child is missing', () => {
                const win = createMockWindow({clientType: WindowClientType.X11});
                const actor = createMockActor({children: []});

                const target = resolveClipTarget(win, actor, mockSt);
                expect(target).toBe(actor);
            });
        });

        describe('Compatibility path (foreign St.Widget injected, e.g. Blur my Shell)', () => {
            it('bypasses blur widget and targets surface container on Wayland when geometry matches', () => {
                const win = createMockWindow({clientType: WindowClientType.WAYLAND, buffer: {width: 500, height: 400}});
                const blurWidget = new MockStWidget('BlurMyShellActor');
                const surfaceContainer = new MockSurfaceActor('MetaSurfaceContainerActorWayland', {x: 0, y: 0, width: 500, height: 400});
                const actor = createMockActor({children: [blurWidget, surfaceContainer]});

                const target = resolveClipTarget(win, actor, mockSt);
                expect(target).toBe(surfaceContainer);
                expect(target).not.toBe(actor);
                expect(target).not.toBe(blurWidget);
            });

            it('falls back to window actor on Wayland if surface container geometry is incompatible', () => {
                const win = createMockWindow({clientType: WindowClientType.WAYLAND, buffer: {width: 500, height: 400}});
                const blurWidget = new MockStWidget('BlurMyShellActor');
                // Surface has unexpected offset / padding
                const surfaceWithOffset = new MockSurfaceActor('MetaSurfaceContainerActorWayland', {x: 12, y: 12, width: 476, height: 376});
                const actor = createMockActor({children: [blurWidget, surfaceWithOffset]});

                const target = resolveClipTarget(win, actor, mockSt);
                // Incompatible coordinate space -> safe fallback to defaultTarget (actor)
                expect(target).toBe(actor);
            });

            it('bypasses blur widget and targets surface child on X11 when geometry matches', () => {
                const win = createMockWindow({clientType: WindowClientType.X11, buffer: {width: 550, height: 487}});
                const blurWidget = new MockStWidget('BlurMyShellActor');
                const surfaceActor = new MockSurfaceActor('MetaSurfaceActorX11', {x: 0, y: 0, width: 550, height: 487});
                const actor = createMockActor({children: [blurWidget, surfaceActor]});

                const target = resolveClipTarget(win, actor, mockSt);
                expect(target).toBe(surfaceActor);
                expect(target).not.toBe(blurWidget);
            });

            it('gracefully falls back to default target if only foreign widgets are present', () => {
                const winWayland = createMockWindow({clientType: WindowClientType.WAYLAND});
                const blurWidget = new MockStWidget();
                const actorWayland = createMockActor({children: [blurWidget]});

                // On Wayland, default target is actor
                expect(resolveClipTarget(winWayland, actorWayland, mockSt)).toBe(actorWayland);

                const winX11 = createMockWindow({clientType: WindowClientType.X11});
                const actorX11 = createMockActor({children: [blurWidget]});

                // On X11, default target is actor.get_first_child() ?? actor (blurWidget)
                expect(resolveClipTarget(winX11, actorX11, mockSt)).toBe(blurWidget);
            });
        });
    });
});
