import {WindowDecoration} from '../src/lib/windowDecoration.js';
import {WindowClientType} from '../src/lib/mutterRules.generated.js';

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
            this.overviewMode = false;
        }

        set_enabled(val) {
            this.enabled = val;
        }

        setParams(params) {
            this.params = params;
        }

        setOverviewMode(val) {
            this.overviewMode = val;
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
            get_client_type: () => WindowClientType.X11,
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
            effectiveClearRing: false,
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

        // Attach clip while in overview -> enabled and in overview mode
        deco._syncClip(true, false, mockActor, insets, true);
        expect(deco.hasClip).toBeTrue();
        expect(deco.clip.enabled).toBeTrue();
        expect(deco.clip.overviewMode).toBeTrue();
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

    it('applies overview mode settings through apply() contract', () => {
        const deco = new WindowDecoration(mockWin, {
            container: mockContainer,
            display: mockDisplay,
            RoundedClipEffect: MockClipEffect,
            ShadowActor: MockShadowActor,
            ResizeBand: MockResizeBand,
        });

        const outline = {color: [1, 1, 1], alpha: 0.1};
        const actions = {
            drawClip: true,
            clearRing: false,
            drawRing: false,
            drawShadow: true,
            drawResize: true,
            style: {
                radius: 12,
                outline,
                shadows: [],
            },
        };
        const inputs = {
            insets: {left: 10, top: 10, right: 10, bottom: 10},
            monitorScale: 1,
        };

        // apply while in overview (clip retained, overviewMode enabled, outline suppressed to avoid subpixel fringe)
        deco.apply({actions, inputs, actor: mockActor, inOverview: true});
        expect(deco.hasClip).toBeTrue();
        expect(deco.clip.enabled).toBeTrue();
        expect(deco.clip.overviewMode).toBeTrue();
        expect(deco.clip.params.outline).toBeNull();

        // apply on desktop (outline restored, overviewMode disabled)
        deco.apply({actions, inputs, actor: mockActor, inOverview: false});
        expect(deco.hasClip).toBeTrue();
        expect(deco.clip.enabled).toBeTrue();
        expect(deco.clip.overviewMode).toBeFalse();
        expect(deco.clip.params.outline).toEqual(outline);
    });

    it('forces clearRing true on windows without shadow insets (e.g. WeChat) to eliminate outer corner fringe', () => {
        const deco = new WindowDecoration(mockWin, {
            container: mockContainer,
            display: mockDisplay,
            RoundedClipEffect: MockClipEffect,
            ShadowActor: MockShadowActor,
            ResizeBand: MockResizeBand,
        });

        const actions = {
            drawClip: true,
            clearRing: false, // detector reports false because no client shadow exists to clear
            drawRing: false,
            drawShadow: true,
            drawResize: true,
            style: {radius: 15, outline: null, shadows: []},
        };
        const zeroInsets = {left: 0, top: 0, right: 0, bottom: 0};
        const inputs = {
            insets: zeroInsets,
            monitorScale: 1,
        };

        deco.apply({actions, inputs, actor: mockActor});
        expect(deco.hasClip).toBeTrue();
        // WindowDecoration retains clearRing as false (client declared no ring)
        // while computing effectiveClearRing as true so shader erases outer rectangular corners.
        // It must leave clearStroke false so shader preserves 1:1 sampling without pushing coords inward.
        expect(deco.clearRing).toBeFalse();
        expect(deco.effectiveClearRing).toBeTrue();
        expect(deco.clip.params.clearRing).toBeTrue();
        expect(deco.clip.params.clearStroke).toBeFalse();
    });

    it('keeps the clip body on the declared frame so it matches the shadow body', () => {
        const deco = new WindowDecoration(mockWin, {
            container: mockContainer,
            display: mockDisplay,
            RoundedClipEffect: MockClipEffect,
            ShadowActor: MockShadowActor,
            ResizeBand: MockResizeBand,
        });

        const actions = {
            drawClip: true,
            clearRing: true,
            drawRing: false,
            drawShadow: true,
            drawResize: true,
            style: {radius: 15, outline: null, shadows: []},
        };
        const declaredInsets = {left: 26, top: 23, right: 26, bottom: 29};
        const inputs = {
            insets: declaredInsets,
            monitorScale: 1,
        };

        deco.apply({actions, inputs, actor: mockActor});
        expect(deco.hasClip).toBeTrue();
        // The clip body and the shadow body are the same rect: any inward offset puts our shadow
        // where libadwaita puts the window's own edge pixel, and exposes the shader's inward bleed.
        expect(deco.clipInsets).toEqual(declaredInsets);
        expect(deco.clip.params.insets).toEqual(declaredInsets);
        expect(deco.clip.params.clearRing).toBeTrue();
        expect(deco.clip.params.clearStroke).toBeTrue();
        expect(deco.shadow.insets).toEqual(declaredInsets);
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
            effectiveClearRing: false,
            hasShadow: false,
            hasResizeBand: false,
            firstFrameDone: false,
            isPendingReconcile: false,
        });
    });

    it('delegates helper methods: setOverviewMode, restack, resetBandCursor, and undecorate', () => {
        const deco = new WindowDecoration(mockWin, {
            container: mockContainer,
            display: mockDisplay,
            RoundedClipEffect: MockClipEffect,
            ShadowActor: MockShadowActor,
            ResizeBand: MockResizeBand,
        });

        const insets = {left: 10, top: 10, right: 10, bottom: 10};
        const outline = {color: [1, 1, 1], alpha: 0.1};
        const actions = {
            drawClip: true,
            clearRing: false,
            drawRing: false,
            drawShadow: true,
            drawResize: true,
            style: {radius: 12, outline, shadows: []},
        };
        const inputs = {insets, monitorScale: 1};
        deco.apply({actions, inputs, actor: mockActor});

        // setOverviewMode entering overview (outline suppressed, overviewMode enabled, clearStroke preserved)
        deco.setOverviewMode(true);
        expect(deco.clip.enabled).toBeTrue();
        expect(deco.clip.overviewMode).toBeTrue();
        expect(deco.clip.params.outline).toBeNull();
        expect(deco.clip.params.clearStroke).toBeFalse();

        // setOverviewMode leaving overview (outline restored, overviewMode disabled, clearStroke preserved)
        deco.setOverviewMode(false);
        expect(deco.clip.enabled).toBeTrue();
        expect(deco.clip.overviewMode).toBeFalse();
        expect(deco.clip.params.outline).toEqual(outline);
        expect(deco.clip.params.clearStroke).toBeFalse();

        // On ringed windows (clearRing=true), clearStroke must be suppressed in overview to preserve mipmap LOD derivatives
        const ringedActions = {...actions, clearRing: true};
        deco.apply({actions: ringedActions, inputs, actor: mockActor});
        expect(deco.clip.params.clearStroke).toBeTrue();

        deco.setOverviewMode(true);
        expect(deco.clip.params.clearStroke).toBeFalse();

        deco.setOverviewMode(false);
        expect(deco.clip.params.clearStroke).toBeTrue();

        // setOverviewMode safely no-ops when clip is null
        const bareDeco = new WindowDecoration(mockWin, {
            container: mockContainer,
            display: mockDisplay,
        });
        expect(() => bareDeco.setOverviewMode(true)).not.toThrow();

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
