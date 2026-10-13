import {WindowDecoration} from '../src/lib/windowDecoration.js';
import {OverviewDecoration} from '../src/lib/overviewDecoration.js';
import {WindowClientType} from '../src/lib/mutterRules.generated.js';
import {FLAT_SAFE_INSET} from '../src/lib/frame.js';
import {evaluateWindowActions} from '../src/lib/detector.js';
import {computeResizeBands, emptyBands} from '../src/lib/resizeBand.js';

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
     * @param {boolean} [options.buildRoundedMaskReturnsNull=false]
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
        buildRoundedMaskReturnsNull = false,
        forceOverviewCorners = false,
    } = {}) {
        mockWin.get_client_type = () => clientType;

        const mask = {tag: 'rounded'};
        const opaque = {tag: 'opaque'};
        let probeCalls = 0;
        let opaqueCalls = 0;
        let probeAnswer = maskWouldChangeScreenshot;
        let bufferWidth = 800;
        let bufferHeight = 600;
        let buildReturnsNull = buildRoundedMaskReturnsNull;
        const OverviewMask = {
            buildRoundedMask: () => (buildReturnsNull ? null : mask),
            opaqueMask: () => {
                opaqueCalls++;
                return opaque;
            },
            maskWouldChangeScreenshot: () => {
                probeCalls++;
                return probeAnswer;
            },
        };
        const makeSurface = () => ({
            mask: null,
            hasMask: false,
            set_mask_texture(texture) {
                // GJS rejects a null mask ("Argument mask_texture may not be null"), so the only
                // way to retire our mask is the neutral opaque one. Model both facts so a spec
                // cannot pass by pretending the slot was detached.
                if (texture === null || texture === undefined)
                    throw new Error('Argument mask_texture may not be null');
                this.mask = texture;
                this.hasMask = true;
            },
            get_texture: () => ({
                get_plane: () => ({get_context: () => ({})}),
                get_width: () => bufferWidth,
                get_height: () => bufferHeight,
            }),
        });
        const surface = makeSurface();
        // The window actor's live shaped texture. A `MetaWindowActor` can be handed a new one;
        // the probe verdict is keyed to the texture, so a spec can swap it to pin that.
        let activeSurface = surface;
        mockActor.get_texture = () => activeSurface;

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
            mask, opaque, surface, makeSurface, container, makeContainer, windowSignals, shadowClones,
            setShapedTexture: next => {
                activeSurface = next;
            },
            probeCalls: () => probeCalls,
            opaqueCalls: () => opaqueCalls,
            // Lets a spec stage the shaped texture's own state: a probe answer and the buffer the
            // answer was read from. The real texture is one object across a buffer commit, so a
            // spec that changes both models the same identity gaining a buffer.
            setProbeAnswer: value => {
                probeAnswer = value;
            },
            setBuildReturnsNull: value => {
                buildReturnsNull = value;
            },
            setBuffer: (width, height) => {
                bufferWidth = width;
                bufferHeight = height;
            },
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

        // A readable monitor carries its rect and is clipped to it.
        mockWin.get_monitor = () => 0;
        deco._syncResizeBand(true, {...inputs, monitorScale: 1}, insets, mockActor);
        expect(deco.resizeBand.geometry.boundsUnknown).toBeFalse();
        expect(deco.resizeBand.geometry.bounds).toEqual({x: 0, y: 0, width: 1920, height: 1080});

        // The same window once the monitor index goes stale: unknown, so the band drops this pass
        // instead of writing strips at full extent onto a neighbouring monitor.
        mockWin.get_monitor = () => 99;
        deco._syncResizeBand(true, {...inputs, monitorScale: 3}, insets, mockActor);
        expect(deco.resizeBand.geometry.bounds).toBeNull();
        expect(deco.resizeBand.geometry.boundsUnknown).toBeTrue();

        // Remove band
        deco._syncResizeBand(false, inputs, insets, mockActor);
        expect(deco.hasResizeBand).toBeFalse();
    });

    it('keeps the last good scale when a later pass cannot read the monitor scale', () => {
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
            style: {radius: 12, outline: null, shadows: []},
        };
        const insets = {left: 10, top: 10, right: 10, bottom: 10};

        deco.apply({actions, inputs: {insets, monitorScale: 1.5}, actor: mockActor});
        expect(deco.clip.params.scale).toBe(1.5);
        expect(deco.shadow.scale).toBe(1.5);
        expect(deco.resizeBand.geometry.scale).toBe(1.5);

        // The scale read fails. The clip cut, shadow cutout and band keep the scale the display
        // was built at rather than jumping to 1.0, which would move a correct fractional display.
        deco.apply({actions, inputs: {insets, monitorScale: null}, actor: mockActor});
        expect(deco.clip.params.scale).toBe(1.5);
        expect(deco.shadow.scale).toBe(1.5);
        expect(deco.resizeBand.geometry.scale).toBe(1.5);
    });

    it('keeps the 1.25 last-good scale across a null read, not the 1.0 identity', () => {
        // The reviewer's exact case: an initialised-on-construction cache updated only by a usable
        // read, so 1.25 survives a null. A constructor-only `_scale = 1.0` fallback would return
        // 1.0 here, and a correct fractional display would jump and back on every read failure.
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
            style: {radius: 12, outline: null, shadows: []},
        };
        const insets = {left: 10, top: 10, right: 10, bottom: 10};

        deco.apply({actions, inputs: {insets, monitorScale: 1.25}, actor: mockActor});
        deco.apply({actions, inputs: {insets, monitorScale: null}, actor: mockActor});

        expect(deco._resolveScale({monitorScale: null})).toBe(1.25);
        expect(deco.clip.params.scale).toBe(1.25);
        expect(deco.shadow.scale).toBe(1.25);
        expect(deco.resizeBand.geometry.scale).toBe(1.25);
    });

    it('clears every resize band while the monitor bounds cannot be read', () => {
        // A window flush against the right edge of monitor 0. Its strips reach RESIZE_BAND past
        // the edge: with readable bounds they are clipped at the monitor, but reading the
        // unreadable null as the pure function's "do not clip" would write them full-extent onto
        // the neighbouring monitor, where they swallow its clicks.
        const frame = {x: 1815, y: 100, width: 100, height: 300};
        const hazard = computeResizeBands({frame, bounds: null, boundsUnknown: false});
        expect(hazard.top.x + hazard.top.width).toBe(1927);

        const deco = new WindowDecoration(mockWin, {
            container: mockContainer,
            display: mockDisplay,
            RoundedClipEffect: MockClipEffect,
            ShadowActor: MockShadowActor,
            ResizeBand: MockResizeBand,
        });
        const insets = {left: 8, top: 8, right: 8, bottom: 8};

        mockWin.get_monitor = () => 99; // stale: resolveMonitorBounds answers null
        deco._syncResizeBand(true, {monitorScale: 1}, insets, mockActor);

        const geo = deco.resizeBand.geometry;
        expect(geo.bounds).toBeNull();
        expect(geo.boundsUnknown).toBeTrue();
        expect(computeResizeBands({frame, bounds: geo.bounds, boundsUnknown: geo.boundsUnknown}))
            .toEqual(emptyBands());
    });

    it('rebuilds the resize bands once the monitor bounds are readable again', () => {
        const frame = {x: 1815, y: 100, width: 100, height: 300};
        const deco = new WindowDecoration(mockWin, {
            container: mockContainer,
            display: mockDisplay,
            RoundedClipEffect: MockClipEffect,
            ShadowActor: MockShadowActor,
            ResizeBand: MockResizeBand,
        });
        const insets = {left: 8, top: 8, right: 8, bottom: 8};

        mockWin.get_monitor = () => 99;
        deco._syncResizeBand(true, {monitorScale: 1}, insets, mockActor);
        const cleared = deco.resizeBand.geometry;
        expect(computeResizeBands({frame, bounds: cleared.bounds, boundsUnknown: cleared.boundsUnknown}))
            .toEqual(emptyBands());

        // The monitor comes back: the rect is readable and the strips are rebuilt, clipped at the
        // edge, so edge resizing works again.
        mockWin.get_monitor = () => 0;
        deco._syncResizeBand(true, {monitorScale: 1}, insets, mockActor);
        const restored = deco.resizeBand.geometry;
        expect(restored.boundsUnknown).toBeFalse();
        const bands = computeResizeBands({frame, bounds: restored.bounds, boundsUnknown: restored.boundsUnknown});
        expect(bands.right).toEqual({x: 1915, y: 100, width: 5, height: 300});
        expect(bands.top.x + bands.top.width).toBe(1920);
    });

    it('keeps the last good clip target while the container is unallocated, then re-verifies', () => {
        const container = {x: 0, y: 0, width: 0, height: 0};
        mockWin.get_buffer_rect = () => ({x: 0, y: 0, width: 800, height: 600});
        mockActor.get_children = () => [container];

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
            drawShadow: false,
            drawResize: false,
            ring: {clear: false, safeInset: false},
            style: {radius: 12, outline: null, shadows: []},
        };
        const inputs = {insets: {left: 8, top: 8, right: 8, bottom: 8}, monitorScale: 1};

        // First pass: the container is not allocated, so the choice defers with no earlier target
        // and the window actor - always present and verified - is the fallback.
        deco.apply({actions, inputs, actor: mockActor});
        expect(deco.clipTarget).toBe(mockActor);
        expect(deco.clipPhaseInTransform).toBeFalse();

        // The container allocates; the next apply (the manager's notify::allocation re-run)
        // re-verifies and targets the container.
        container.width = 800;
        container.height = 600;
        deco.apply({actions, inputs, actor: mockActor});
        expect(deco.clipTarget).toBe(container);
        expect(deco.clipPhaseInTransform).toBeTrue();

        // It loses its allocation again: the clip keeps its last good target (the container)
        // rather than re-pinning to the window actor for the pass.
        container.width = 0;
        container.height = 0;
        deco.apply({actions, inputs, actor: mockActor});
        expect(deco.clipTarget).toBe(container);
        expect(deco.clipPhaseInTransform).toBeTrue();
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

    it('asks the safety probe once per shaped texture, never after our own mask can poison it', () => {
        const harness = setupMaskHarness();

        harness.deco.setOverviewMode(true);
        const afterEntry = harness.probeCalls();
        expect(afterEntry).toBe(1);

        // Reconciles while the overview is open must reuse the answer: the probe is the one
        // thing here that reads a texture back from the GPU.
        harness.deco.setOverviewMode(true);
        harness.deco.setOverviewMode(true);
        expect(harness.probeCalls()).toBe(afterEntry);

        // A fresh entry must reuse it too. Once our mask is on the shaped texture, the probe's
        // own early-out answers NULL forever, so asking again would only read our own mask.
        harness.deco.setOverviewMode(false);
        harness.deco.setOverviewMode(true);
        expect(harness.probeCalls()).toBe(afterEntry);
    });

    it('reuses the probe answer when a workspace move or a resize rebuilds the card', () => {
        const harness = setupMaskHarness();
        harness.deco.setOverviewMode(true);
        const afterEntry = harness.probeCalls();

        // Both rebuild the card; the shaped texture is the same one the answer was taken from,
        // so the safety decision is reused while the mask itself is rebuilt.
        for (const signal of ['workspace-changed', 'size-changed']) {
            const handler = harness.windowSignals.find(s => s.signal === signal);
            expect(handler).toBeDefined();
            handler.cb();
            expect(harness.probeCalls()).toBe(afterEntry);

            harness.deco.setOverviewMode(true);
            expect(harness.probeCalls()).toBe(afterEntry);
        }
    });

    it('re-asks when the probe cannot tell, instead of locking the window square', () => {
        // "Cannot tell" (the member is missing, or the readback threw) is not a verdict. Caching
        // it is what made a transient failure a permanent square, so the next entry must ask again.
        const harness = setupMaskHarness({maskWouldChangeScreenshot: null});

        harness.deco.setOverviewMode(true);
        expect(harness.probeCalls()).toBe(1);

        harness.deco.setOverviewMode(false);
        harness.deco.setOverviewMode(true);
        expect(harness.probeCalls()).toBe(2);
    });

    it('takes no verdict from a bufferless texture, then decides once a buffer arrives', () => {
        // The first Overview entry can race the client's first buffer. Mutter's NULL branch "no
        // buffer yet" cannot be told apart from the others from GJS, so the window must stay
        // square and store no verdict; the buffer's arrival is what earns a real observation.
        const harness = setupMaskHarness({maskWouldChangeScreenshot: true});
        harness.setBuffer(0, 0);
        harness.deco.setOverviewMode(true);

        expect(harness.probeCalls()).toBe(0);
        expect(harness.deco.overview.stateView.isProbed).toBeFalse();
        expect(harness.surface.hasMask).toBeFalse();

        // The buffer arrives. The probe is taken once, on a real texture, and its verdict is
        // final: this answer is "would change", so the window stays out of the mask slot.
        harness.setBuffer(800, 600);
        harness.deco.setOverviewMode(true);

        expect(harness.probeCalls()).toBe(1);
        expect(harness.deco.overview.stateView.isProbed).toBeTrue();
        expect(harness.surface.hasMask).toBeFalse();
        expect(harness.surface.mask).toBeNull();
    });

    it('takes no verdict from a buffered texture whose draw target is not paintably allocated', () => {
        // "Has a backing buffer" is not "the current draw target is valid": a valid buffer with a
        // momentarily zero-sized draw target must not cache a NULL as a final "masking is safe",
        // or the target's recovery would keep the stale verdict. The window actor's allocation is
        // the readable authority for the draw target, so a zero allocation earns no verdict.
        const harness = setupMaskHarness({maskWouldChangeScreenshot: false});
        mockActor.width = 0;
        mockActor.height = 0;
        harness.deco.setOverviewMode(true);

        expect(harness.probeCalls()).toBe(0);
        expect(harness.deco.overview.stateView.isProbed).toBeFalse();
        expect(harness.surface.hasMask).toBeFalse();

        // The draw target recovers: the same buffered texture now earns one fresh observation,
        // and its "safe" NULL installs the rounded mask.
        mockActor.width = 800;
        mockActor.height = 600;
        harness.deco.setOverviewMode(true);

        expect(harness.probeCalls()).toBe(1);
        expect(harness.deco.overview.stateView.isProbed).toBeTrue();
        expect(harness.surface.mask).toBe(harness.mask);
    });

    it('re-probes when the window actor carries a new shaped texture (the verdict is keyed to it)', () => {
        // The retained verdict belongs to the shaped texture, not to the decoration instance. A
        // replaced texture is a different key that has never seen our mask, so it earns a fresh
        // observation instead of inheriting an answer about the old buffer.
        const harness = setupMaskHarness({maskWouldChangeScreenshot: true});
        harness.deco.setOverviewMode(true);
        const decided = harness.probeCalls();
        expect(decided).toBe(1);
        expect(harness.surface.hasMask).toBeFalse();

        const replacement = harness.makeSurface();
        harness.setShapedTexture(replacement);
        harness.deco.setOverviewMode(true);

        expect(harness.probeCalls()).toBe(decided + 1);
    });

    it('never re-probes a decided texture after our own mask has touched it', () => {
        // The first probe is a NULL on a buffered texture, read before we touched anything:
        // the "masking is safe" verdict, which installs the rounded mask.
        const harness = setupMaskHarness({maskWouldChangeScreenshot: false});
        harness.deco.setOverviewMode(true);
        expect(harness.surface.mask).toBe(harness.mask);
        const decided = harness.probeCalls();
        expect(decided).toBe(1);

        // The client commits a different-sized buffer; the card rebuild clears the mask first,
        // which installs our opaque one and puts Mutter on the offscreen path. A re-probe here
        // would read that mutation as a fresh "safe" NULL - the pre-fix code did exactly that.
        // The verdict is final, so no probe is taken and the rounded mask is re-installed.
        harness.setBuffer(1600, 1200);
        harness.setProbeAnswer(null);
        harness.windowSignals.find(s => s.signal === 'size-changed').cb();

        expect(harness.probeCalls()).toBe(decided);
        expect(harness.surface.mask).toBe(harness.mask);
    });

    it('keeps the verdict across drop(), so a re-entry cannot re-read a texture we masked', () => {
        // Entering installs the rounded mask and records the verdict. drop() retires that mask
        // through the opaque 1x1 - which has already moved Mutter off the direct-read path - and
        // the same shaped texture is still there. A re-entry that re-probed it would read our own
        // mutation, the contamination rule 4 forbids, so the verdict outlives the entry.
        const harness = setupMaskHarness({maskWouldChangeScreenshot: false});
        harness.deco.setOverviewMode(true);
        expect(harness.surface.mask).toBe(harness.mask);
        const decided = harness.probeCalls();
        expect(decided).toBe(1);

        harness.deco.overview.drop();
        harness.deco.setOverviewMode(true);

        expect(harness.probeCalls()).toBe(decided);
        expect(harness.surface.mask).toBe(harness.mask);
    });

    it('reports the mode it actually installed when the mask build declines', () => {
        const readings = {
            radius: 12,
            insets: {left: 0, top: 0, right: 0, bottom: 0},
            erase: false,
            scale: 1,
            drawClip: true,
            hasStyle: true,
            shadow: null,
        };

        // The mask builder returns null, so nothing is installed. The pass must report the
        // fallback the window is left in, not the mask it hoped to install.
        const square = setupMaskHarness({buildRoundedMaskReturnsNull: true});
        expect(square.deco.overview.setMode(true, readings)).toBe('square');
        expect(square.surface.hasMask).toBeFalse();

        // force-overview-corners asks for the legacy clip when the mask is unavailable; the
        // returned mode is what tells WindowDecoration to keep that clip enabled.
        const forced = setupMaskHarness({buildRoundedMaskReturnsNull: true});
        expect(forced.deco.overview.setMode(true, {...readings, forceOverviewCorners: true}))
            .toBe('clip');
        expect(forced.surface.hasMask).toBeFalse();

        // A successful build still reports the mask it installed.
        const masked = setupMaskHarness();
        expect(masked.deco.overview.setMode(true, readings)).toBe('mask');
        expect(masked.surface.hasMask).toBeTrue();
    });

    it('keeps the forced legacy clip when the mask cannot actually be installed', () => {
        const {surface, deco} = setupMaskHarness({
            forceOverviewCorners: true,
            buildRoundedMaskReturnsNull: true,
        });
        expect(deco.hasClip).toBeTrue();

        deco.setOverviewMode(true);

        // Neither visual fired would be the bug: no mask landed, so the forced clip must stay on
        // instead of being disabled by a 'mask' the overview never installed.
        expect(surface.mask).toBeNull();
        expect(deco.clip.enabled).toBeTrue();
    });

    it('follows a refresh that lands a mask after the entry could not install one', () => {
        const harness = setupMaskHarness({
            forceOverviewCorners: true,
            buildRoundedMaskReturnsNull: true,
        });
        const {surface, deco} = harness;

        // Entry: the mask builder declines, so the forced legacy clip is the mode in force.
        deco.setOverviewMode(true);
        expect(surface.hasMask).toBeFalse();
        expect(deco.clip.enabled).toBeTrue();

        // A refresh can now build the mask. The mode flips to 'mask', so the clip - the alternative
        // rounding path - must be suspended; leaving it on would clip the preview twice.
        harness.setBuildReturnsNull(false);
        harness.windowSignals.find(s => s.signal === 'size-changed').cb();

        expect(surface.mask).toBe(harness.mask);
        expect(deco.clip.enabled).toBeFalse();
    });

    it('follows a refresh that loses the mask back to the forced clip', () => {
        const harness = setupMaskHarness({forceOverviewCorners: true});
        const {surface, opaque, deco} = harness;

        // Entry: the mask lands, so the clip is suspended.
        deco.setOverviewMode(true);
        expect(surface.mask).toBe(harness.mask);
        expect(deco.clip.enabled).toBeFalse();

        // A refresh whose builder now declines retires the mask to the opaque one; the forced clip
        // is the only rounding left, so it must come back on.
        harness.setBuildReturnsNull(true);
        harness.windowSignals.find(s => s.signal === 'size-changed').cb();

        expect(surface.mask).toBe(opaque);
        expect(deco.clip.enabled).toBeTrue();
    });

    it('never rounds a window that has left the overview', () => {
        const {mask, opaque, surface, deco, probeCalls} = setupMaskHarness();

        deco.setOverviewMode(true);
        expect(surface.mask).toBe(mask);
        const afterEntry = probeCalls();

        // Leaving retires our rounded mask to Mutter's neutral opaque one, which is the only
        // retirement GJS allows (`set_mask_texture` rejects null).
        deco.setOverviewMode(false);
        expect(surface.mask).toBe(opaque);
        expect(surface.hasMask).toBeTrue();
        expect(deco.overview.stateView.hasMask).toBeFalse();

        // A reconcile after the exit, and the mask path invoked directly, must not round it
        // again: the invariant is that the rounded mask is only installed in the overview.
        deco.setOverviewMode(false);
        deco.overview._applyMask();
        deco.apply({actions: maximizedActions(), inputs: passInputs(), actor: mockActor});
        expect(surface.mask).toBe(opaque);
        expect(deco.overview.stateView.hasMask).toBeFalse();
        expect(probeCalls()).toBe(afterEntry);
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

    it('does not let an unreadable frame rect escape the shadow clone build', () => {
        // The clone's width comes from the frame rect, read from window size-changed and
        // workspace-changed handlers. A throw there must become "no shadow this pass", not an
        // exception out of a Clutter signal handler.
        const {shadowClones, deco} = setupMaskHarness({drawShadow: true});
        mockWin.get_frame_rect = () => { throw new Error('Object has been finalized'); };

        expect(() => deco.setOverviewMode(true)).not.toThrow();
        expect(shadowClones.length).toBe(0);
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

describe('OverviewDecoration.canApplyMask (client-type eligibility)', () => {
    const canMask = clientType => new OverviewDecoration({
        get_client_type: () => clientType,
    }).canApplyMask({drawClip: true, hasStyle: true});

    it('refuses an unreadable client type instead of reading it as maskable', () => {
        // `getWindowClientType` answers null when the getter throws. An XWayland window whose
        // type we cannot read must not have its shared shape mask overwritten; only a type we
        // actually read may take the mask slot.
        expect(canMask(null)).toBeFalse();
        expect(canMask(undefined)).toBeFalse();
    });

    it('refuses X11, whose shared shape mask Mutter owns and GJS cannot restore', () => {
        expect(canMask(WindowClientType.X11)).toBeFalse();
    });

    it('allows Wayland, whose mask slot the overview owns', () => {
        expect(canMask(WindowClientType.WAYLAND)).toBeTrue();
    });

    it('refuses when there is no corner to mask or no style resolved', () => {
        const deco = new OverviewDecoration({get_client_type: () => WindowClientType.WAYLAND});
        expect(deco.canApplyMask({drawClip: false, hasStyle: true})).toBeFalse();
        expect(deco.canApplyMask({drawClip: true, hasStyle: false})).toBeFalse();
    });
});
