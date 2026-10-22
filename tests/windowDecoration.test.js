import {WindowDecoration} from '../src/lib/windowDecoration.js';
import {Journal} from '../src/platform/journal.js';
import {resolvePaintBody} from '../src/effects/clipParams.js';
import {clipParamsFrom, shadowStyleFrom} from '../src/effects/decorationPass.js';
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
    let hadGlobal;
    let originalGlobal;

    // Spy classes
    class MockClipEffect {
        constructor(St = null) {
            this.St = St;
            this.enabled = true;
            this.params = null;
            // Models Clutter's actor back-reference: add_effect()/remove_effect() on an actor
            // set/clear it, so get_actor() reports the effect's real attachment.
            this._actor = null;
        }

        set_enabled(val) {
            this.enabled = val;
        }

        setParams(params) {
            this.params = params;
        }

        setBodyPlan(plan) {
            this.bodyPlan = plan;
        }

        // Mirrors the real effect's handoff: the recorded parameters come from the same derivation the
        // effect uses, so the fake cannot disagree with it about what a pass means.
        applyPass(pass) {
            this.pass = pass;
            this.setParams(clipParamsFrom(pass));
            this.setBodyPlan(pass.bodyPlan);
        }

        get_actor() {
            return this._actor;
        }

        // The real effect queues its disable on an idle; detaching it has to drop that idle.
        cancelPendingDisable() {
            this.cancelled = (this.cancelled ?? 0) + 1;
        }
    }

    class MockShadowActor {
        constructor(actor, container, St = null) {
            this.actor = actor;
            this.container = container;
            this.St = St;
            this.destroyed = false;
            this.insets = null;
            this.style = null;
            this.scale = 1;
            this.clipTarget = null;
        }

        setScale(scale) {
            this.scale = scale;
        }

        setClipTarget(clipTarget) {
            this.clipTarget = clipTarget;
        }

        setBodyPlan(plan) {
            this.bodyPlan = plan;
        }

        get diagnosticsView() {
            return {
                width: 824,
                height: 624,
                cast: {x: 0, y: 0, width: 824, height: 624},
                rightBand: {x1: 812, y1: 0, x2: 824, y2: 624},
            };
        }

        setShadowInsets(insets) {
            this.insets = insets;
        }

        setShadowStyle(style) {
            this.style = style;
        }

        // Mirrors the real actor's handoff, in the same order: a scale that is not a usable number
        // leaves the previous one in place, as `setScale` does.
        applyPass(pass) {
            this.pass = pass;
            this.phaseInTransform = pass.phaseInTransform;
            this.clipTarget = pass.clipTarget;
            this.bodyPlan = pass.bodyPlan;
            if (typeof pass.scale === 'number' && pass.scale > 0)
                this.scale = pass.scale;
            this.setShadowInsets(pass.ring?.insets ?? null);
            this.setShadowStyle(shadowStyleFrom(pass));
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

    /**
     * An actor mock that models Clutter's effect back-reference: add_effect()/remove_effect()
     * set/clear the effect's own actor, so a spec can assert where the effect really is rather
     * than only the decoration's bookkeeping field.
     *
     * @param {object} [extra] - Extra fields (e.g. a surface container's x/y/width/height)
     * @returns {object}
     */
    function makeEffectActor(extra = {}) {
        return {
            width: 800,
            height: 600,
            effects: [],
            add_effect(eff) {
                this.effects.push(eff);
                eff._actor = this;
            },
            remove_effect(eff) {
                this.effects = this.effects.filter(e => e !== eff);
                if (eff._actor === this)
                    eff._actor = null;
            },
            ...extra,
        };
    }

    beforeEach(() => {
        // The overview's previews are read through the stage, so a spec that fakes one has to
        // put the real `global` back; capture it here rather than in the harness, which a spec
        // may call more than once.
        hadGlobal = 'global' in globalThis;
        originalGlobal = globalThis.global;
        mockActor = makeEffectActor();

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

    afterEach(() => {
        if (hadGlobal)
            globalThis.global = originalGlobal;
        else
            delete globalThis.global;
    });

    /**
     * Wires the mask path up: a shaped-texture stand-in that records the mask, the window's
     * surface container and the stage's overview previews, and the mask builders. The stand-in
     * also carries the pre-fix `paint_to_bitmap()` member, so a spec can pin that the decoration
     * never reads the texture back now.
     *
     * @param {object} [options]
     * @param {number} [options.clientType=WindowClientType.WAYLAND]
     * @param {boolean} [options.drawClip=true]
     * @param {boolean} [options.drawShadow=false]
     * @param {boolean} [options.buildRoundedMaskReturnsNull=false]
     * @param {boolean} [options.forceOverviewCorners=false]
     * @param {object[]} [options.surfaceActors] - Boxes for the window's surface actors, the main
     *   surface first: the first is also the container's own box, as Mutter builds it. Omitted, the
     *   container fake carries no box and no children.
     * @param {boolean} [options.allWorkspaces=false] - Whether the window is shown on every workspace
     * @param {number} [options.workspaceCount=1] - Workspaces the preview set is sized against
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
        buildRoundedMaskReturnsNull = false,
        forceOverviewCorners = false,
        surfaceActors = null,
        allWorkspaces = false,
        workspaceCount = 1,
        warn = jasmine.createSpy('warn'),
    } = {}) {
        mockWin.get_client_type = () => clientType;
        mockWin.is_on_all_workspaces = () => allWorkspaces;

        const mask = {tag: 'rounded'};
        const opaque = {tag: 'opaque'};
        let opaqueCalls = 0;
        // Rounded installs only: the retirement writes the opaque mask, and a spec that counts
        // "how often was this buffer masked" must not count the retirement as one.
        let roundedCalls = 0;
        let bufferWidth = 800;
        let bufferHeight = 600;
        let buildReturnsNull = buildRoundedMaskReturnsNull;
        const OverviewMask = {
            buildRoundedMask: () => (buildReturnsNull ? null : mask),
            opaqueMask: () => {
                opaqueCalls++;
                return opaque;
            },
        };
        const surface = {
            mask: null,
            hasMask: false,
            // The pre-fix capability probe. It must never be called: its refusal was removed,
            // and the mask now applies to every Wayland window.
            paintCalls: 0,
            paint_to_bitmap() {
                this.paintCalls++;
                return {tag: 'bitmap'};
            },
            set_mask_texture(texture) {
                // GJS rejects a null mask ("Argument mask_texture may not be null"), so the only
                // way to retire our mask is the neutral opaque one. Model both facts so a spec
                // cannot pass by pretending the slot was detached.
                if (texture === null || texture === undefined)
                    throw new Error('Argument mask_texture may not be null');
                if (texture === mask)
                    roundedCalls++;
                this.mask = texture;
                this.hasMask = true;
            },
            get_texture: () => ({
                get_plane: () => ({get_context: () => ({})}),
                get_width: () => bufferWidth,
                get_height: () => bufferHeight,
            }),
        };
        mockActor.get_texture = () => surface;

        // The window's surface container: its children are the window's surface actors, and its own
        // box is the main surface's - the toplevel surface actor sits at the buffer origin at the
        // container's size (measured in a nested session). `surfaceActors` hands a spec the window's
        // surface tree, so it can say "another surface paints this box" without a real client.
        const makeContainer = (box = null, children = []) => ({
            opacity: 255,
            ...(box ?? {}),
            get_children: () => children,
            get_opacity() {
                return this.opacity;
            },
            set_opacity(value) {
                this.opacity = value;
            },
            connect: () => 1,
            disconnect: () => {},
        });
        const surfaceBoxes = [...(surfaceActors ?? [])];
        const container = makeContainer(surfaceBoxes[0] ?? null, surfaceBoxes);

        // The mask bypass hangs on the window's surface container - the window actor's child every
        // preview clone paints through - not on a preview card. The old `_delegate` wiring put it
        // on the last-built card, which left a window shown on all workspaces rounded on one
        // workspace and square on the others.
        mockActor.get_children = () => [container];

        // The overview's live previews are read by walking the stage: `metaWindow._delegate`
        // names only the last-built card, while the shadow needs one clone per preview.
        const makePreview = previewContainer => ({metaWindow: mockWin, window_container: previewContainer});
        const previews = [makePreview(container)];
        const addPreview = () => {
            const previewContainer = makeContainer();
            const preview = makePreview(previewContainer);
            previews.push(preview);
            return {preview, container: previewContainer};
        };
        globalThis.global = {
            ...globalThis.global,
            stage: {get_children: () => previews},
            // The preview set a window must have is sized from the workspace count, so the walk only
            // runs while the mounted set looks short.
            workspace_manager: {n_workspaces: workspaceCount},
        };

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
            journal: new Journal({warn}),
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
            mask, opaque, surface, container, makeContainer, makePreview, previews, addPreview,
            windowSignals, shadowClones, warn,
            opaqueCalls: () => opaqueCalls,
            roundedCalls: () => roundedCalls,
            setBuildReturnsNull: value => {
                buildReturnsNull = value;
            },
            setBuffer: (width, height) => {
                bufferWidth = width;
                bufferHeight = height;
            },
            // The window's surface tree is live: a client that destroys a surface changes what a
            // later reconcile reads, without any window signal naming the change.
            setSurfaceActors: boxes => {
                surfaceBoxes.length = 0;
                surfaceBoxes.push(...boxes);
                Object.assign(container, boxes[0] ?? {x: 0, y: 0, width: 0, height: 0});
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
            overview: {inOverview: false, hasMask: false, hasShadow: false, hasBypass: false},
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

    it('keeps the container the pass supplied, and forgets it when a pass supplies none', () => {
        // The tracker reads the surface-container rule once per pass; the decoration consumes that
        // read so the phase pair names the actor the clip was actually attached to. A pass that
        // supplies nothing must not leave the previous pass's container behind for the phase reader.
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
        const inputs = {insets: {left: 0, top: 0, right: 0, bottom: 0}, monitorScale: 1};
        const container = makeEffectActor({x: 0, y: 0, width: 800, height: 600});

        deco.apply({actions, inputs, actor: mockActor, target: {defer: true}, surfaceContainer: container});
        expect(deco.surfaceContainer).toBe(container);

        deco.apply({actions, inputs, actor: mockActor, target: {defer: true}, surfaceContainer: null});
        expect(deco.surfaceContainer).toBeNull();

        deco.apply({actions, inputs, actor: mockActor, target: {defer: true}});
        expect(deco.surfaceContainer).toBeUndefined();
    });

    it('hands the clip and the shadow the same St it resolved the target with', () => {
        // The phase readers identify the surface container by this St; the decoration constructs
        // both consumers, so it is the one place the clip's own value has to reach them.
        const St = {Widget: class {}};
        const deco = new WindowDecoration(mockWin, {
            container: mockContainer,
            display: mockDisplay,
            St,
            RoundedClipEffect: MockClipEffect,
            ShadowActor: MockShadowActor,
            ResizeBand: MockResizeBand,
        });

        deco._syncClip(true, mockActor, {left: 0, top: 0, right: 0, bottom: 0}, false);
        deco._syncShadow(true, mockActor);

        expect(deco.clip.St).toBe(St);
        expect(deco.shadow.St).toBe(St);
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

    it('does not persist a substituted 1.0: an unreadable first scale leaves _scale null', () => {
        // A first pass whose monitorScale read fails still lays out with the 1.0 substitute, but
        // only a readable reading is the last good one. Storing the substitute would make every
        // later failing pass read 1.0 as the last good scale, and `flatSafeInsets(1.0)` would
        // leave a client's 1px border unexcised on a fractional monitor.
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

        deco.apply({actions, inputs: {insets, monitorScale: null}, actor: mockActor});
        expect(deco._scale).toBeNull();
        expect(deco._resolveScale({monitorScale: null})).toBeNull();
        // The pass itself still laid out at 1.0: the shadow cut took the substitute, while the
        // clip records the unread null and falls back to 1.0 at paint.
        expect(deco.shadow.scale).toBe(1);
        expect(deco.clip.params.scale).toBeNull();

        // A later readable pass stores the reading, and a failing pass after that keeps it.
        deco.apply({actions, inputs: {insets, monitorScale: 1.25}, actor: mockActor});
        expect(deco._scale).toBe(1.25);
        deco.apply({actions, inputs: {insets, monitorScale: null}, actor: mockActor});
        expect(deco._resolveScale({monitorScale: null})).toBe(1.25);
        expect(deco.shadow.scale).toBe(1.25);
    });

    it('commits the episode only after the pass has drawn, so a throw cannot advance it', () => {
        // A GObject call on an actor Mutter is tearing down throws, and the manager swallows it. If the
        // settle's reference points and the ring hold's witness have already moved by then, the next pass
        // settles against a pass that drew nothing - the BodyPlan bug one level down.
        class ThrowingClipEffect {
            constructor() {
                throw new Error('Mutter is tearing down');
            }
        }
        const deco = new WindowDecoration(mockWin, {
            container: mockContainer,
            display: mockDisplay,
            RoundedClipEffect: ThrowingClipEffect,
            ShadowActor: MockShadowActor,
            ResizeBand: MockResizeBand,
            journal: new Journal({warn: () => {}}),
        });
        const before = deco.bodyPlan.settle;

        const pass = () => deco.apply({
            actions: {
                drawClip: true, drawRing: false, drawShadow: false, drawResize: false,
                ring: {clear: false, safeInset: false},
                style: {radius: 12, outline: null, shadows: []},
            },
            inputs: {
                insets: {left: 0, top: 0, right: 0, bottom: 0}, monitorScale: 1,
                frameRect: {x: 0, y: 0, width: 800, height: 600},
                bufferRect: {x: 0, y: 0, width: 800, height: 600},
                bufferWidth: 800, bufferHeight: 600, frameWidth: 800, frameHeight: 600,
            },
            actor: mockActor,
            target: mockActor,
        });

        expect(pass).toThrow();

        expect(deco.bodyPlan.settle).toEqual(before);
        expect(deco._witness).toBeNull();
    });

    it('keeps the history still when a later stage throws, and rebuilds on the next pass', () => {
        // The clip constructor throwing is the easy case: nothing has been built yet. This one throws
        // from the shadow, after the clip exists, so it also pins what the commit does NOT promise -
        // the actor the pass already attached stays attached, because unwinding a half-attached effect
        // during a teardown would be worse than finishing the next pass from there.
        let throwsOnce = true;
        class FlakyShadowActor extends MockShadowActor {
            constructor(...args) {
                if (throwsOnce) {
                    throwsOnce = false;
                    throw new Error('Mutter is tearing down');
                }
                super(...args);
            }
        }
        const deco = new WindowDecoration(mockWin, {
            container: mockContainer,
            display: mockDisplay,
            RoundedClipEffect: MockClipEffect,
            ShadowActor: FlakyShadowActor,
            ResizeBand: MockResizeBand,
            journal: new Journal({warn: () => {}}),
        });
        const before = deco.bodyPlan.settle;
        const pass = () => deco.apply({
            actions: {
                drawClip: true, drawRing: false, drawShadow: true, drawResize: false,
                ring: {clear: false, safeInset: false},
                style: {radius: 12, outline: null, shadows: []},
            },
            inputs: {
                insets: {left: 0, top: 0, right: 0, bottom: 0}, monitorScale: 1,
                frameRect: {x: 0, y: 0, width: 800, height: 600},
                bufferRect: {x: 0, y: 0, width: 800, height: 600},
                bufferWidth: 800, bufferHeight: 600, frameWidth: 800, frameHeight: 600,
            },
            actor: mockActor,
            target: mockActor,
        });

        expect(pass).toThrow();
        expect(deco.bodyPlan.settle).toEqual(before);
        expect(deco._witness).toBeNull();
        // Not a rollback: the clip the pass attached before the shadow threw is still here.
        expect(deco.clip).not.toBeNull();

        // The recovery the guarantee is really about: the next pass settles from the history it had,
        // not from one that never finished, and the actor it could not build arrives.
        pass();
        expect(deco.bodyPlan.settle.previousBody).not.toBeNull();
        expect(deco._witness).not.toBeNull();
        expect(deco.shadow).not.toBeNull();
    });

    it('keeps the history still when the overview sync throws, which is the last thing it does', () => {
        // `setOverviewMode` is not a harmless epilogue: it reaches the clip's resume, its enabled flag
        // and a pass push. If it threw after the history had been written, the guarantee would hold
        // for every stage but the last one.
        class ThrowingResumeClip extends MockClipEffect {
            constructor(...args) {
                super(...args);
                this.failResume = false;
            }

            resume() {
                if (this.failResume)
                    throw new Error('Mutter is tearing down');
            }
        }
        const deco = new WindowDecoration(mockWin, {
            container: mockContainer,
            display: mockDisplay,
            RoundedClipEffect: ThrowingResumeClip,
            ShadowActor: MockShadowActor,
            ResizeBand: MockResizeBand,
            journal: new Journal({warn: () => {}}),
        });
        const pass = bufferRect => deco.apply({
            actions: {
                drawClip: true, drawRing: false, drawShadow: false, drawResize: false,
                ring: {clear: false, safeInset: false},
                style: {radius: 12, outline: null, shadows: []},
            },
            inputs: {
                insets: {left: 0, top: 0, right: 0, bottom: 0}, monitorScale: 1,
                frameRect: {x: 0, y: 0, width: 800, height: 600},
                bufferRect,
                bufferWidth: bufferRect.width, bufferHeight: bufferRect.height,
                frameWidth: 800, frameHeight: 600,
            },
            actor: mockActor,
            target: mockActor,
        });

        const firstBuffer = {x: 0, y: 0, width: 800, height: 600};
        pass(firstBuffer);
        const afterFirst = deco.bodyPlan.settle;
        deco.clip.failResume = true;

        // A buffer that moved, so the witness advancing would be visible: comparing two equal passes
        // would prove nothing, which is how the first cut of this spec passed on a broken order.
        expect(() => pass({x: 0, y: 0, width: 802, height: 600})).toThrow();

        expect(deco._witness.buffer).toBe(firstBuffer);
        expect(deco.bodyPlan.settle).toEqual(afterFirst);
    });

    it('warns once when the buffer and the window actor allocation disagree for two passes', () => {
        // The transient the journal could not attribute: the buffer reads 798 while the window
        // actor is 800 wide, so one of the two reads lagged the other in this pass. A single pass
        // is the skew a resize in flight shows and must stay silent; the second consecutive pass
        // is the sustained divergence and speaks exactly once.
        const warn = jasmine.createSpy('warn');
        const deco = new WindowDecoration(mockWin, {
            container: mockContainer,
            display: mockDisplay,
            RoundedClipEffect: MockClipEffect,
            ShadowActor: MockShadowActor,
            ResizeBand: MockResizeBand,
            journal: new Journal({warn}),
        });
        const actions = {
            drawClip: true,
            drawRing: false,
            drawShadow: true,
            drawResize: false,
            ring: {clear: false, safeInset: false},
            style: {radius: 12, outline: null, shadows: []},
        };
        const insets = {left: 8, top: 8, right: 8, bottom: 8};
        const drifting = {
            insets,
            monitorScale: 1,
            wmClass: 'firefox',
            bufferRect: {x: 0, y: 0, width: 798, height: 600},
        };

        deco.apply({actions, inputs: drifting, actor: mockActor});
        expect(warn).not.toHaveBeenCalled();

        deco.apply({actions, inputs: drifting, actor: mockActor});
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.calls.mostRecent().args[0]).toContain('798x600');
        expect(warn.calls.mostRecent().args[0]).toContain('"firefox"');

        // The same episode stays one line, and agreement re-arms for the next one.
        deco.apply({actions, inputs: drifting, actor: mockActor});
        expect(warn).toHaveBeenCalledTimes(1);
        deco.apply({actions,
            inputs: {...drifting, bufferRect: {x: 0, y: 0, width: 800, height: 600}},
            actor: mockActor});
        deco.apply({actions, inputs: drifting, actor: mockActor});
        deco.apply({actions, inputs: drifting, actor: mockActor});
        expect(warn).toHaveBeenCalledTimes(2);
    });

    it('warns once when the fallback phase does not match the phase Mutter applied', () => {
        // On the fallback path the clip folds the mirror into its geometry; the applied read is
        // what Mutter actually put on the container. A disagreement is the fractional-scale
        // hairline. The latch is the same two-pass rule, and the container path never reads the
        // pair because it uses the applied phase directly.
        const warn = jasmine.createSpy('warn');
        const deco = new WindowDecoration(mockWin, {
            container: mockContainer,
            display: mockDisplay,
            RoundedClipEffect: MockClipEffect,
            ShadowActor: MockShadowActor,
            ResizeBand: MockResizeBand,
            journal: new Journal({warn}),
        });
        const actions = {
            drawClip: true,
            drawRing: false,
            drawShadow: true,
            drawResize: false,
            ring: {clear: false, safeInset: false},
            style: {radius: 12, outline: null, shadows: []},
        };
        const inputs = {insets: {left: 8, top: 8, right: 8, bottom: 8}, monitorScale: 1, wmClass: 'firefox'};
        const reads = spyOn(deco, '_readPhases').and.returnValue({
            mirror: {x: 0, y: 0},
            applied: {x: 1.2, y: 0},
        });
        const fallback = {actor: mockActor, phaseInTransform: false};

        deco.apply({actions, inputs, actor: mockActor, target: fallback});
        expect(warn).not.toHaveBeenCalled();
        deco.apply({actions, inputs, actor: mockActor, target: fallback});
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.calls.mostRecent().args[0]).toContain('"firefox"');

        // The container path reads the applied phase from the transform, so it must not spend the
        // mirror read, and a matching pair stays silent on the fallback path.
        reads.calls.reset();
        deco.apply({actions, inputs, actor: mockActor, target: {actor: mockActor, phaseInTransform: true}});
        expect(reads).not.toHaveBeenCalled();
        reads.and.returnValue({mirror: {x: 0.5, y: 0}, applied: {x: 0.5, y: 0}});
        deco.apply({actions, inputs, actor: mockActor, target: fallback});
        deco.apply({actions, inputs, actor: mockActor, target: fallback});
        expect(warn).toHaveBeenCalledTimes(1);
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
        const container = makeEffectActor({x: 0, y: 0, width: 0, height: 0});
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
        expect(deco.clip.get_actor()).toBe(mockActor);
        expect(deco.clipPhaseInTransform).toBeFalse();

        // The container allocates; the next apply (the manager's notify::allocation re-run)
        // re-verifies and targets the container, and the effect really moves there.
        container.width = 800;
        container.height = 600;
        deco.apply({actions, inputs, actor: mockActor});
        expect(deco.clipTarget).toBe(container);
        expect(deco.clip.get_actor()).toBe(container);
        expect(deco.clipPhaseInTransform).toBeTrue();

        // It loses its allocation again: the clip keeps its last good target (the container)
        // rather than re-pinning to the window actor for the pass, so the effect does not move.
        container.width = 0;
        container.height = 0;
        deco.apply({actions, inputs, actor: mockActor});
        expect(deco.clipTarget).toBe(container);
        expect(deco.clip.get_actor()).toBe(container);
        expect(deco.clipPhaseInTransform).toBeTrue();
    });

    it('moves the clip effect when the resolved target changes', () => {
        // A verified surface container is the target. Its box then becomes incompatible (still
        // allocated, but no longer matching the buffer), so the resolver answers the window actor.
        // The pre-fix code recorded the wanted target in `this.clipTarget` before `_syncClip` and
        // compared the wanted target with that field, so the comparison was always false and the
        // effect stayed on the container while the field named the window actor.
        const container = makeEffectActor({x: 0, y: 0, width: 800, height: 600});
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

        // The container verifies, so the clip attaches to it.
        deco.apply({actions, inputs, actor: mockActor});
        expect(deco.clipTarget).toBe(container);
        expect(deco.clip.get_actor()).toBe(container);
        expect(container.effects).toContain(deco.clip);

        // Still allocated, but its box no longer matches the buffer: the resolver falls back to
        // the window actor, and the effect must actually follow it.
        container.width = 700;
        deco.apply({actions, inputs, actor: mockActor});
        expect(deco.clipTarget).toBe(mockActor);
        expect(deco.clip.get_actor()).toBe(mockActor);
        expect(mockActor.effects).toContain(deco.clip);
        expect(container.effects).not.toContain(deco.clip);
        expect(deco.clipPhaseInTransform).toBeFalse();
    });

    it('cancels a queued disable before detaching the clip', () => {
        // The effect disables itself on an idle when its body goes degenerate. Detaching it - on a
        // re-pin or on teardown - must drop that idle, or it fires on a disposed effect.
        const container = makeEffectActor({x: 0, y: 0, width: 800, height: 600});
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

        deco.apply({actions, inputs, actor: mockActor});
        const clip = deco.clip;
        expect(clip.get_actor()).toBe(container);
        expect(clip.cancelled ?? 0).toBe(0);

        // A re-pin moves the effect to another actor, so the queued disable has to go with it.
        container.width = 700;
        deco.apply({actions, inputs, actor: mockActor});
        expect(clip.cancelled).toBe(1);

        // Teardown detaches it once more.
        deco.destroy();
        expect(clip.cancelled).toBe(2);
    });

    it('follows a replaced surface container', () => {
        // XWayland can swap the surface child. The clip must detach from the old container and
        // attach to the new one, not stay on the actor that is going away.
        const first = makeEffectActor({x: 0, y: 0, width: 800, height: 600});
        const second = makeEffectActor({x: 0, y: 0, width: 800, height: 600});
        mockWin.get_buffer_rect = () => ({x: 0, y: 0, width: 800, height: 600});
        mockActor.get_children = () => [first];

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

        deco.apply({actions, inputs, actor: mockActor});
        expect(deco.clip.get_actor()).toBe(first);
        expect(first.effects).toContain(deco.clip);

        // The surface child is replaced by a new, equally verifiable container.
        mockActor.get_children = () => [second];
        deco.apply({actions, inputs, actor: mockActor});
        expect(deco.clipTarget).toBe(second);
        expect(deco.clip.get_actor()).toBe(second);
        expect(second.effects).toContain(deco.clip);
        expect(first.effects).not.toContain(deco.clip);
        expect(deco.clipPhaseInTransform).toBeTrue();
    });

    it('re-resolves when the container ambiguity appears and then disappears', () => {
        // Two non-foreign children of the same buffer-sized box are the tie `getSurfaceContainer`
        // refuses to guess between (Mutter's fullscreen backing beside the real container), so the
        // clip falls back to the window actor. When the backing goes away the tree is unambiguous
        // again, and the same reconcile path must move the clip to the container with nothing left
        // pointing at the fallback.
        const container = makeEffectActor({x: 0, y: 0, width: 800, height: 600});
        const backing = makeEffectActor({x: 0, y: 0, width: 800, height: 600});
        mockWin.get_buffer_rect = () => ({x: 0, y: 0, width: 800, height: 600});
        let children = [container, backing];
        mockActor.get_children = () => children;

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
            drawResize: false,
            ring: {clear: false, safeInset: false},
            style: {radius: 12, outline: null, shadows: []},
        };
        const inputs = {insets: {left: 8, top: 8, right: 8, bottom: 8}, monitorScale: 1};

        // The ambiguity is present: the fallback is the window actor, and the shadow is told so.
        deco.apply({actions, inputs, actor: mockActor});
        expect(deco.clipTarget).toBe(mockActor);
        expect(deco.clip.get_actor()).toBe(mockActor);
        expect(deco.clipPhaseInTransform).toBeFalse();
        expect(deco.shadow.clipTarget).toBe(mockActor);
        expect(container.effects).not.toContain(deco.clip);

        // The backing goes away: the container is the unique non-foreign child, so the later
        // reconcile re-resolves to it and the shadow's body authority follows the same move.
        children = [container];
        deco.apply({actions, inputs, actor: mockActor});
        expect(deco.clipTarget).toBe(container);
        expect(deco.clip.get_actor()).toBe(container);
        expect(deco.clipPhaseInTransform).toBeTrue();
        expect(deco.shadow.clipTarget).toBe(container);
        expect(mockActor.effects).not.toContain(deco.clip);
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

    it('points the shadow at the clip target and reports the live body for diagnostics', () => {
        const container = makeEffectActor({x: 0, y: 0, width: 800, height: 600});
        mockWin.get_buffer_rect = () => ({x: 0, y: 0, width: 800, height: 600});
        mockActor.get_children = () => [container];

        const deco = new WindowDecoration(mockWin, {
            container: mockContainer,
            display: mockDisplay,
            RoundedClipEffect: MockClipEffect,
            ShadowActor: MockShadowActor,
            ResizeBand: MockResizeBand,
        });
        deco.apply({
            actions: {
                drawClip: true,
                drawRing: false,
                drawShadow: true,
                drawResize: false,
                ring: {clear: false, safeInset: false},
                style: {radius: 12, outline: null, shadows: []},
            },
            inputs: {insets: {left: 0, top: 0, right: 0, bottom: 0}, monitorScale: 1},
            actor: mockActor,
        });

        // The shadow's body authority is the same target the clip attached to...
        expect(deco.shadow.clipTarget).toBe(container);
        // ...and the read-only view exposes the clip's container box plus the shadow's live box,
        // cast and snapped right band for one debug pick during the glitch.
        expect(deco.diagnosticsView.containerBox).toEqual({x: 0, y: 0, width: 800, height: 600});
        expect(deco.diagnosticsView.shadowWidth).toBe(824);
        expect(deco.diagnosticsView.shadowHeight).toBe(624);
        expect(deco.diagnosticsView.shadowCast).toEqual({x: 0, y: 0, width: 824, height: 624});
        expect(deco.diagnosticsView.shadowRightBand).toEqual({x1: 812, y1: 0, x2: 824, y2: 624});
    });

    it('holds the one settled body across a target/actor disagreement so both cuts stay put', () => {
        const container = makeEffectActor({x: 0, y: 0, width: 800, height: 600});
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
            drawShadow: true,
            drawResize: false,
            ring: {clear: false, safeInset: false},
            style: {radius: 12, outline: null, shadows: []},
        };
        const inputs = {insets: {left: 0, top: 0, right: 0, bottom: 0}, monitorScale: 1};
        const target = {actor: container, phaseInTransform: true};

        // The body at paint is the settle of the live reads and the plan the pass handed; the
        // shadow gets the same plan object, so one body serves both cuts. These inputs carry no
        // frame rect, so the live window size is unknown, as on an early pass.
        const bodyNow = () => resolvePaintBody(container, mockActor, null, deco.clip.bodyPlan).body;

        // A healthy pass: the resolved target and the window actor agree.
        deco.apply({actions, inputs, actor: mockActor, target});
        expect(deco.shadow.bodyPlan).toBe(deco.clip.bodyPlan);
        expect(bodyNow()).toEqual({width: 800, height: 600});

        // The container read lags the window actor by 2px: both cuts keep the previous body.
        container.width = 798;
        deco.apply({actions, inputs, actor: mockActor, target});
        expect(bodyNow()).toEqual({width: 800, height: 600});

        // The two agree again: the fresh body is acted on at once, so the deferral cannot latch.
        container.width = 804;
        mockActor.width = 804;
        deco.apply({actions, inputs, actor: mockActor, target});
        expect(bodyNow()).toEqual({width: 804, height: 600});
    });

    it('follows the window actor while a resize is in flight so both cuts track the dragged frame', () => {
        const container = makeEffectActor({x: 0, y: 0, width: 800, height: 600});
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
            drawShadow: true,
            drawResize: false,
            ring: {clear: false, safeInset: false},
            style: {radius: 12, outline: null, shadows: []},
        };
        const target = {actor: container, phaseInTransform: true};
        const withFrame = rect => ({
            insets: {left: 0, top: 0, right: 0, bottom: 0}, monitorScale: 1,
            frameRect: rect, bufferRect: rect,
        });

        // The frame rect is the window's own live size in this fixture, so the body at paint is the
        // settle of the two live actor reads and the plan the pass handed.
        const bodyNow = () => resolvePaintBody(container, mockActor,
            {width: mockActor.width, height: 600}, deco.clip.bodyPlan).body;

        // A healthy pass establishes the settled body and the window's own size.
        deco.apply({actions, inputs: withFrame({x: 0, y: 0, width: 800, height: 600}),
            actor: mockActor, target});
        expect(bodyNow()).toEqual({width: 800, height: 600});

        // The drag grows the window to 802: the window actor is already there and the surface
        // container still reads the older 800. Both cuts must follow the actor, not hold the
        // lagging container box. The plan's window size pair is what marks the resize in flight.
        mockActor.width = 802;
        deco.apply({actions, inputs: withFrame({x: 0, y: 0, width: 802, height: 600}),
            actor: mockActor, target});
        expect(deco.shadow.bodyPlan).toBe(deco.clip.bodyPlan);
        expect(bodyNow()).toEqual({width: 802, height: 600});
    });

    it('holds the body when it moves between passes while the window size stands still', () => {
        // The focus hand-off: the container and the window actor can trail together by a whole
        // pixel, so the within-pass pair agrees while the window's own frame has not moved. The
        // body's movement between passes is the tell the pair comparison misses.
        const container = makeEffectActor({x: 0, y: 0, width: 800, height: 600});
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
            drawShadow: true,
            drawResize: false,
            ring: {clear: false, safeInset: false},
            style: {radius: 12, outline: null, shadows: []},
        };
        const rect = {x: 0, y: 0, width: 800, height: 600};
        const inputs = {
            insets: {left: 0, top: 0, right: 0, bottom: 0}, monitorScale: 1,
            frameRect: rect, bufferRect: rect,
        };
        const target = {actor: container, phaseInTransform: true};

        // The window's own live size stands at 800 while the actor trails to 798, then moves to
        // 700 with the actor; the body at paint is the settle of that live size, the two actor
        // reads and the plan the pass handed.
        let liveWindow = {width: 800, height: 600};
        const bodyNow = () => resolvePaintBody(container, mockActor, liveWindow, deco.clip.bodyPlan).body;

        // A healthy pass establishes the settled body and the window's own size.
        deco.apply({actions, inputs, actor: mockActor, target});
        expect(bodyNow()).toEqual({width: 800, height: 600});

        // The container and the window actor trail together to 798; the frame stays 800. Both cuts
        // keep the previous body instead of following the stale pair.
        container.width = 798;
        mockActor.width = 798;
        deco.apply({actions, inputs, actor: mockActor, target});
        expect(deco.shadow.bodyPlan).toBe(deco.clip.bodyPlan);
        expect(bodyNow()).toEqual({width: 800, height: 600});

        // A genuine resize moves the body and the window's own frame together: the fresh body is
        // acted on, and the hold does not latch onto the next pass.
        container.width = 700;
        mockActor.width = 700;
        liveWindow = {width: 700, height: 600};
        const smaller = {x: 0, y: 0, width: 700, height: 600};
        deco.apply({actions,
            inputs: {...inputs, frameRect: smaller, bufferRect: smaller},
            actor: mockActor, target});
        expect(bodyNow()).toEqual({width: 700, height: 600});
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

    // The ring hold: a ring that moves while nothing else does is held, and a ring that moves
    // with the buffer is not. The second case is what the hold used to get wrong - it asked the
    // window's own size, which is the frame rect and can stand still through a whole rebuild, so
    // the predicate was constant false and one wrong ring latched in and never came back.
    describe('the ring hold witness', () => {
        // The Firefox case, measured: a window first seen maximized has ring 0, and unmaximizing
        // brings the real 24px CSD ring back over nine steps. The frame never moves.
        const MAXIMIZED_FRAME = {x: 0, y: 0, width: 1920, height: 1050};
        const MAXIMIZED_BUFFER = {x: 0, y: 0, width: 1920, height: 1050};
        const RESTORED_FRAME = {x: 243, y: 219, width: 1291, height: 816};
        const RESTORED_BUFFER = {x: 219, y: 198, width: 1339, height: 864};

        /** Drives apply() through a list of passes and returns the ring each one produced. */
        function ringThrough(deco, passes) {
            return passes.map(({frameRect, bufferRect, insets}) => {
                deco.apply({
                    actions: {
                        drawClip: true, drawRing: false, drawShadow: true, drawResize: false,
                        ring: {clear: true, safeInset: false},
                        style: {radius: 15, outline: null, shadows: []},
                    },
                    inputs: {
                        insets, monitorScale: 1, frameRect, bufferRect,
                        bufferWidth: bufferRect.width, bufferHeight: bufferRect.height,
                        frameWidth: frameRect.width, frameHeight: frameRect.height,
                    },
                    actor: mockActor,
                });
                return {...deco.stateView.ring.insets};
            });
        }

        function buildDeco() {
            return new WindowDecoration(mockWin, {
                container: mockContainer,
                display: mockDisplay,
                RoundedClipEffect: MockClipEffect,
                ShadowActor: MockShadowActor,
                ResizeBand: MockResizeBand,
            });
        }

        it('follows the ring back after an unmaximize, even though the frame never moves', () => {
            const deco = buildDeco();
            const noRing = {left: 0, top: 0, right: 0, bottom: 0};
            const realRing = {left: 24, top: 21, right: 24, bottom: 27};
            const rings = ringThrough(deco, [
                // Seen maximized first: the client's ring is genuinely 0.
                {frameRect: MAXIMIZED_FRAME, bufferRect: MAXIMIZED_BUFFER, insets: noRing},
                // Unmaximized. The buffer grows, the frame does not, and the ring is real.
                {frameRect: RESTORED_FRAME, bufferRect: RESTORED_BUFFER, insets: realRing},
                // And it stays. The latched bug answered 0 here for the rest of the window's life.
                {frameRect: RESTORED_FRAME, bufferRect: RESTORED_BUFFER, insets: realRing},
                {frameRect: RESTORED_FRAME, bufferRect: RESTORED_BUFFER, insets: realRing},
            ]);

            expect(rings[0]).toEqual(noRing);
            expect(rings[1]).toEqual(realRing);
            expect(rings[2]).toEqual(realRing);
            expect(rings[3]).toEqual(realRing);
        });

        it('takes every step of a rebuild, because the buffer moves on each one', () => {
            // The measured unmaximize: the buffer grows a cell at a time and the ring follows it
            // down and back up. Holding any step would freeze the cut mid-rebuild.
            const deco = buildDeco();
            const steps = [
                {buffer: {x: 0, y: 0, width: 440, height: 340}, ring: 20},
                {buffer: {x: 0, y: 0, width: 442, height: 342}, ring: 21},
                {buffer: {x: 0, y: 0, width: 446, height: 346}, ring: 23},
                {buffer: {x: 0, y: 0, width: 448, height: 348}, ring: 24},
                {buffer: {x: 0, y: 0, width: 450, height: 350}, ring: 25},
            ];
            const frame = {x: 0, y: 0, width: 400, height: 300};
            const rings = ringThrough(deco, steps.map(({buffer, ring}) => ({
                frameRect: frame, bufferRect: buffer,
                insets: {left: ring, top: ring, right: ring, bottom: ring},
            })));

            expect(rings.map(r => r.left)).toEqual([20, 21, 23, 24, 25]);
        });

        it('holds a ring that moved while the buffer stood still', () => {
            // The case the hold is for: the two rects are read in one pass and updated a step apart,
            // so the ring is briefly a mixture of both. Nothing else moved, so it is held.
            const deco = buildDeco();
            const rect = {x: 0, y: 0, width: 450, height: 350};
            const frame = {x: 0, y: 0, width: 400, height: 300};
            const settled = {left: 25, top: 25, right: 25, bottom: 25};
            const midUpdate = {left: 4, top: 4, right: 4, bottom: 4};
            const rings = ringThrough(deco, [
                {frameRect: frame, bufferRect: rect, insets: settled},
                {frameRect: frame, bufferRect: rect, insets: midUpdate},
                {frameRect: frame, bufferRect: rect, insets: settled},
            ]);

            expect(rings[0]).toEqual(settled);
            expect(rings[1]).toEqual(settled);
            expect(rings[2]).toEqual(settled);
        });

        it('takes the ring again once the buffer moves, so the hold cannot latch', () => {
            // The latch is the failure that shipped: the hold compared its own output, so every
            // later pass looked like another drift. Moving the buffer has to end it.
            const deco = buildDeco();
            const noRing = {left: 0, top: 0, right: 0, bottom: 0};
            const realRing = {left: 24, top: 21, right: 24, bottom: 27};
            const rings = ringThrough(deco, [
                {frameRect: MAXIMIZED_FRAME, bufferRect: MAXIMIZED_BUFFER, insets: noRing},
                // Two passes where nothing moves and the correct ring is refused.
                {frameRect: MAXIMIZED_FRAME, bufferRect: MAXIMIZED_BUFFER, insets: realRing},
                {frameRect: MAXIMIZED_FRAME, bufferRect: MAXIMIZED_BUFFER, insets: realRing},
                // Now the buffer moves, and the ring must be taken on the very next pass.
                {frameRect: RESTORED_FRAME, bufferRect: RESTORED_BUFFER, insets: realRing},
            ]);

            expect(rings[3]).toEqual(realRing);
        });

        it('drops the witness when the decoration is torn down for an unreadable geometry', () => {
            // undecorate() runs when a reading could not be taken. A decoration rebuilt after that
            // must not resume holding a ring from before the gap - the buffer it was compared
            // against went with it.
            const deco = buildDeco();
            ringThrough(deco, [
                {frameRect: RESTORED_FRAME, bufferRect: RESTORED_BUFFER,
                    insets: {left: 24, top: 21, right: 24, bottom: 27}},
            ]);
            expect(deco._witness).not.toBeNull();
            // The settle's reference points are the same kind of witness: a hold that outlived the gap
            // would draw the clip and the cast at the body they had before it.
            expect(deco.bodyPlan.settle.previousBody).not.toBeNull();
            // The actors this pass built go too. `_syncShadow` needs the window actor to answer, so this
            // one is only reachable with one behind the decoration, which the harness provides.
            expect(deco.shadow).not.toBeNull();

            deco.undecorate();
            expect(deco._witness).toBeNull();
            expect(deco.bodyPlan.settle).toEqual(jasmine.objectContaining({
                previousBody: null, previousAuthority: null, previousWindowSize: null,
            }));
            expect(deco._passPlan).toBeNull();
            expect(deco.shadow).toBeNull();
        });

        it('skips the hold and drops the witness when this pass cannot read a ring', () => {
            // `inputs.insets` is null whenever insetsFromRects refuses (the frame does not fit
            // inside the buffer), a supported state that routes to the flat path. The hold's drift
            // comparison dereferenced it, so apply() threw; the manager's catch discarded the whole
            // pass, so the witness never advanced and the same throw repeated every frame
            // with no journal line. A ring that cannot be read cannot be compared: the hold is
            // skipped and the previous ring is not resurrected from an unreadable pass.
            const deco = buildDeco();
            const frame = {x: 0, y: 0, width: 400, height: 300};
            const buffer = {x: 0, y: 0, width: 450, height: 350};
            const settled = {left: 25, top: 25, right: 25, bottom: 25};

            const rings = ringThrough(deco, [
                {frameRect: frame, bufferRect: buffer, insets: settled},
            ]);
            expect(rings[0]).toEqual(settled);
            expect(deco._witness.ring).toEqual(settled);

            // Same buffer, so the hold is armed; the ring cannot be read this pass.
            expect(() => ringThrough(deco, [
                {frameRect: frame, bufferRect: buffer, insets: null},
            ])).not.toThrow();

            expect(deco.stateView.ring.insets).toBeNull();
            expect(deco._witness.ring).toBeNull();
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

    it('derives the flat cover from the device pixel count at fractional scales (issue #129)', () => {
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
            monitorScale: 1.25,
        };

        deco.apply({actions, inputs, actor: mockActor});
        // 3 device px at 1.25x (2 for the border, 1 paint slack): the fixed 1px cover would
        // leave most of the client's own border behind, so the plan carries the device-derived
        // cover instead.
        const cover = {left: 2.4, top: 2.4, right: 2.4, bottom: 2.4};
        expect(deco.ring.insets).toEqual(cover);
        expect(deco.clipInsets).toEqual(cover);
        expect(deco.clip.params.insets).toEqual(cover);
        expect(deco.shadow.insets).toEqual(cover);
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
            overview: {inOverview: false, hasMask: false, hasShadow: false, hasBypass: false},
        });
    });

    it('reports the live clip internals through diagnosticsView without touching the overview', () => {
        const {deco} = setupMaskHarness({drawClip: true, drawShadow: false});

        const view = deco.diagnosticsView;
        // The desktop clip is on outside the overview and carries its live state.
        expect(view.clipEnabled).toBeTrue();
        expect(view.clipSuspended).toBeFalse();
        expect(view.clipInsets).toEqual(FLAT_SAFE_INSET);
        expect(typeof view.phaseInTransform).toBe('boolean');
        expect(typeof view.clipTargetName).toBe('string');
        // These read fields the mock clip does not model; the reply renders them `unavailable`
        // rather than silently omitting them.
        expect(view.clipFrame).toBeNull();
        expect(view.clipScale).toBeNull();
        // No overview field survives in the view.
        expect(view.inOverview).toBeUndefined();
        expect(view.hasMask).toBeUndefined();
        expect(view.overviewMode).toBeUndefined();
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

    it('re-applies the mask when a workspace move or a resize rebuilds the card', () => {
        const harness = setupMaskHarness();
        harness.deco.setOverviewMode(true);

        // Both rebuild the card; the mask is retired and re-installed against it, with no
        // readback of the shaped texture.
        for (const signal of ['workspace-changed', 'size-changed']) {
            const handler = harness.windowSignals.find(s => s.signal === signal);
            expect(handler).toBeDefined();
            handler.cb();
            expect(harness.surface.mask).toBe(harness.mask);

            harness.deco.setOverviewMode(true);
            expect(harness.surface.mask).toBe(harness.mask);
        }
        expect(harness.surface.paintCalls).toBe(0);
    });

    it('defers a bufferless texture, then masks once a buffer arrives', () => {
        // The first Overview entry can race the client's first buffer. A texture with no buffer
        // has no shape to mask, so the window stays square this pass and nothing is cached; the
        // buffer's arrival earns a fresh reconcile that installs the mask.
        const harness = setupMaskHarness();
        harness.setBuffer(0, 0);
        harness.deco.setOverviewMode(true);

        expect(harness.surface.hasMask).toBeFalse();

        harness.setBuffer(800, 600);
        harness.deco.setOverviewMode(true);

        expect(harness.surface.mask).toBe(harness.mask);
    });

    it('defers a texture whose draw target is not paintably allocated, then masks once it recovers', () => {
        // "Has a backing buffer" is not "the current draw target is valid": a valid buffer with a
        // momentarily zero-sized draw target must not be masked into. The window actor's
        // allocation is the authority the clip uses, so a zero allocation defers, caches nothing,
        // and the recovery installs the mask.
        const harness = setupMaskHarness();
        mockActor.width = 0;
        mockActor.height = 0;
        harness.deco.setOverviewMode(true);

        expect(harness.surface.hasMask).toBeFalse();

        mockActor.width = 800;
        mockActor.height = 600;
        harness.deco.setOverviewMode(true);

        expect(harness.surface.mask).toBe(harness.mask);
    });

    it('keeps the mask through a different-sized buffer commit', () => {
        const harness = setupMaskHarness();
        harness.deco.setOverviewMode(true);
        expect(harness.surface.mask).toBe(harness.mask);

        // The client commits a different-sized buffer; the card rebuild retires the mask and
        // re-installs it against the new buffer. Nothing reads the texture back.
        harness.setBuffer(1600, 1200);
        harness.windowSignals.find(s => s.signal === 'size-changed').cb();

        expect(harness.surface.mask).toBe(harness.mask);
        expect(harness.surface.paintCalls).toBe(0);
    });

    it('re-installs the mask when the readings it was built from move', () => {
        // Mutter clears a shaped texture's mask whenever its destination size changes, and a
        // display-scale move or a fractional-scale renegotiation moves that size with no window
        // signal at all. The install is keyed on the buffer, the scale and the decoration, so a
        // reconcile whose key moved installs again instead of trusting its own bookkeeping.
        const {mask, surface, roundedCalls, setBuffer, deco} = setupMaskHarness();
        deco.setOverviewMode(true);
        expect(surface.mask).toBe(mask);
        expect(roundedCalls()).toBe(1);

        setBuffer(1600, 1200);
        deco.setOverviewMode(true);

        expect(surface.mask).toBe(mask);
        expect(roundedCalls()).toBe(2);
    });

    it('does not spend a second install when the mask readings are unchanged', () => {
        // The cheap reconcile: a re-settle with the same buffer, scale and decoration leaves the
        // shaped texture's mask slot alone.
        const {mask, surface, roundedCalls, deco} = setupMaskHarness();
        deco.setOverviewMode(true);
        deco.setOverviewMode(true);

        expect(surface.mask).toBe(mask);
        expect(roundedCalls()).toBe(1);
    });

    it('installs the mask again when the shaped texture is replaced under an unchanged key', () => {
        // The key describes the mask's content, not where it went: "installed" has to mean *this*
        // texture wears it. Mutter destroys and rebuilds surface actors
        // (`meta_wayland_actor_surface_reset_actor()`), and a swap that leaves every reading equal
        // is invisible to the key, so the texture's identity is part of the condition.
        const {mask, surface, roundedCalls, deco} = setupMaskHarness();
        deco.setOverviewMode(true);
        expect(surface.mask).toBe(mask);
        expect(roundedCalls()).toBe(1);

        const replacement = {...surface, mask: null};
        mockActor.get_texture = () => replacement;
        deco.setOverviewMode(true);

        expect(replacement.mask).toBe(mask);
        expect(roundedCalls()).toBe(2);
    });

    it('retries the opacity bypass on a pass whose mask key has not moved', () => {
        // A mask that is installed while the surface container cannot be read is a mask Mutter
        // never consults: its opaque fast path is decided by that container's paint opacity. The
        // next pass with the same key never reaches the install, so the bypass has to be
        // re-asserted on the cheap path too.
        const {mask, surface, container, deco} = setupMaskHarness();
        mockActor.get_children = () => [];
        deco.setOverviewMode(true);

        expect(surface.mask).toBe(mask);
        expect(deco.overview.stateView.hasBypass).toBeFalse();

        mockActor.get_children = () => [container];
        deco.setOverviewMode(true);

        expect(container.opacity).toBe(254);
        expect(deco.overview.stateView.hasBypass).toBeTrue();
    });

    it('re-lowers the bypass when the surface container is rebuilt while the overview is open', () => {
        // A window actor re-creation swaps the surface container under the open overview. The
        // bypass was keyed on whether `_bypassContainer` existed, so the new container was never
        // lowered to 254; Mutter's opaque fast path then ignored the shaped-texture mask and the
        // preview went square with no journal line.
        const {container, makeContainer, deco} = setupMaskHarness();
        deco.setOverviewMode(true);
        expect(container.opacity).toBe(254);

        const rebuilt = makeContainer();
        mockActor.get_children = () => [rebuilt];
        deco.setOverviewMode(true);

        expect(rebuilt.opacity).toBe(254);
        expect(container.opacity).toBe(255);
        expect(deco.overview.stateView.hasBypass).toBeTrue();
    });

    it('masks a Wayland window whose preview the overview has not built', () => {
        // The removed gate refused with "the shaped texture, its context or the preview container
        // is unavailable". The mask hangs on the shaped texture every clone paints, so it does
        // not need a card to exist: an empty stage is the entry that beats the overview's first
        // card, and the window still comes out rounded.
        const {mask, surface, previews, shadowClones, warn, deco} =
            setupMaskHarness({drawShadow: true});
        previews.length = 0;

        deco.setOverviewMode(true);

        expect(surface.mask).toBe(mask);
        expect(shadowClones.length).toBe(0);
        expect(warn).not.toHaveBeenCalled();
    });

    it('re-installs the mask on re-entry after drop()', () => {
        const harness = setupMaskHarness();
        harness.deco.setOverviewMode(true);
        expect(harness.surface.mask).toBe(harness.mask);

        // drop() retires the rounded mask through the opaque 1x1; a re-entry installs it again.
        harness.deco.overview.drop();
        harness.deco.setOverviewMode(true);

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

    it('does not re-install anything after the decoration ends', () => {
        // drop() is re-entrant, destroy() is not: once the decoration ends, a late setMode - a
        // card rebuild that raced the teardown - must not put a mask back on a dead window.
        const harness = setupMaskHarness({drawClip: true});
        harness.deco.setOverviewMode(true);
        expect(harness.deco.overview.inOverview).toBeTrue();

        harness.deco.overview.drop();
        expect(harness.deco.overview.inOverview).toBeFalse();

        // The window can still come back while the decoration lives.
        harness.deco.setOverviewMode(true);
        expect(harness.deco.overview.inOverview).toBeTrue();

        harness.deco.overview.destroy();
        expect(harness.deco.overview.inOverview).toBeFalse();

        harness.deco.setOverviewMode(true);
        expect(harness.deco.overview.inOverview).toBeFalse();
    });

    it('warns once when the overview mask refuses although the window was ready', () => {
        // The "square in the overview" defect: the readiness gates passed (there is a buffer and
        // a paint-able actor), so a refusal here leaves a preview square that should be rounded.
        // The bufferless deferral is the healthy case and must stay silent.
        const readings = {
            radius: 12,
            insets: {left: 0, top: 0, right: 0, bottom: 0},
            erase: false,
            scale: 1,
            drawClip: true,
            hasStyle: true,
            shadow: null,
        };
        const harness = setupMaskHarness({buildRoundedMaskReturnsNull: true});
        const {deco, warn} = harness;

        // No buffer yet: "not this pass", not a refusal to report.
        harness.setBuffer(0, 0);
        expect(deco.overview.setMode(true, readings)).toBe('square');
        expect(warn).not.toHaveBeenCalled();

        // Ready, but the builder declines: the first pass is the blip, the second speaks once.
        harness.setBuffer(800, 600);
        deco.overview.setMode(true, readings);
        expect(warn).not.toHaveBeenCalled();
        deco.overview.setMode(true, readings);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.calls.mostRecent().args[0]).toContain('the mask builder returned nothing');

        // The episode stays one line; leaving the overview re-arms for the next entry.
        deco.overview.setMode(true, readings);
        expect(warn).toHaveBeenCalledTimes(1);
        deco.overview.drop();
        deco.overview.setMode(true, readings);
        deco.overview.setMode(true, readings);
        expect(warn).toHaveBeenCalledTimes(2);
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
        const {mask, opaque, surface, deco} = setupMaskHarness();

        deco.setOverviewMode(true);
        expect(surface.mask).toBe(mask);

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

    it('hands a window whose second surface paints its box to the forced legacy clip', () => {
        // Firefox's Picture-in-Picture holds two buffer-sized surfaces at the origin: the mask
        // lands on the main surface's shaped texture while the other surface paints the corners,
        // so the preview stays square however sharp the mask is. Forcing corners is the user
        // asking for the legacy clip in exactly this case.
        const box = {x: 0, y: 0, width: 800, height: 600};
        const harness = setupMaskHarness({
            forceOverviewCorners: true,
            surfaceActors: [box, {...box}],
        });

        harness.deco.setOverviewMode(true);

        expect(harness.surface.mask).toBeNull();
        expect(harness.deco.clip.enabled).toBeTrue();
    });

    it('keeps the mask when the second surface covers no corner', () => {
        // A small subsurface - a video overlay, a client's own widget surface - leaves the corners
        // to the main surface, which is what the mask rounds. The forced clip is not spent on it.
        const harness = setupMaskHarness({
            forceOverviewCorners: true,
            surfaceActors: [
                {x: 0, y: 0, width: 800, height: 600},
                {x: 20, y: 20, width: 100, height: 100},
            ],
        });

        harness.deco.setOverviewMode(true);

        expect(harness.surface.mask).toBe(harness.mask);
        expect(harness.deco.clip.enabled).toBeFalse();
    });

    it('masks a multi-surface window while the setting is off', () => {
        // The admitted square is XWayland's too: without the preference the mask stays the path for
        // every Wayland window, so the surface tree is never read and nothing changes.
        const box = {x: 0, y: 0, width: 800, height: 600};
        const harness = setupMaskHarness({surfaceActors: [box, {...box}]});

        harness.deco.setOverviewMode(true);

        expect(harness.surface.mask).toBe(harness.mask);
        expect(harness.deco.clip.enabled).toBeFalse();
    });

    it('re-reads the surface tree on a rebuild: a window that drops its second surface gets the mask', () => {
        const box = {x: 0, y: 0, width: 800, height: 600};
        const harness = setupMaskHarness({forceOverviewCorners: true, surfaceActors: [box, {...box}]});
        const {surface, deco, setSurfaceActors} = harness;

        deco.setOverviewMode(true);
        expect(surface.mask).toBeNull();
        expect(deco.clip.enabled).toBeTrue();

        // The client destroys the surface that painted the corners. The size-changed reconcile
        // re-reads the tree, and the sharp mask is reachable again.
        setSurfaceActors([box]);
        harness.windowSignals.find(s => s.signal === 'size-changed').cb();

        expect(surface.mask).toBe(harness.mask);
        expect(deco.clip.enabled).toBeFalse();
    });

    it('masks a Wayland window whose shaped texture is directly readable', () => {
        // The pre-fix code asked `paint_to_bitmap()` whether masking would move Mutter's
        // screenshot path and left a directly readable texture square. That refusal is gone:
        // the mask applies to every Wayland window, and nothing reads the texture back.
        const {mask, surface, deco} = setupMaskHarness();

        deco.setOverviewMode(true);

        expect(deco.clip.enabled).toBeFalse();
        expect(surface.mask).toBe(mask);
        expect(surface.paintCalls).toBe(0);

        // Forcing corners does not change it: the mask is the preferred path and it lands, so
        // the forced legacy clip stays suspended.
        const forced = setupMaskHarness({forceOverviewCorners: true});
        forced.deco.setOverviewMode(true);
        expect(forced.deco.clip.enabled).toBeFalse();
        expect(forced.surface.mask).toBe(forced.mask);
        expect(forced.surface.paintCalls).toBe(0);
    });

    it('applies the shaped-texture mask and the surface-container opacity bypass on Wayland', () => {
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

    it('restores the surface container to its own saved opacity, not a hard-coded 255', () => {
        // The container is the shell's actor, not ours: it can already sit below opaque (an
        // overview animation, another decoration). The bypass records what it carried and puts
        // that back, so leaving the overview never raises an actor we found lowered.
        const {container, deco} = setupMaskHarness();
        container.opacity = 200;

        deco.setOverviewMode(true);
        // Already on Mutter's blended path, so the value that goes back is the one it carried.
        expect(container.opacity).toBe(200);

        deco.setOverviewMode(false);
        expect(container.opacity).toBe(200);
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

    it('keeps the mask and the bypass on the client tree when the window moves to another workspace', () => {
        const {mask, surface, container, addPreview, windowSignals, deco} = setupMaskHarness();

        deco.setOverviewMode(true);
        expect(container.opacity).toBe(254);
        expect(surface.mask).toBe(mask);

        // The window moves to another workspace, so the overview builds a fresh preview with a
        // container of its own. The mask is re-installed against the client's own tree, and the
        // bypass stays on the one container every clone paints through; the new card's container
        // keeps whatever opacity the shell gave it.
        const moved = addPreview();
        const handler = windowSignals.find(s => s.signal === 'workspace-changed');
        expect(handler).toBeDefined();
        handler.cb();

        expect(moved.container.opacity).toBe(255);
        expect(container.opacity).toBe(254);
        expect(surface.mask).toBe(mask);
    });

    it('gives every preview of a window its own shadow clone', () => {
        // A window shown on all workspaces has one preview per workspace, and a Clutter.Clone has
        // one parent: `_delegate` named only the last-built card, so the other previews went
        // without a shadow. The previews are read from the stage, so each one gets its own clone.
        const {addPreview, previews, shadowClones, deco} =
            setupMaskHarness({drawShadow: true, allWorkspaces: true, workspaceCount: 2});
        const second = addPreview();

        deco.setOverviewMode(true);

        expect(shadowClones.length).toBe(2);
        expect(shadowClones[0].preview).toBe(previews[0]);
        expect(shadowClones[0].container).toBe(previews[0].window_container);
        expect(shadowClones[1].preview).toBe(second.preview);
        expect(shadowClones[1].container).toBe(second.container);
    });

    it('stops resolving previews once the window has one per workspace', () => {
        // The walk visits every actor in the scene (2189 of them with five windows open on the
        // machine this was measured on, 3.6ms a call), so it must not run on a pass that has
        // nothing to learn. A window on all workspaces expects one preview per workspace; a
        // complete set costs no walk, and the third card is left to the entry that follows.
        const {addPreview, shadowClones, deco} =
            setupMaskHarness({drawShadow: true, allWorkspaces: true, workspaceCount: 2});
        addPreview();
        deco.setOverviewMode(true);
        expect(shadowClones.length).toBe(2);

        // A third card appears, which the window's workspaces do not account for: the mounted set
        // is already as large as the window can have, so this pass learns nothing and pays nothing.
        addPreview();
        deco.setOverviewMode(true);

        expect(shadowClones.length).toBe(2);
    });

    it('tops up the shadow clones when a preview appears after the entry pass', () => {
        // A card can appear after the entry pass, and a settle - the tail of every apply(), not the
        // clear-and-rebuild a workspace refresh runs - tops the set up rather than restarting it:
        // the clone already mounted stays, and the new preview gets its own.
        const {addPreview, shadowClones, deco} =
            setupMaskHarness({drawShadow: true, allWorkspaces: true, workspaceCount: 2});
        deco.setOverviewMode(true);
        expect(shadowClones.length).toBe(1);
        const first = shadowClones[0];

        const added = addPreview();
        deco.setOverviewMode(true);

        expect(shadowClones.length).toBe(2);
        expect(shadowClones[0]).toBe(first);
        expect(first.destroyed).toBeFalse();
        expect(shadowClones[1].preview).toBe(added.preview);
        expect(shadowClones[1].container).toBe(added.container);
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
        const {shadowClones, makeContainer, makePreview, previews, windowSignals, deco} =
            setupMaskHarness({drawShadow: true});
        deco.setOverviewMode(true);
        expect(shadowClones.length).toBe(1);

        // The workspace move destroys the old preview, taking its clone with it, and the window is
        // drawn from a fresh preview. That card is the one the next settle has to find.
        shadowClones[0].destroy();
        const secondPreview = makePreview(makeContainer());
        previews.splice(0, previews.length, secondPreview);
        windowSignals.find(s => s.signal === 'workspace-changed').cb();

        expect(shadowClones.length).toBe(2);
        expect(shadowClones[1].preview).toBe(secondPreview);
        expect(shadowClones[1].container).toBe(secondPreview.window_container);
    });

    it('re-mounts the shadow clones when the desktop shadow source is replaced', () => {
        // The desktop shadow actor is rebuilt while the overview stays open. The mounted set was
        // keyed on the count, so a pass that handed in the new source returned early and left the
        // clones pointing at the destroyed one: every preview lost its shadow for the rest of the
        // overview.
        const {shadowClones, deco} = setupMaskHarness({drawShadow: true});
        deco.setOverviewMode(true);
        expect(shadowClones.length).toBe(1);
        const first = shadowClones[0];

        deco.shadow.destroy();
        const replacement = new MockShadowActor(mockActor, mockContainer);
        deco.shadow = replacement;
        deco.setOverviewMode(true);

        expect(shadowClones.length).toBe(2);
        expect(first.destroyed).toBeTrue();
        expect(shadowClones[1].source).toBe(replacement);
        expect(shadowClones[1].destroyed).toBeFalse();
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

describe('WindowDecoration.initialFrameSize (the visual-floor latch)', () => {
    // The latch lives with the other per-window latches, one per Meta.Window: the visual floor
    // judges the size a window was first decided at, not the size a drag leaves it in. The manager
    // closes it on the first pass the classification landed on; these specs drive it directly.
    const makeDeco = () => new WindowDecoration(null, {container: {}, display: {}});

    it('stays open while the first size is unreadable: 0 and NaN are not values', () => {
        const deco = makeDeco();
        expect(deco.initialFrameSize).toBeNull();
        expect(deco.latchInitialFrameSize({frameWidth: 0, frameHeight: 600})).toBeNull();
        expect(deco.latchInitialFrameSize({frameWidth: Number.NaN, frameHeight: 600})).toBeNull();
        expect(deco.latchInitialFrameSize({frameWidth: Number.POSITIVE_INFINITY, frameHeight: 600})).toBeNull();
        expect(deco.initialFrameSize).toBeNull();
    });

    it('closes on the first readable size and never moves after it', () => {
        const deco = makeDeco();
        expect(deco.latchInitialFrameSize({frameWidth: 800, frameHeight: 600}))
            .toEqual({width: 800, height: 600});
        // A later pass is a drag: the latch answers with the size it kept, not the one it is handed.
        expect(deco.latchInitialFrameSize({frameWidth: 38, frameHeight: 38}))
            .toEqual({width: 800, height: 600});
        expect(deco.initialFrameSize).toEqual({width: 800, height: 600});
    });

    it('an unreadable first size then 800x600: the latch is 800x600 and the window is decorated', () => {
        const deco = makeDeco();
        expect(deco.latchInitialFrameSize({frameWidth: 0, frameHeight: 0})).toBeNull();
        const latched = deco.latchInitialFrameSize({frameWidth: 800, frameHeight: 600});
        expect(latched).toEqual({width: 800, height: 600});
        // What the manager hands `evaluateWindowActions`: the pass's own frame plus the latch.
        const actions = evaluateWindowActions({
            bufferWidth: 800, bufferHeight: 600, frameWidth: 800, frameHeight: 600,
            initialFrameWidth: latched.width, initialFrameHeight: latched.height,
            wmClass: 'test-app',
        });
        expect(actions.drawClip).toBeTrue();
        expect(actions.drawShadow).toBeTrue();
    });

    it('a placeholder frame does not close the latch, the real size that follows does', () => {
        // An apply pass only proves the rect is readable and non-zero, so a 1x1 or 20x20
        // placeholder reaches the latch and must not be judged as the window's size.
        const deco = makeDeco();
        expect(deco.latchInitialFrameSize({frameWidth: 1, frameHeight: 1})).toBeNull();
        expect(deco.latchInitialFrameSize({frameWidth: 20, frameHeight: 20})).toBeNull();
        expect(deco.initialFrameSize).toBeNull();
        expect(deco.latchInitialFrameSize({frameWidth: 800, frameHeight: 600}))
            .toEqual({width: 800, height: 600});
    });

    it('closes at exactly the geometric floor, 30x30: the bound is inclusive', () => {
        const deco = makeDeco();
        expect(deco.latchInitialFrameSize({frameWidth: 30, frameHeight: 30}))
            .toEqual({width: 30, height: 30});
    });
});

describe('WindowDecoration state lifetimes (what an episode boundary must clear)', () => {
    // Every own field answers one question - may it survive a gap? - and the answers are not
    // interchangeable: a hold's reference points must go, a window's first size must not. A field
    // that is not in this table fails the coverage spec below, which is the point: the wrong
    // lifetime is invisible until a window comes back from a minimize.
    //
    //   session  the extension's, for as long as it is enabled
    //   window   this Meta.Window's, latched once and kept across an episode
    //   episode  this episode's, cleared by undecorate()
    //   pass     written again by the next apply(), so nothing to clear
    //   resource an actor or effect, dropped with the episode
    const LIFETIMES = {
        _win: 'window',
        _container: 'window',
        _display: 'session',
        _St: 'session',
        _journal: 'session',
        _RoundedClipEffect: 'session',
        _ShadowActor: 'session',
        _ResizeBand: 'session',
        overview: 'window',
        clip: 'resource',
        shadow: 'resource',
        resizeBand: 'resource',
        clipTarget: 'pass',
        clipInsets: 'pass',
        clipPhaseInTransform: 'pass',
        surfaceContainer: 'pass',
        drawClip: 'pass',
        ring: 'pass',
        _style: 'pass',
        _scaleCandidates: 'pass',
        _pass: 'pass',
        _forceOverviewCorners: 'pass',
        _scale: 'window',
        _initialFrameSize: 'window',
        bodyPlan: 'episode',
        _witness: 'episode',
        _passPlan: 'episode',
        _bufferActorDiagnostic: 'episode',
        _phaseDiagnostic: 'episode',
    };

    const fieldsOf = lifetime => Object.keys(LIFETIMES).filter(field => LIFETIMES[field] === lifetime);
    // One journal for every decoration here, so a diagnostic compares equal to a fresh one - and so a
    // spec that arms one writes nothing to the console.
    const quiet = new Journal({warn: () => {}});
    const makeDeco = () => new WindowDecoration(null, {container: {}, display: {}, journal: quiet});
    const snapshot = (deco, fields) =>
        Object.fromEntries(fields.map(field => [field, deco[field]]));

    it('declares a lifetime for every field and no field it does not own', () => {
        const owned = Object.keys(makeDeco());
        const declared = Object.keys(LIFETIMES);

        expect(owned.filter(field => !declared.includes(field))).toEqual([]);
        expect(declared.filter(field => !owned.includes(field))).toEqual([]);
    });

    it('returns every episode field to its fresh value, so a gap is not evidence', () => {
        const fields = fieldsOf('episode');
        const fresh = makeDeco();
        const deco = makeDeco();
        deco.bodyPlan.next({targetSize: {width: 400, height: 300},
            windowActorSize: {width: 400, height: 300}, windowSize: {width: 400, height: 300}});
        deco._witness = {buffer: {x: 0, y: 0, width: 400, height: 300},
            ring: {left: 1, top: 2, right: 3, bottom: 4}};
        deco._passPlan = deco.bodyPlan.settle;
        for (const diagnostic of [deco._bufferActorDiagnostic, deco._phaseDiagnostic]) {
            diagnostic.check('a violation');
            diagnostic.check('a violation');
        }
        // The seed has to differ from fresh, or the assertion below would pass on an empty episode.
        expect(snapshot(deco, fields)).not.toEqual(snapshot(fresh, fields));

        deco.undecorate();

        expect(snapshot(deco, fields)).toEqual(snapshot(fresh, fields));
    });

    it('keeps what belongs to the window, because a gap says nothing about it', () => {
        const deco = makeDeco();
        const overview = deco.overview;
        deco._scale = 1.3333;
        deco.latchInitialFrameSize({frameWidth: 800, frameHeight: 600});

        deco.undecorate();

        // An unread scale is *unknown*, not 1.0, and the visual floor is latched once per window: a
        // decoration that dropped either would flip its look on the first pass after a minimize.
        expect(deco._scale).toBe(1.3333);
        expect(deco.initialFrameSize).toEqual({width: 800, height: 600});
        expect(deco.overview).toBe(overview);
    });

    it('drops the resources it can drop without a window actor', () => {
        // The shadow is the exception: `_syncShadow` answers the actor it is given, so a bare
        // decoration keeps it. The harness specs cover that path with an actor behind it.
        const deco = makeDeco();
        deco.clip = {remove_effect: () => {}};
        deco.resizeBand = {destroy: () => {}};

        deco.undecorate();

        expect(deco.clip).toBeNull();
        expect(deco.resizeBand).toBeNull();
    });
});
