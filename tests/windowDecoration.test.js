import {WindowDecoration} from '../src/lib/windowDecoration.js';

describe('WindowDecoration (lifecycle and orchestration)', () => {
    let mockWin;
    let mockActor;
    let mockContainer;
    let mockDisplay;

    // Spy classes
    class MockClipEffect {
        constructor() {
            this.enabled = true;
            this.params = null;
        }

        set_enabled(val) {
            this.enabled = val;
        }

        setParams(params) {
            this.params = params;
        }
    }

    class MockShadowActor {
        constructor(actor, container) {
            this.actor = actor;
            this.container = container;
            this.destroyed = false;
            this.insets = null;
            this.style = null;
            this.scale = 1;
        }

        setScale(scale) {
            this.scale = scale;
        }

        setShadowInsets(insets) {
            this.insets = insets;
        }

        setShadowStyle(style) {
            this.style = style;
        }

        destroy() {
            this.destroyed = true;
        }
    }

    class MockResizeBand {
        constructor(actor, container) {
            this.actor = actor;
            this.container = container;
            this.destroyed = false;
            this.geometry = null;
            this.restacked = false;
            this.cursorReset = false;
        }

        setGeometry(geo) {
            this.geometry = geo;
        }

        restack() {
            this.restacked = true;
        }

        resetCursor() {
            this.cursorReset = true;
        }

        destroy() {
            this.destroyed = true;
        }
    }

    beforeEach(() => {
        mockActor = {
            width: 800,
            height: 600,
            effects: [],
            add_effect(eff) {
                this.effects.push(eff);
            },
            remove_effect(eff) {
                this.effects = this.effects.filter(e => e !== eff);
            },
        };

        mockWin = {
            get_compositor_private: () => mockActor,
            get_client_type: () => 1, // Wayland
        };

        mockContainer = {
            set_child_below_sibling: jasmine.createSpy('set_child_below_sibling'),
        };

        mockDisplay = {
            get_n_monitors: () => 1,
            get_monitor_geometry: () => ({x: 0, y: 0, width: 1920, height: 1080}),
        };
    });

    it('initializes with unattached state view', () => {
        const deco = new WindowDecoration(mockWin, {
            container: mockContainer,
            display: mockDisplay,
            RoundedClipEffect: MockClipEffect,
            ShadowActor: MockShadowActor,
            ResizeBand: MockResizeBand,
        });

        expect(deco.hasClip).toBeFalse();
        expect(deco.hasShadow).toBeFalse();
        expect(deco.hasResizeBand).toBeFalse();
        expect(deco.isActivelyClipped).toBeFalse();
        expect(deco.stateView).toEqual({
            hasClip: false,
            drawClip: false,
            isActivelyClipped: false,
            clearRing: false,
            hasShadow: false,
            hasResizeBand: false,
            firstFrameDone: false,
            isPendingReconcile: false,
        });
    });

    it('manages clip attachment and overview suppression in _syncClip', () => {
        const deco = new WindowDecoration(mockWin, {
            container: mockContainer,
            display: mockDisplay,
            RoundedClipEffect: MockClipEffect,
            ShadowActor: MockShadowActor,
            ResizeBand: MockResizeBand,
        });

        const insets = {left: 10, top: 10, right: 10, bottom: 10};

        // Attach clip in normal mode
        deco._syncClip(true, false, mockActor, insets, false);
        expect(deco.hasClip).toBeTrue();
        expect(deco.clip.enabled).toBeTrue();
        expect(mockActor.effects).toContain(deco.clip);

        // Detach clip
        deco._syncClip(false, false, mockActor, null, false);
        expect(deco.hasClip).toBeFalse();
        expect(mockActor.effects.length).toBe(0);

        // Attach clip while in overview -> disabled
        deco._syncClip(true, false, mockActor, insets, true);
        expect(deco.hasClip).toBeTrue();
        expect(deco.clip.enabled).toBeFalse();
    });

    it('manages shadow actor lifecycle in _syncShadow', () => {
        const deco = new WindowDecoration(mockWin, {
            container: mockContainer,
            display: mockDisplay,
            RoundedClipEffect: MockClipEffect,
            ShadowActor: MockShadowActor,
            ResizeBand: MockResizeBand,
        });

        // Add shadow
        deco._syncShadow(true, mockActor);
        expect(deco.hasShadow).toBeTrue();
        const shadow = deco.shadow;
        expect(shadow.actor).toBe(mockActor);

        // Idempotent sync
        deco._syncShadow(true, mockActor);
        expect(deco.shadow).toBe(shadow);

        // Remove shadow
        deco._syncShadow(false, mockActor);
        expect(deco.hasShadow).toBeFalse();
        expect(shadow.destroyed).toBeTrue();
    });

    it('manages resize band lifecycle and geometry updates in _syncResizeBand', () => {
        const deco = new WindowDecoration(mockWin, {
            container: mockContainer,
            display: mockDisplay,
            RoundedClipEffect: MockClipEffect,
            ShadowActor: MockShadowActor,
            ResizeBand: MockResizeBand,
        });

        const inputs = {
            monitorScale: 2,
            maximizedHorizontally: false,
            maximizedVertically: true,
        };
        const insets = {left: 8, top: 8, right: 8, bottom: 8};

        deco._syncResizeBand(true, inputs, insets, mockActor);
        expect(deco.hasResizeBand).toBeTrue();
        expect(deco.resizeBand.geometry).not.toBeNull();
        expect(deco.resizeBand.geometry.scale).toBe(2);

        // Remove band
        deco._syncResizeBand(false, inputs, insets, mockActor);
        expect(deco.hasResizeBand).toBeFalse();
    });

    it('applies style and synchronizes full tri-axis in apply()', () => {
        const deco = new WindowDecoration(mockWin, {
            container: mockContainer,
            display: mockDisplay,
            RoundedClipEffect: MockClipEffect,
            ShadowActor: MockShadowActor,
            ResizeBand: MockResizeBand,
        });

        const actions = {
            drawClip: true,
            clearRing: false,
            drawRing: false,
            drawShadow: true,
            drawResize: true,
            style: {
                radius: 12,
                outline: null,
                shadows: [],
            },
        };
        const inputs = {
            insets: {left: 10, top: 10, right: 10, bottom: 10},
            monitorScale: 1,
            maximizedHorizontally: false,
            maximizedVertically: false,
        };

        deco.apply({actions, inputs, actor: mockActor});

        expect(deco.isActivelyClipped).toBeTrue();
        expect(deco.hasShadow).toBeTrue();
        expect(deco.hasResizeBand).toBeTrue();
        expect(deco.clip.params.radius).toBe(12);
        expect(deco.clip.params.scale).toBe(1);
        expect(deco.shadow.style.radius).toBe(12);
        expect(deco.shadow.scale).toBe(1);
    });

    it('performs clean phased teardown in destroy()', () => {
        const deco = new WindowDecoration(mockWin, {
            container: mockContainer,
            display: mockDisplay,
            RoundedClipEffect: MockClipEffect,
            ShadowActor: MockShadowActor,
            ResizeBand: MockResizeBand,
        });

        const insets = {left: 10, top: 10, right: 10, bottom: 10};
        deco._syncClip(true, false, mockActor, insets);
        deco._syncShadow(true, mockActor);
        deco._syncResizeBand(true, {monitorScale: 1}, insets, mockActor);

        const mockDisconnectObj = {
            disconnect: jasmine.createSpy('disconnect'),
        };
        deco.signals.push([mockDisconnectObj, 1234]);

        const shadowRef = deco.shadow;
        const bandRef = deco.resizeBand;

        deco.destroy();

        expect(deco.hasClip).toBeFalse();
        expect(deco.hasShadow).toBeFalse();
        expect(deco.hasResizeBand).toBeFalse();
        expect(shadowRef.destroyed).toBeTrue();
        expect(bandRef.destroyed).toBeTrue();
        expect(mockDisconnectObj.disconnect).toHaveBeenCalledWith(1234);
        expect(deco.signals.length).toBe(0);
    });

    it('preserves clip and shadow when keepVisualsForClose is true', () => {
        const deco = new WindowDecoration(mockWin, {
            container: mockContainer,
            display: mockDisplay,
            RoundedClipEffect: MockClipEffect,
            ShadowActor: MockShadowActor,
            ResizeBand: MockResizeBand,
        });

        const insets = {left: 10, top: 10, right: 10, bottom: 10};
        deco._syncClip(true, false, mockActor, insets);
        deco._syncShadow(true, mockActor);
        deco._syncResizeBand(true, {monitorScale: 1}, insets, mockActor);

        const mockDisconnectObj = {
            disconnect: jasmine.createSpy('disconnect'),
        };
        deco.signals.push([mockDisconnectObj, 5678]);

        const shadowRef = deco.shadow;
        const bandRef = deco.resizeBand;

        deco.destroy({keepVisualsForClose: true});

        // ResizeBand and signals are cleared
        expect(deco.hasResizeBand).toBeFalse();
        expect(bandRef.destroyed).toBeTrue();
        expect(mockDisconnectObj.disconnect).toHaveBeenCalledWith(5678);
        expect(deco.signals.length).toBe(0);

        // Visuals are preserved for window close animation
        expect(deco.hasClip).toBeTrue();
        expect(deco.hasShadow).toBeTrue();
        expect(shadowRef.destroyed).toBeFalse();
    });

    it('provides a stateView snapshot of decoration properties', () => {
        const deco = new WindowDecoration(mockWin, {
            container: mockContainer,
            display: mockDisplay,
            RoundedClipEffect: MockClipEffect,
            ShadowActor: MockShadowActor,
            ResizeBand: MockResizeBand,
        });

        const view = deco.stateView;
        expect(view).toEqual({
            hasClip: false,
            drawClip: false,
            isActivelyClipped: false,
            clearRing: false,
            hasShadow: false,
            hasResizeBand: false,
            firstFrameDone: false,
            isPendingReconcile: false,
        });
    });

    it('delegates helper methods: suspend, restack, resetBandCursor, and undecorate', () => {
        const deco = new WindowDecoration(mockWin, {
            container: mockContainer,
            display: mockDisplay,
            RoundedClipEffect: MockClipEffect,
            ShadowActor: MockShadowActor,
            ResizeBand: MockResizeBand,
        });

        const insets = {left: 10, top: 10, right: 10, bottom: 10};
        deco._syncClip(true, false, mockActor, insets);
        deco._syncShadow(true, mockActor);
        deco._syncResizeBand(true, {monitorScale: 1}, insets, mockActor);

        // suspend
        deco.suspend(true);
        expect(deco.clip.enabled).toBeFalse();
        deco.suspend(false);
        expect(deco.clip.enabled).toBeTrue();

        // restack
        deco.restack(mockActor);
        expect(mockContainer.set_child_below_sibling).toHaveBeenCalledWith(deco.shadow, mockActor);
        expect(deco.resizeBand.restacked).toBeTrue();

        // resetBandCursor
        deco.resetBandCursor();
        expect(deco.resizeBand.cursorReset).toBeTrue();

        // undecorate
        deco.undecorate();
        expect(deco.hasClip).toBeFalse();
        expect(deco.hasShadow).toBeFalse();
        expect(deco.hasResizeBand).toBeFalse();
        expect(deco.drawClip).toBeFalse();
    });
});
