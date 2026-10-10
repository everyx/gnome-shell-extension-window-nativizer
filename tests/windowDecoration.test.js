import {WindowDecoration} from '../src/lib/windowDecoration.js';
import {WindowClientType} from '../src/lib/mutterRules.generated.js';
import {FLAT_SAFE_INSET} from '../src/lib/frame.js';

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
            get_client_type: () => WindowClientType.WAYLAND,
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

        // Attach clip while in overview, with the style already decided -> the clip is
        // suspended so the preview clone samples the window's own mipmapped texture
        // instead of an offscreen FBO.
        deco.drawClip = true;
        deco._style = {radius: 12, outline: null, shadows: []};
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
            clearRing: true,
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

        // apply while in overview (clip suspended, outline suppressed to avoid subpixel fringe)
        deco.apply({actions, inputs, actor: mockActor, inOverview: true});
        expect(deco.hasClip).toBeTrue();
        expect(deco.clip.enabled).toBeFalse();
        expect(deco.clip.params.outline).toBeNull();

        // apply on desktop (outline restored, clip re-enabled)
        deco.apply({actions, inputs, actor: mockActor, inOverview: false});
        expect(deco.hasClip).toBeTrue();
        expect(deco.clip.enabled).toBeTrue();
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

        const outline = {color: [255, 255, 255], alpha: 0.07};
        const actions = {
            drawClip: true,
            clearRing: false, // detector reports false because no client shadow exists to clear
            drawRing: false,
            drawShadow: true,
            drawResize: true,
            style: {radius: 15, outline, shadows: []},
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
        // Flat ringless windows use FLAT_SAFE_INSET (1px inward) to excise rectangular client borders,
        // while retaining Adwaita inner outline on desktop to achieve seamless native decoration consistency.
        expect(deco.clearRing).toBeFalse();
        expect(deco.effectiveClearRing).toBeTrue();
        expect(deco.clipInsets).toEqual(FLAT_SAFE_INSET);
        expect(deco.clip.params.insets).toEqual(FLAT_SAFE_INSET);
        expect(deco.shadow.insets).toEqual(FLAT_SAFE_INSET);
        expect(deco.clip.params.clearRing).toBeTrue();
        expect(deco.clip.params.clearStroke).toBeFalse();
        expect(deco.clip.params.outline).toEqual(outline);
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
            clearRing: true,
            drawRing: false,
            drawShadow: true,
            drawResize: true,
            style: {radius: 12, outline, shadows: []},
        };
        const inputs = {insets, monitorScale: 1};
        deco.apply({actions, inputs, actor: mockActor});

        // setOverviewMode entering overview (clip suspended, outline suppressed)
        deco.setOverviewMode(true);
        expect(deco.clip.enabled).toBeFalse();
        expect(deco.clip.params.outline).toBeNull();
        expect(deco.clip.params.clearStroke).toBeFalse();

        // setOverviewMode leaving overview (outline restored, clip re-enabled)
        deco.setOverviewMode(false);
        expect(deco.clip.enabled).toBeTrue();
        expect(deco.clip.params.outline).toEqual(outline);
        expect(deco.clip.params.clearStroke).toBeTrue();

        // For flat ringless windows (clearRing=false), outline is active on desktop and suppressed in overview
        deco.apply({actions: {...actions, clearRing: false}, inputs, actor: mockActor});
        expect(deco.clip.params.outline).toEqual(outline);
        deco.setOverviewMode(true);
        expect(deco.clip.params.outline).toBeNull();
        deco.setOverviewMode(false);
        expect(deco.clip.params.outline).toEqual(outline);

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

    it('rounds X11 (XWayland) windows through the mask too, suspending the offscreen clip', () => {
        mockWin.get_client_type = () => WindowClientType.X11;
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
            style: {radius: 12, outline: null, shadows: []},
        };
        deco.apply({actions, inputs: {insets: {left: 0, top: 0, right: 0, bottom: 0}, monitorScale: 1}, actor: mockActor});
        expect(deco._canApplyOverviewMask()).toBeTrue();

        deco.setOverviewMode(true);
        expect(deco.clip.enabled).toBeFalse();
    });

    it('re-applies the XWayland mask after each surface sync', () => {
        mockWin.get_client_type = () => WindowClientType.X11;
        const fakeMask = {tag: 'rounded'};
        const fakeOpaque = {tag: 'opaque'};
        const OverviewMask = {
            buildRoundedMask: () => fakeMask,
            opaqueMask: () => fakeOpaque,
        };
        const surface = {
            mask: null,
            set_mask_texture(texture) {
                this.mask = texture;
            },
            get_texture: () => ({
                get_plane: () => ({get_context: () => ({})}),
                get_width: () => 800,
                get_height: () => 600,
            }),
        };
        // X11 resolves the clip target to the window actor's first child, which mockActor lacks,
        // so the target is mockActor itself and that is what gets the re-apply hook.
        mockActor.handlers = [];
        mockActor.connect = (signal, cb) => {
            mockActor.handlers.push({signal, cb});
            return mockActor.handlers.length;
        };
        mockActor.disconnect = () => {};
        mockActor.get_texture = () => surface;

        const container = {
            opacity: 255,
            get_opacity() {
                return this.opacity;
            },
            set_opacity(value) {
                this.opacity = value;
            },
            connect: () => 1,
            disconnect: () => {},
        };
        mockWin._delegate = {window_container: container};
        mockWin.connect = () => 1;
        mockWin.disconnect = () => {};

        const deco = new WindowDecoration(mockWin, {
            container: mockContainer,
            display: mockDisplay,
            RoundedClipEffect: MockClipEffect,
            ShadowActor: MockShadowActor,
            ResizeBand: MockResizeBand,
            OverviewMask,
        });
        const actions = {
            drawClip: true,
            clearRing: false,
            drawRing: false,
            drawShadow: false,
            drawResize: false,
            style: {radius: 12, outline: null, shadows: []},
        };
        deco.apply({actions, inputs: {insets: {left: 0, top: 0, right: 0, bottom: 0}, monitorScale: 1}, actor: mockActor});

        deco.setOverviewMode(true);
        expect(surface.mask).toBe(fakeMask);

        const restore = mockActor.handlers.find(h => h.signal === 'repaint-scheduled');
        expect(restore).toBeDefined();
        // Mutter rewrites the slot from the X11 shape on a surface sync; the hook restores it.
        surface.mask = null;
        restore.cb();
        expect(surface.mask).toBe(fakeMask);

        deco.setOverviewMode(false);
        expect(surface.mask).toBe(fakeOpaque);
    });

    it('applies the shaped-texture mask and the container-opacity bypass on Wayland', () => {
        const fakeMask = {tag: 'rounded'};
        const fakeOpaque = {tag: 'opaque'};
        const OverviewMask = {
            buildRoundedMask: () => fakeMask,
            opaqueMask: () => fakeOpaque,
        };
        const surface = {
            mask: null,
            set_mask_texture(texture) {
                this.mask = texture;
            },
            get_texture: () => ({
                get_plane: () => ({get_context: () => ({})}),
                get_width: () => 800,
                get_height: () => 600,
            }),
        };
        mockActor.get_texture = () => surface;

        const container = {
            opacity: 255,
            get_opacity() {
                return this.opacity;
            },
            set_opacity(value) {
                this.opacity = value;
            },
            connect: () => 1,
            disconnect: () => {},
        };
        mockWin._delegate = {window_container: container};
        mockWin.connect = () => 1;
        mockWin.disconnect = () => {};

        const deco = new WindowDecoration(mockWin, {
            container: mockContainer,
            display: mockDisplay,
            RoundedClipEffect: MockClipEffect,
            ShadowActor: MockShadowActor,
            ResizeBand: MockResizeBand,
            OverviewMask,
        });
        const actions = {
            drawClip: true,
            clearRing: false,
            drawRing: false,
            drawShadow: false,
            drawResize: false,
            style: {radius: 12, outline: null, shadows: []},
        };
        deco.apply({actions, inputs: {insets: {left: 0, top: 0, right: 0, bottom: 0}, monitorScale: 1}, actor: mockActor});

        deco.setOverviewMode(true);
        expect(surface.mask).toBe(fakeMask);
        expect(container.opacity).toBe(254);
        expect(deco.clip.enabled).toBeFalse();

        deco.setOverviewMode(false);
        expect(surface.mask).toBe(fakeOpaque);
        expect(container.opacity).toBe(255);
        expect(deco.clip.enabled).toBeTrue();
    });

    it('re-applies the mask when the window moves to another workspace in the overview', () => {
        const fakeMask = {tag: 'rounded'};
        const fakeOpaque = {tag: 'opaque'};
        const OverviewMask = {
            buildRoundedMask: () => fakeMask,
            opaqueMask: () => fakeOpaque,
        };
        const surface = {
            mask: null,
            set_mask_texture(texture) {
                this.mask = texture;
            },
            get_texture: () => ({
                get_plane: () => ({get_context: () => ({})}),
                get_width: () => 800,
                get_height: () => 600,
            }),
        };
        mockActor.get_texture = () => surface;
        const winSignals = [];
        mockWin.connect = (signal, cb) => {
            winSignals.push({signal, cb});
            return winSignals.length;
        };
        mockWin.disconnect = () => {};

        const newContainer = () => ({
            opacity: 255,
            get_opacity() {
                return this.opacity;
            },
            set_opacity(value) {
                this.opacity = value;
            },
            connect: () => 1,
            disconnect: () => {},
        });
        const firstCard = newContainer();
        mockWin._delegate = {window_container: firstCard};

        const deco = new WindowDecoration(mockWin, {
            container: mockContainer,
            display: mockDisplay,
            RoundedClipEffect: MockClipEffect,
            ShadowActor: MockShadowActor,
            ResizeBand: MockResizeBand,
            OverviewMask,
        });
        const actions = {
            drawClip: true,
            clearRing: false,
            drawRing: false,
            drawShadow: false,
            drawResize: false,
            style: {radius: 12, outline: null, shadows: []},
        };
        deco.apply({actions, inputs: {insets: {left: 0, top: 0, right: 0, bottom: 0}, monitorScale: 1}, actor: mockActor});
        deco.setOverviewMode(true);
        expect(firstCard.opacity).toBe(254);
        expect(surface.mask).toBe(fakeMask);

        // The window moves to another workspace: a fresh preview with its container at full opacity.
        const secondCard = newContainer();
        mockWin._delegate = {window_container: secondCard};
        const moved = winSignals.find(s => s.signal === 'workspace-changed');
        expect(moved).toBeDefined();
        moved.cb();

        expect(secondCard.opacity).toBe(254);
        expect(surface.mask).toBe(fakeMask);
    });

    it('sizes the overview mask to the largest preview the overview can draw, then caps it', () => {
        const deco = new WindowDecoration(mockWin, {
            container: mockContainer,
            display: mockDisplay,
        });

        // 1x buffer on a 1x monitor: the preview tops out at 0.95 of the window.
        expect(deco._overviewMaskScale(800, 600, 1, 1)).toBe(0.95);
        // A hidpi buffer on a low-dpi monitor is downsampled to the on-screen size.
        expect(deco._overviewMaskScale(4000, 2400, 2, 1)).toBeCloseTo(0.475, 5);
        // Above the cap, the longest side is pinned at OVERVIEW_MASK_MAX_DIMENSION.
        expect(deco._overviewMaskScale(3840, 2160, 1, 1)).toBeCloseTo(2560 / 3840, 5);
        expect(deco._overviewMaskScale(7680, 4320, 1, 1)).toBeCloseTo(2560 / 7680, 5);
        // Never degenerate.
        expect(deco._overviewMaskScale(100000, 100000, 1, 1)).toBe(0.05);
    });
});
