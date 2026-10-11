import {WindowDecoration} from '../src/lib/windowDecoration.js';
import {WindowClientType} from '../src/lib/mutterRules.generated.js';
import {FLAT_SAFE_INSET} from '../src/lib/frame.js';
import {evaluateWindowActions} from '../src/lib/detector.js';

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
            get_frame_rect: () => ({x: 0, y: 0, width: 800, height: 600}),
            connect: () => 1,
            disconnect: () => {},
        };

        mockContainer = {
            set_child_below_sibling: jasmine.createSpy('set_child_below_sibling'),
        };

        mockDisplay = {
            get_n_monitors: () => 1,
            get_monitor_geometry: () => ({x: 0, y: 0, width: 1920, height: 1080}),
        };
    });

    /**
     * Wires the mask path up: a shaped-texture stand-in that records the mask, a preview
     * container whose opacity can be observed, and the mask builders. The probe that decides
     * whether masking a window is safe for its desktop screenshot is stubbed, so a test can put
     * a window on either side of it.
     *
     * @param {object} [options]
     * @param {number} [options.clientType=WindowClientType.WAYLAND]
     * @param {boolean} [options.drawClip=true]
     * @param {boolean} [options.drawShadow=false]
     * @param {boolean} [options.maskWouldChangeScreenshot=false]
     * @param {boolean} [options.forceOverviewCorners=false]
     * @param {boolean} [options.ringClear=false]
     * @param {object} [options.insets] - Declared ring, per side
     * @returns {object}
     */
    function setupMaskHarness({
        clientType = WindowClientType.WAYLAND,
        drawClip = true,
        drawShadow = false,
        ringClear = false,
        insets = {left: 0, top: 0, right: 0, bottom: 0},
        maskWouldChangeScreenshot = false,
        forceOverviewCorners = false,
    } = {}) {
        mockWin.get_client_type = () => clientType;

        const mask = {tag: 'rounded'};
        const opaque = {tag: 'opaque'};
        let probeCalls = 0;
        let opaqueCalls = 0;
        const OverviewMask = {
            buildRoundedMask: () => mask,
            opaqueMask: () => {
                opaqueCalls++;
                return opaque;
            },
            maskWouldChangeScreenshot: () => {
                probeCalls++;
                return maskWouldChangeScreenshot;
            },
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

        const makeContainer = () => ({
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
        const container = makeContainer();
        mockWin._delegate = {window_container: container};

        const windowSignals = [];
        mockWin.connect = (signal, cb) => {
            windowSignals.push({signal, cb});
            return windowSignals.length;
        };
        mockWin.disconnect = () => {};

        // Stands in for the real Clutter.Clone subclass: records every clone, and lets a test
        // fire the clone's own 'destroy' the way the preview's teardown would.
        const shadowClones = [];
        class FakeOverviewShadow {
            constructor(source, preview, previewContainer, width) {
                this.source = source;
                this.preview = preview;
                this.container = previewContainer;
                this.width = width;
                this.handlers = {};
                this.destroyed = false;
                shadowClones.push(this);
            }

            connect(signal, cb) {
                this.handlers[signal] = cb;
                return 1;
            }

            destroy() {
                this.destroyed = true;
                this.handlers.destroy?.();
            }
        }

        const deco = new WindowDecoration(mockWin, {
            container: mockContainer,
            display: mockDisplay,
            RoundedClipEffect: MockClipEffect,
            ShadowActor: MockShadowActor,
            ResizeBand: MockResizeBand,
            OverviewMask,
            OverviewShadow: FakeOverviewShadow,
        });
        const flat = !(insets.left > 0 || insets.top > 0 || insets.right > 0 || insets.bottom > 0);
        deco.apply({
            actions: {
                drawClip,
                drawRing: false,
                drawShadow,
                drawResize: false,
                ring: {clear: ringClear, safeInset: flat && (drawClip || drawShadow)},
                style: {radius: 12, outline: null, shadows: []},
            },
            inputs: {insets, monitorScale: 1},
            actor: mockActor,
            forceOverviewCorners,
        });

        return {
            mask, opaque, surface, container, makeContainer, windowSignals, shadowClones,
            probeCalls: () => probeCalls,
            opaqueCalls: () => opaqueCalls,
            deco,
        };
    }

    /**
     * The action set a maximized window gets, built through the detector rather than hand-rolled
     * so the fixture cannot drift from the real answer: no clip, no shadow, a square style.
     *
     * @returns {object}
     */
    function maximizedActions() {
        return evaluateWindowActions({
            bufferWidth: 800, bufferHeight: 600,
            frameWidth: 800, frameHeight: 600,
            isMaximized: true,
            isX11: false,
            wmClass: 'test-app',
        });
    }

    /** @returns {object} The inputs a pass carries; the ring is flat. */
    function passInputs() {
        return {insets: {left: 0, top: 0, right: 0, bottom: 0}, monitorScale: 1};
    }

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
            hasShadow: false,
            hasResizeBand: false,
            ring: null,
            overview: {inOverview: false, hasMask: false, hasShadow: false, hasContainer: false, isProbed: false},
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
        deco._syncClip(true, mockActor, insets, false);
        expect(deco.hasClip).toBeTrue();
        expect(deco.clip.enabled).toBeTrue();
        expect(mockActor.effects).toContain(deco.clip);

        // Detach clip
        deco._syncClip(false, mockActor, null, false);
        expect(deco.hasClip).toBeFalse();
        expect(mockActor.effects.length).toBe(0);

        // Attach clip while in overview, with the style already decided -> the clip is
        // suspended so the preview clone samples the window's own mipmapped texture
        // instead of an offscreen FBO.
        deco.drawClip = true;
        deco._style = {radius: 12, outline: null, shadows: []};
        deco._syncClip(true, mockActor, insets, true);
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
            drawRing: false,
            drawShadow: true,
            drawResize: true,
            ring: {clear: false, safeInset: false},
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

    it('resolves the ring plan once and exposes it through the state view', () => {
        // A flat ringless window: the clip sits 1px inside to excise the client's rectangular
        // border, so the plan erases the ring while the client declared none to push.
        const flat = setupMaskHarness({drawClip: true, drawShadow: true});
        expect(flat.deco.stateView.ring).toEqual({
            insets: FLAT_SAFE_INSET,
            clear: false,
            erase: true,
        });

        // A declared ring with a shadow: the shadow is ours, so the ring is both erased and
        // the client's ring is true (the clip pushes the stroke), and the body stays on the declared insets.
        const declared = {left: 12, top: 12, right: 12, bottom: 12};
        const ringed = setupMaskHarness({drawClip: true, drawShadow: true, ringClear: true, insets: declared});
        expect(ringed.deco.stateView.ring).toEqual({
            insets: declared,
            clear: true,
            erase: true,
        });
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
            drawRing: false,
            drawShadow: true,
            drawResize: true,
            ring: {clear: true, safeInset: false},
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

    it('forces erase true on windows without shadow insets (e.g. WeChat) to eliminate outer corner fringe', () => {
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
            drawRing: false,
            drawShadow: true,
            drawResize: true,
            ring: {clear: false, safeInset: true},
            style: {radius: 15, outline, shadows: []},
        };
        const zeroInsets = {left: 0, top: 0, right: 0, bottom: 0};
        const inputs = {
            insets: zeroInsets,
            monitorScale: 1,
        };

        deco.apply({actions, inputs, actor: mockActor});
        expect(deco.hasClip).toBeTrue();
        // The client declared no ring, so the plan keeps `clear` false while `erase` is true so
        // the shader erases the outer rectangular corners. It must leave clearStroke false so the
        // shader preserves 1:1 sampling without pushing coords inward.
        // Flat ringless windows use FLAT_SAFE_INSET (1px inward) to excise rectangular client borders,
        // while retaining Adwaita inner outline on desktop to achieve seamless native decoration consistency.
        expect(deco.ring.clear).toBeFalse();
        expect(deco.ring.erase).toBeTrue();
        expect(deco.clipInsets).toEqual(FLAT_SAFE_INSET);
        expect(deco.clip.params.insets).toEqual(FLAT_SAFE_INSET);
        expect(deco.shadow.insets).toEqual(FLAT_SAFE_INSET);
        expect(deco.clip.params.erase).toBeTrue();
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
            drawRing: false,
            drawShadow: true,
            drawResize: true,
            ring: {clear: true, safeInset: false},
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
        expect(deco.clip.params.erase).toBeTrue();
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
        deco._syncClip(true, mockActor, insets);
        deco._syncShadow(true, mockActor);
        deco._syncResizeBand(true, {monitorScale: 1}, insets, mockActor);

        const shadowRef = deco.shadow;
        const bandRef = deco.resizeBand;

        deco.destroy();

        expect(deco.hasClip).toBeFalse();
        expect(deco.hasShadow).toBeFalse();
        expect(deco.hasResizeBand).toBeFalse();
        expect(shadowRef.destroyed).toBeTrue();
        expect(bandRef.destroyed).toBeTrue();
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
        deco._syncClip(true, mockActor, insets);
        deco._syncShadow(true, mockActor);
        deco._syncResizeBand(true, {monitorScale: 1}, insets, mockActor);

        const shadowRef = deco.shadow;
        const bandRef = deco.resizeBand;

        deco.destroy({keepVisualsForClose: true});

        // ResizeBand is cleared
        expect(deco.hasResizeBand).toBeFalse();
        expect(bandRef.destroyed).toBeTrue();

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
            hasShadow: false,
            hasResizeBand: false,
            ring: null,
            overview: {inOverview: false, hasMask: false, hasShadow: false, hasContainer: false, isProbed: false},
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
            drawRing: false,
            drawShadow: true,
            drawResize: true,
            ring: {clear: true, safeInset: false},
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

        // For flat ringless windows (ring.clear=false), outline is active on desktop and suppressed in overview
        deco.apply({actions: {...actions, ring: {...actions.ring, clear: false}}, inputs, actor: mockActor});
        expect(deco.clip.params.outline).toEqual(outline);
        deco.setOverviewMode(true);
        expect(deco.clip.params.outline).toBeNull();
        deco.setOverviewMode(false);
        expect(deco.clip.params.outline).toEqual(outline);

        // On ringed windows (ring.clear=true), clearStroke is suppressed in overview.
        const ringedActions = {...actions, ring: {...actions.ring, clear: true}};
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

    it('probes the screenshot path once per overview entry, not per reconcile', () => {
        const harness = setupMaskHarness();

        harness.deco.setOverviewMode(true);
        const afterEntry = harness.probeCalls();
        expect(afterEntry).toBeGreaterThan(0);

        // Reconciles while the overview is open must reuse the answer: the probe is the one
        // thing here that reads a texture back from the GPU.
        harness.deco.setOverviewMode(true);
        harness.deco.setOverviewMode(true);
        expect(harness.probeCalls()).toBe(afterEntry);

        // A fresh entry asks again.
        harness.deco.setOverviewMode(false);
        harness.deco.setOverviewMode(true);
        expect(harness.probeCalls()).toBe(afterEntry + 1);
    });

    it('re-probes when a workspace move or a resize rebuilds the card, then caches again', () => {
        const harness = setupMaskHarness();
        harness.deco.setOverviewMode(true);
        const afterEntry = harness.probeCalls();

        // Both rebuild the card, and the client's buffer may have moved with it, so the answer
        // is asked again - and the rebuilt card's own reconciles reuse it.
        for (const signal of ['workspace-changed', 'size-changed']) {
            const handler = harness.windowSignals.find(s => s.signal === signal);
            expect(handler).toBeDefined();
            handler.cb();
            expect(harness.probeCalls()).toBe(afterEntry + 1 + ['workspace-changed', 'size-changed'].indexOf(signal));

            harness.deco.setOverviewMode(true);
            expect(harness.probeCalls()).toBe(afterEntry + 1 + ['workspace-changed', 'size-changed'].indexOf(signal));
        }
    });

    it('leaves XWayland windows square and sharp, never touching the mask slot', () => {
        const {surface, deco} = setupMaskHarness({clientType: WindowClientType.X11, drawShadow: true});
        expect(deco.overview.canApplyMask({drawClip: true, hasStyle: true})).toBeFalse();

        deco.setOverviewMode(true);
        expect(deco.clip.enabled).toBeFalse();
        expect(surface.mask).toBeNull();

        // Forcing corners keeps the legacy offscreen clip instead - which never touches that
        // slot either, so the window's shape survives the overview.
        const forced = setupMaskHarness({clientType: WindowClientType.X11, forceOverviewCorners: true});
        forced.deco.setOverviewMode(true);
        expect(forced.deco.clip.enabled).toBeTrue();
        expect(forced.surface.mask).toBeNull();
    });

    it('skips the mask for a Wayland window whose desktop screenshot it would change', () => {
        const {surface, deco} = setupMaskHarness({maskWouldChangeScreenshot: true});

        deco.setOverviewMode(true);
        expect(deco.clip.enabled).toBeFalse();
        expect(surface.mask).toBeNull();

        const forced = setupMaskHarness({maskWouldChangeScreenshot: true, forceOverviewCorners: true});
        forced.deco.setOverviewMode(true);
        expect(forced.deco.clip.enabled).toBeTrue();
        expect(forced.surface.mask).toBeNull();
    });

    it('applies the shaped-texture mask and the container-opacity bypass on Wayland', () => {
        const {mask, opaque, surface, container, deco} = setupMaskHarness();

        deco.setOverviewMode(true);
        expect(surface.mask).toBe(mask);
        expect(container.opacity).toBe(254);
        expect(deco.clip.enabled).toBeFalse();

        deco.setOverviewMode(false);
        expect(surface.mask).toBe(opaque);
        expect(container.opacity).toBe(255);
        expect(deco.clip.enabled).toBeTrue();
    });

    it('keeps the corner state current on a pass that draws nothing', () => {
        // A decorated window first, so the previous pass left drawClip true and the overview
        // would happily mask it.
        const {deco} = setupMaskHarness({drawClip: true});
        expect(deco.stateView.drawClip).toBeTrue();

        // Maximized: the same window now draws neither corners nor shadow. The pass must clear
        // the previous reading, or the overview masks a preview whose desktop is square.
        deco.apply({actions: maximizedActions(), inputs: passInputs(), actor: mockActor});

        expect(deco.stateView.drawClip).toBeFalse();
        expect(deco.overview.canApplyMask({
            drawClip: deco.stateView.drawClip,
            hasStyle: Boolean(deco._style),
        })).toBeFalse();
    });

    it('retires the overview mask when a reconcile makes the window unmaskable', () => {
        const {mask, opaque, surface, deco, opaqueCalls} = setupMaskHarness();
        deco.setOverviewMode(true);
        expect(surface.mask).toBe(mask);
        const before = opaqueCalls();

        // Still inside the same overview entry, but now maximized: nothing left to round. The
        // preview must take the opaque mask back instead of keeping the stale rounded one.
        deco.apply({actions: maximizedActions(), inputs: passInputs(), actor: mockActor, inOverview: true});

        expect(opaqueCalls()).toBeGreaterThan(before);
        expect(surface.mask).toBe(opaque);
        expect(deco.overview.stateView.hasMask).toBeFalse();
    });

    it('re-applies the mask when the window moves to another workspace in the overview', () => {
        const {mask, surface, container, makeContainer, windowSignals, deco} = setupMaskHarness();

        deco.setOverviewMode(true);
        expect(container.opacity).toBe(254);
        expect(surface.mask).toBe(mask);

        // The window moves to another workspace: a fresh preview with its container at full opacity.
        const secondCard = makeContainer();
        mockWin._delegate = {window_container: secondCard};
        const moved = windowSignals.find(s => s.signal === 'workspace-changed');
        expect(moved).toBeDefined();
        moved.cb();

        expect(secondCard.opacity).toBe(254);
        expect(surface.mask).toBe(mask);
    });

    it('gives the overview shadow to a window that has no clip (prefer-crisp-text)', () => {
        const {shadowClones, deco} = setupMaskHarness({drawClip: false, drawShadow: true});
        expect(deco.hasClip).toBeFalse();
        expect(deco.hasShadow).toBeTrue();

        deco.setOverviewMode(true);
        expect(shadowClones.length).toBe(1);

        deco.setOverviewMode(false);
        expect(shadowClones[0].destroyed).toBeTrue();
    });

    it('re-mounts the shadow clone when the window moves to another workspace', () => {
        const {shadowClones, makeContainer, windowSignals, deco} = setupMaskHarness({drawShadow: true});
        deco.setOverviewMode(true);
        expect(shadowClones.length).toBe(1);

        // The workspace move destroys the old preview, taking its clone with it.
        shadowClones[0].destroy();
        const secondCard = makeContainer();
        mockWin._delegate = {window_container: secondCard};
        windowSignals.find(s => s.signal === 'workspace-changed').cb();

        expect(shadowClones.length).toBe(2);
        expect(shadowClones[1].container).toBe(secondCard);
    });

    it('sizes the overview mask to the largest preview the overview can draw, then caps it', () => {
        const deco = new WindowDecoration(mockWin, {
            container: mockContainer,
            display: mockDisplay,
        });

        // 1x buffer on a 1x monitor: the preview tops out at 0.95 of the window.
        expect(deco.overview._overviewMaskScale(800, 600, 1, 1)).toBe(0.95);
        // A hidpi buffer on a low-dpi monitor is downsampled to the on-screen size.
        expect(deco.overview._overviewMaskScale(4000, 2400, 2, 1)).toBeCloseTo(0.475, 5);
        // Above the cap, the longest side is pinned at OVERVIEW_MASK_MAX_DIMENSION.
        expect(deco.overview._overviewMaskScale(3840, 2160, 1, 1)).toBeCloseTo(2560 / 3840, 5);
        expect(deco.overview._overviewMaskScale(7680, 4320, 1, 1)).toBeCloseTo(2560 / 7680, 5);
        // Never degenerate.
        expect(deco.overview._overviewMaskScale(100000, 100000, 1, 1)).toBe(0.05);
    });
});
