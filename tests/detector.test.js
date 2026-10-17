/**
 * detector unit tests: decoration decisions (jasmine-gjs).
 * Run: pnpm test
 */

import {WindowType} from '../src/lib/mutterRules.generated.js';
import {ADWAITA_STYLE} from '../src/lib/adwaitaStyle.generated.js';
import {
    HIGHLIGHT_BORDER_WIDTH, VISUAL_MIN_DECORABLE_SIZE,
    computeInsets, isFractionalScale, shouldClipWindow, isWindowMaximized,
    isWindowTiled, isDecoratableWindowType, checkDecorationEligibility, inferDecorationBaseline,
    evaluateWindowActions, suggestedRuleState, suggestedRuleWouldChange,
    declaredSides, declaresOwnShadow,
    expectedWindowRadius, highlightBoundingBox, highlightOuterRadius,
} from '../src/lib/detector.js';
import {
    buildRuleKey,
} from '../src/lib/rules.js';
import {
    buildRuleKeyFromProperties,
} from '../src/lib/pick.js';



/** Per-side margins from a buffer/frame rectangle pair (matches runtime math). */
function marginsFromRects(bufferWidth, bufferHeight, frameWidth, frameHeight) {
    const {w, h} = computeInsets(bufferWidth, bufferHeight, frameWidth, frameHeight);
    return {sideW: w / 2, sideH: h / 2};
}

describe('computeInsets', () => {
    it('buffer == frame -> zero insets', () => {
        const {w, h} = computeInsets(400, 300, 400, 300);
        expect(w).toBe(0);
        expect(h).toBe(0);
    });

    it('buffer > frame -> positive insets', () => {
        const {w, h} = computeInsets(400, 300, 360, 260);
        expect(w).toBe(40);
        expect(h).toBe(40);
    });

    it('frame > buffer -> clamps to zero rather than going negative', () => {
        const {w, h} = computeInsets(400, 300, 440, 340);
        expect(w).toBe(0);
        expect(h).toBe(0);
    });
});

describe('isDecoratableWindowType', () => {
    const KNOWN_DECORATABLE = Object.freeze([
        WindowType.NORMAL,
        WindowType.DIALOG,
        WindowType.MODAL_DIALOG,
        WindowType.UTILITY,
    ]);

    const KNOWN_NON_DECORATABLE = Object.freeze([
        WindowType.DESKTOP,
        WindowType.DOCK,
        WindowType.TOOLBAR,
        WindowType.MENU,
        WindowType.SPLASHSCREEN,
        WindowType.DROPDOWN_MENU,
        WindowType.POPUP_MENU,
        WindowType.TOOLTIP,
        WindowType.NOTIFICATION,
        WindowType.COMBO,
        WindowType.DND,
        WindowType.OVERRIDE_OTHER,
    ]);

    it('partitions the entire WindowType enum with every member explicitly classified (canary test)', () => {
        const classifiedSet = new Set([...KNOWN_DECORATABLE, ...KNOWN_NON_DECORATABLE]);
        const upstreamValues = new Set(Object.values(WindowType));

        // The enum comes from the vendored generator output, so a member upstream adds fails
        // here until it is classified on purpose - and the test stays offline.
        expect(classifiedSet).toEqual(upstreamValues);
    });

    it('returns true for all decoratable window types', () => {
        for (const type of KNOWN_DECORATABLE)
            expect(isDecoratableWindowType(type)).toBeTrue();
    });

    it('returns false for transient menus, popups, tooltips, and auxiliary surfaces', () => {
        for (const type of KNOWN_NON_DECORATABLE)
            expect(isDecoratableWindowType(type)).toBeFalse();
    });

    it('defaults to WindowType.NORMAL when called without arguments', () => {
        expect(isDecoratableWindowType()).toBeTrue();
    });
});

describe('checkDecorationEligibility', () => {
    // The structural gates and the geometric floor are the facts a user rule must never be
    // able to override; the visual floor below is a reading, and carries the rule exit.
    const base = {
        windowType: WindowType.NORMAL,
        isMaximized: false,
        isFullscreen: false,
    };

    it('plain normal window -> eligible', () => {
        expect(checkDecorationEligibility(base)).toEqual({eligible: true, reason: ''});
    });

    it('every decoratable window type is eligible', () => {
        for (const windowType of [
            WindowType.NORMAL, WindowType.DIALOG,
            WindowType.MODAL_DIALOG, WindowType.UTILITY,
        ])
            expect(checkDecorationEligibility({...base, windowType}).eligible).toBeTrue();
    });

    it('server-side decorations (SSD) are not a structural gate: gating lives in the baseline', () => {
        // checkDecorationEligibility() takes no hasSsd parameter; SSD windows stay
        // eligible here and are resolved per-axis by inferDecorationBaseline().
        expect(checkDecorationEligibility(base)).toEqual({eligible: true, reason: ''});
        const r = inferDecorationBaseline({hasSsd: true, ...marginsFromRects(800, 600, 800, 600)});
        expect(r).toEqual({shadow: false, corners: true, reason: 'has-ssd-frame'});
    });

    it('maximized / fullscreen -> ineligible', () => {
        expect(checkDecorationEligibility({...base, isMaximized: true}))
            .toEqual({eligible: false, reason: 'maximized/fullscreen'});
        expect(checkDecorationEligibility({...base, isFullscreen: true}))
            .toEqual({eligible: false, reason: 'maximized/fullscreen'});
    });

    it('degenerate helper surfaces (e.g. wl-clipboard 1x1) -> ineligible', () => {
        const r = checkDecorationEligibility({...base, frameWidth: 1, frameHeight: 1});
        expect(r.eligible).toBeFalse();
        expect(r.reason).toBe('too-small(1x1)');
    });

    it('the visual floor reads the latched initial size: 38 is rejected, 39 is not', () => {
        // The two sizes are separate sources: the window was first decided at 38 and is 38
        // now, so both floors read 38 here. VISUAL_MIN_DECORABLE_SIZE is 38.
        expect(VISUAL_MIN_DECORABLE_SIZE).toBe(38);
        expect(checkDecorationEligibility({
            ...base, frameWidth: 38, frameHeight: 38,
            initialFrameWidth: 38, initialFrameHeight: 38,
        })).toEqual({eligible: false, reason: 'too-small-for-corners(38x38)', reversible: true});
        expect(checkDecorationEligibility({
            ...base, frameWidth: 39, frameHeight: 39,
            initialFrameWidth: 39, initialFrameHeight: 39,
        })).toEqual({eligible: true, reason: ''});
    });

    it('an unlatched initial size is not a size: the visual floor abstains', () => {
        // Null is "not read yet" and 0 is degenerate; neither is judged, so both passes are
        // eligible on the geometric floor alone and the caller keeps the latch open.
        expect(checkDecorationEligibility({...base, frameWidth: 38, frameHeight: 38}).eligible).toBeTrue();
        expect(checkDecorationEligibility({
            ...base, frameWidth: 38, frameHeight: 38,
            initialFrameWidth: 0, initialFrameHeight: 0,
        }).eligible).toBeTrue();
        expect(checkDecorationEligibility({
            ...base, frameWidth: 800, frameHeight: 600,
            initialFrameWidth: Number.NaN, initialFrameHeight: Number.NaN,
        }).eligible).toBeTrue();
    });

    it('the geometric floor is a capability reading the current size, not the initial one', () => {
        // The initial size is comfortable, but the frame is 29 right now: no rounded rect fits
        // at that size, and no rule reaches a capability.
        const r = checkDecorationEligibility({
            ...base, frameWidth: 29, frameHeight: 29,
            initialFrameWidth: 800, initialFrameHeight: 600,
        });
        expect(r).toEqual({eligible: false, reason: 'too-small(29x29)'});
    });

    it('the visual floor is derived from the style, not written down', () => {
        const reach = Math.max(...ADWAITA_STYLE.window.shadows.map(({blur, spread}) => blur + spread));
        expect(VISUAL_MIN_DECORABLE_SIZE)
            .toBe(Math.max(2.5 * ADWAITA_STYLE.window.radius, 2 * reach));
    });

    it('non-normal window type -> ineligible and names the offending type', () => {
        const r = checkDecorationEligibility({...base, windowType: WindowType.DOCK});
        expect(r.eligible).toBeFalse();
        expect(r.reason).toBe(`window-type=${WindowType.DOCK}`);
    });

    it('uses sane defaults when called without arguments', () => {
        expect(checkDecorationEligibility()).toEqual({eligible: true, reason: ''});
    });
});

describe('inferDecorationBaseline', () => {
    // Geometric inference: who already paints a shadow, answered per axis.
    const normal = marginsFromRects(400, 300, 400, 300);

    it('non-CSD normal window -> both axes on', () => {
        const r = inferDecorationBaseline(normal);
        expect(r.shadow).toBeTrue();
        expect(r.corners).toBeTrue();
        expect(r.reason).toContain('no-csd');
    });

    it('WeChat article / browser window (XWayland, CEF, extents 4,4,4,4) -> its ring is the client\'s, so the shadow is not ours', () => {
        // Captured real-world data: buf=[1156, 852], frame=[1148, 844], 4px per edge
        const r = inferDecorationBaseline({
            isX11: true,
            ...marginsFromRects(1156, 852, 1148, 844),
        });
        expect(r.shadow).toBeFalse();
        expect(r.corners).toBeTrue();
        expect(r.reason).toBe('has-csd(4.0x4.0)');
    });

    it('Wayland window declaring a 4px ring (Chromium/CEF) -> read the same way as on XWayland', () => {
        const r = inferDecorationBaseline({
            isX11: false,
            ...marginsFromRects(1156, 852, 1148, 844),
        });
        expect(r.shadow).toBeFalse();
        expect(r.corners).toBeTrue();
        expect(r.reason).toBe('has-csd(4.0x4.0)');
    });

    it('XWayland windows without frame extents (WPS Office, Dida) -> Mutter C core manages native shadow, clips corners', () => {
        const r = inferDecorationBaseline({isX11: true, bufferAlpha: false, ...marginsFromRects(800, 600, 800, 600)});
        expect(r.shadow).toBeFalse();
        expect(r.corners).toBeTrue();
        expect(r.reason).toBe('x11-mutter-native-shadow');
    });

    it('bare XWayland with an RGB buffer -> Mutter paints that shadow, so ours stays off', () => {
        const r = inferDecorationBaseline({isX11: true, bufferAlpha: false, ...marginsFromRects(800, 600, 800, 600)});
        expect(r.shadow).toBeFalse();
        expect(r.corners).toBeTrue();
        expect(r.reason).toBe('x11-mutter-native-shadow');
    });

    it('bare XWayland with an RGBA buffer -> Mutter abstains, so the shadow is ours', () => {
        const r = inferDecorationBaseline({isX11: true, bufferAlpha: true, ...marginsFromRects(800, 600, 800, 600)});
        expect(r.shadow).toBeTrue();
        expect(r.corners).toBeTrue();
        expect(r.reason).toBe('x11-rgba-shadow-ours');
    });

    it('bare XWayland with an unreadable buffer -> abstain from both axes, never stacking or cutting', () => {
        const r = inferDecorationBaseline({isX11: true, bufferAlpha: null, ...marginsFromRects(800, 600, 800, 600)});
        expect(r.shadow).toBeFalse();
        expect(r.corners).toBeFalse();
        expect(r.reason).toBe('x11-shadow-unknown');
    });

    it('server-side decorations (SSD, traditional XWayland app with system titlebar) -> retains native shadow, clips corners', () => {
        const r = inferDecorationBaseline({hasSsd: true, ...marginsFromRects(800, 600, 800, 600)});
        expect(r.shadow).toBeFalse();
        expect(r.corners).toBeTrue();
        expect(r.reason).toBe('has-ssd-frame');
    });

    it('corners that already look like ours -> left alone, while the shadow follows its margins', () => {
        const bare = inferDecorationBaseline({nativeLikeCorners: true, ...marginsFromRects(800, 600, 800, 600)});
        expect(bare.corners).toBeFalse();
        expect(bare.shadow).toBeTrue(); // no margin declared: no shadow of its own to respect
        expect(bare.reason).toContain('native-like-corners');
        expect(bare.reason).toContain('no-csd'); // the shadow axis keeps the reason it decided by

        const declared = inferDecorationBaseline({nativeLikeCorners: true, ...marginsFromRects(850, 650, 800, 600)});
        expect(declared.corners).toBeFalse();
        expect(declared.shadow).toBeFalse(); // its own declared CSD shadow
    });

    it('XWayland with a small declared margin -> the client owns that shadow, baseline still rounds', () => {
        const r = inferDecorationBaseline({isX11: true, ...marginsFromRects(808, 604, 800, 600)});
        expect(r.shadow).toBeFalse();
        expect(r.corners).toBeTrue();
        expect(r.reason).toBe('has-csd(4.0x2.0)');
    });

    it('genuine self-drawn CSD shadow (single side 20px) -> keeps its shadow, still rounds', () => {
        // Margins: 20px left/right (bufferWidth=440, frameWidth=400), 20px top/bottom
        const r = inferDecorationBaseline(marginsFromRects(440, 340, 400, 300));
        expect(r.shadow).toBeFalse();
        expect(r.corners).toBeTrue();
        expect(r.reason).toBe('has-csd(20.0x20.0)');
    });

    it('a margin on one axis only is still a declaration (Mutter asks whether extents exist, not both axes)', () => {
        const r = inferDecorationBaseline(marginsFromRects(440, 300, 400, 300));
        expect(r.shadow).toBeFalse();
        expect(r.corners).toBeTrue();
        expect(r.reason).toBe('has-csd(20.0x0.0)');
    });
});

describe('declaresOwnShadow', () => {
    // `_GTK_FRAME_EXTENTS` is a per-side ring (left, right, top, bottom), so the two
    // readings below start from real extents and not from a symmetric total.
    const ring = (left, right, top, bottom) => declaredSides({insets: {left, right, top, bottom}});

    it('reads a ring from either side of an axis, not from both (TLBR)', () => {
        // Mutter sets has_custom_frame_extents for the property alone, so any positive
        // margin declares - 1px on one side is as much a ring as 40px on every side.
        expect(declaresOwnShadow(ring(0, 0, 24, 24).declaringSides)).toBeTrue();
        expect(declaresOwnShadow(ring(24, 0, 24, 0).declaringSides)).toBeTrue();
        expect(declaresOwnShadow(ring(0, 0, 12, 12).declaringSides)).toBeTrue();
        expect(declaresOwnShadow(ring(0, 0, 0, 0).declaringSides)).toBeFalse();
    });

    it('the shadow axis reads the per-axis maximum, the band the minimum', () => {
        // The regression this pair exists for: (0,24,0,24) has a zero on each axis's
        // narrow reading, so feeding `narrowestSides` to the shadow axis turned a declared
        // ring into a bare window and left the client's shadow under ours (double shadow).
        expect(declaresOwnShadow(ring(0, 24, 0, 24).narrowestSides)).toBeFalse();
        expect(declaresOwnShadow(ring(0, 24, 0, 24).declaringSides)).toBeTrue();
        expect(declaresOwnShadow(ring(24, 0, 24, 0).narrowestSides)).toBeFalse();
        expect(declaresOwnShadow(ring(24, 0, 24, 0).declaringSides)).toBeTrue();
    });

    it('SSD frame ring is not a client declaration (semantics), even when margins are positive', () => {
        expect(declaresOwnShadow({hasSsd: true, sideW: 20, sideH: 20})).toBeFalse();
        expect(declaresOwnShadow({hasSsd: true, sideW: 0, sideH: 0})).toBeFalse();
        expect(declaresOwnShadow({hasSsd: false, sideW: 20, sideH: 20})).toBeTrue();
    });

    it('SSD ring is still taken over by strategy: declaresOwnShadow false yet evaluate clears it', () => {
        // Semantic predicate says SSD ring is not client-declared.
        expect(declaresOwnShadow({hasSsd: true, sideW: 20, sideH: 20})).toBeFalse();
        // Strategy layer (inferDecorationBaseline + evaluateWindowActions) still takes it over.
        const res = evaluateWindowActions({
            bufferWidth: 400, bufferHeight: 300,
            frameWidth: 400, frameHeight: 300,
            hasSsd: true,
            isX11: true,
            insets: {left: 25, top: 25, right: 25, bottom: 25},
            wmClass: 'navicat',
        });
        expect(res.drawShadow).toBeTrue();
        expect(res.ring.clear).toBeTrue();
        expect(res.drawClip).toBeTrue();
        expect(res.reason).toBe('ring-cleared(has-ssd-frame)');
    });
});

describe('isFractionalScale', () => {
    it('integer scales (1, 2, 3) -> not fractional', () => {
        expect(isFractionalScale(1.0)).toBeFalse();
        expect(isFractionalScale(2.0)).toBeFalse();
        expect(isFractionalScale(3.0)).toBeFalse();
    });

    it('common fractional scales (1.25, 1.333333, 1.5, 1.75) -> fractional', () => {
        expect(isFractionalScale(1.25)).toBeTrue();
        expect(isFractionalScale(1.333333)).toBeTrue();
        expect(isFractionalScale(1.5)).toBeTrue();
        expect(isFractionalScale(1.75)).toBeTrue();
        expect(isFractionalScale(2.25)).toBeTrue();
    });

    it('non-number or abnormal scale -> conservatively not fractional', () => {
        expect(isFractionalScale(null)).toBeFalse();
        expect(isFractionalScale(undefined)).toBeFalse();
        expect(isFractionalScale(0)).toBeFalse();
        expect(isFractionalScale(-1)).toBeFalse();
        expect(isFractionalScale(NaN)).toBeFalse();
    });
});

describe('shouldClipWindow', () => {
    it('preferCrispText=false (default) always enables rounded corner clipping', () => {
        expect(shouldClipWindow({preferCrispText: false, scale: 1.0})).toBeTrue();
        expect(shouldClipWindow({preferCrispText: false, scale: 1.333333})).toBeTrue();
        expect(shouldClipWindow({preferCrispText: false, scale: 2.0})).toBeTrue();
    });

    it('preferCrispText=true skips corner clipping on fractional scale displays, retains on integer scale displays', () => {
        // Integer scale displays retain
        expect(shouldClipWindow({preferCrispText: true, scale: 1.0})).toBeTrue();
        expect(shouldClipWindow({preferCrispText: true, scale: 2.0})).toBeTrue();
        // Fractional scale displays skip
        expect(shouldClipWindow({preferCrispText: true, scale: 1.25})).toBeFalse();
        expect(shouldClipWindow({preferCrispText: true, scale: 1.333333})).toBeFalse();
        expect(shouldClipWindow({preferCrispText: true, scale: 1.5})).toBeFalse();
        expect(shouldClipWindow({preferCrispText: true, scale: 1.75})).toBeFalse();
    });

    it('skips clipping under prefer-crisp-text when the scale is unknown', () => {
        // The unreadable scale is its own state, not an integer: clipping a fractional window
        // on a transient read would blur the text this setting protects. Skipping leaves an
        // already-correct unclipped display alone until the next reconcile retries the read.
        expect(shouldClipWindow({preferCrispText: true, scale: null})).toBeFalse();
        // The setting is the only thing that asks the question; without it, clip as before.
        expect(shouldClipWindow({preferCrispText: false, scale: null})).toBeTrue();
    });
});

describe('evaluateWindowActions', () => {
    const baseWin = {
        bufferWidth: 400, bufferHeight: 300,
        frameWidth: 400, frameHeight: 300,
        monitorScale: 1,
        isX11: false,
        windowType: WindowType.NORMAL,
        wmClass: 'test-app',
    };
    // A client that declared a ring: the baseline reads the shadow as the client's,
    // and the automatic corner takeover makes it ours again.
    const ringedWindow = {...baseWin, bufferWidth: 460, bufferHeight: 360};

    it('degenerate helper surface (wl-clipboard 1x1): no decoration', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            bufferWidth: 1, bufferHeight: 1, frameWidth: 1, frameHeight: 1,
        });
        expect(res.drawShadow).toBeFalse();
        expect(res.drawClip).toBeFalse();
        expect(res.reason).toBe('too-small(1x1)');
    });

    it('a window too small for corners keeps its band: the axes are independent', () => {
        // 25px sits below the geometric floor MIN_DECORABLE_SIZE (30) but above
        // MIN_BAND_WINDOW (24), so decoration is off while the band still fits - the resize
        // axis must not inherit the decoration gate, and no latch was read here either.
        const res = evaluateWindowActions({
            ...baseWin,
            bufferWidth: 25, bufferHeight: 300, frameWidth: 25, frameHeight: 300,
        });
        expect(res.drawShadow).toBeFalse();
        expect(res.drawClip).toBeFalse();
        expect(res.drawResize).toBeTrue();
        expect(res.reason).toBe('too-small(25x300)');
    });

    it('the visual floor reads the initial size, the geometric floor the size right now', () => {
        // The pair this design turns on. First decided at 40, then dragged to 38: still above
        // the geometric floor, and the visual judgment was made on a size the user never chose,
        // so the decoration stays through the whole drag.
        const dragged = evaluateWindowActions({
            ...baseWin,
            bufferWidth: 38, bufferHeight: 38, frameWidth: 38, frameHeight: 38,
            initialFrameWidth: 40, initialFrameHeight: 40,
        });
        expect(dragged.drawClip).toBeTrue();
        expect(dragged.drawShadow).toBeTrue();

        // Dragged one more pixel past the geometric floor: no rounded rect fits at 29, and that
        // is a fact about the frame right now, so the decoration goes for as long as it is there.
        const under = evaluateWindowActions({
            ...baseWin,
            bufferWidth: 29, bufferHeight: 29, frameWidth: 29, frameHeight: 29,
            initialFrameWidth: 40, initialFrameHeight: 40,
        });
        expect(under.drawClip).toBeFalse();
        expect(under.reason).toBe('too-small(29x29)');

        // And the floor no longer asks whether the user may resize the window: a resizable one
        // first decided at 38 is abstained from exactly like a fixed-size one.
        const resizable = evaluateWindowActions({
            ...baseWin, allowsResize: true,
            bufferWidth: 38, bufferHeight: 38, frameWidth: 38, frameHeight: 38,
            initialFrameWidth: 38, initialFrameHeight: 38,
        });
        expect(resizable.drawClip).toBeFalse();
        expect(resizable.reason).toBe('too-small-for-corners(38x38)');
    });

    it('a corners rule recovers a window the visual floor abstained from', () => {
        // The floor is a reading of the decoration, not a capability, so it is the corner axis's
        // automatic answer (off) and naming that axis reverses it. The shadow is not named, so it
        // follows the same floor: a bare 38px window gets corners without the shadow.
        const res = evaluateWindowActions({
            ...baseWin, wmClass: 'tiny-tool',
            bufferWidth: 38, bufferHeight: 38, frameWidth: 38, frameHeight: 38,
            initialFrameWidth: 38, initialFrameHeight: 38,
            rules: {[buildRuleKey('tiny-tool')]: 'corners'},
        });
        expect(res.drawClip).toBeTrue();
        expect(res.drawShadow).toBeFalse();
        expect(res.reason).toBe('rule-applied(tiny-tool:corners)');

        // The same window the other way: the shadow alone, with the corners left off.
        const shadow = evaluateWindowActions({
            ...baseWin, wmClass: 'tiny-tool',
            bufferWidth: 38, bufferHeight: 38, frameWidth: 38, frameHeight: 38,
            initialFrameWidth: 38, initialFrameHeight: 38,
            rules: {[buildRuleKey('tiny-tool')]: 'shadow'},
        });
        expect(shadow.drawShadow).toBeTrue();
        expect(shadow.drawClip).toBeFalse();
    });

    it('the visual floor is a logical ratio: the monitor scale does not enter it', () => {
        const fixed = (side, monitorScale) => evaluateWindowActions({
            ...baseWin, monitorScale,
            bufferWidth: side, bufferHeight: side, frameWidth: side, frameHeight: side,
            initialFrameWidth: side, initialFrameHeight: side,
        });
        for (const side of [38, 39])
            expect(fixed(side, 1.3333)).toEqual(fixed(side, 1.0));
    });

    it('a kind that is never decorated gets no band either', () => {
        const res = evaluateWindowActions({...baseWin, windowType: WindowType.DESKTOP});
        expect(res.drawResize).toBeFalse();
    });

    it('tiled window: flat corners, so no clip is drawn', () => {
        // The clip axis is on, but the tiled style is radius 0 with no outline, so
        // there is nothing to draw - the decision now lives in evaluateWindowActions().
        const lone = evaluateWindowActions({...baseWin, tiled: true});
        expect(lone.drawClip).toBeFalse();
        expect(lone.drawShadow).toBeTrue();

        const matched = evaluateWindowActions({...baseWin, tiled: true, hasTileMatch: true});
        expect(matched.drawClip).toBeFalse();
        expect(matched.drawShadow).toBeFalse();
    });

    it('returns the style the decision was made with, so a caller cannot re-derive it', () => {
        const res = evaluateWindowActions({...baseWin, tiled: true});
        expect(res.style.radius).toBe(0);
        expect(res.style.outline).toBeNull();
    });

    it('default normal non-CSD window: both shadow and clip enabled', () => {
        const res = evaluateWindowActions(baseWin);
        expect(res.drawShadow).toBeTrue();
        expect(res.drawClip).toBeTrue();
        expect(res.reason).toContain('no-csd');
    });

    it('XWayland window without frame extents (WPS, dida): skips shadow due to native Mutter shadow, clips corners', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            isX11: true,
            bufferAlpha: false,
            wmClass: 'wps',
        });
        expect(res.drawShadow).toBeFalse();
        expect(res.drawClip).toBeTrue();
        expect(res.reason).toBe('x11-mutter-native-shadow');
    });

    it('bare XWayland with an RGBA buffer: our shadow and our corners together', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            isX11: true,
            bufferAlpha: true,
            wmClass: 'wps',
        });
        expect(res.drawShadow).toBeTrue();
        expect(res.drawClip).toBeTrue();
        expect(res.reason).toBe('x11-rgba-shadow-ours');
    });

    it('bare XWayland with no readable buffer: neither axis, so nothing of ours is drawn', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            isX11: true,
            bufferAlpha: null,
            wmClass: 'wps',
        });
        expect(res.drawShadow).toBeFalse();
        expect(res.drawClip).toBeFalse();
        expect(res.drawRing).toBeFalse();
        expect(res.reason).toBe('x11-shadow-unknown');
    });

    it('the buffer alpha decides a bare X11 window only: Wayland reads the same either way', () => {
        const rgba = evaluateWindowActions({...baseWin, bufferAlpha: true});
        const rgb = evaluateWindowActions({...baseWin, bufferAlpha: false});
        expect([rgba.drawShadow, rgba.drawClip, rgba.reason])
            .toEqual([rgb.drawShadow, rgb.drawClip, rgb.reason]);
        expect(rgba.drawShadow).toBeTrue();
        expect(rgba.drawClip).toBeTrue();
    });

    it('a declared ring keeps the client\'s shadow label whatever the buffer alpha says', () => {
        const ringed = alpha => evaluateWindowActions({
            ...baseWin,
            isX11: true,
            bufferAlpha: alpha,
            wmClass: 'wechat',
            bufferWidth: 1156, bufferHeight: 852,
            frameWidth: 1148, frameHeight: 844,
        });
        expect(ringed(true).reason).toBe('ring-cleared(has-csd(4.0x4.0))');
        expect(ringed(true)).toEqual(ringed(false));
    });

    it('SSD window: retains native shadow and clips corners', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            hasSsd: true,
            wmClass: 'xclock',
        });
        expect(res.drawShadow).toBeFalse();
        expect(res.drawClip).toBeTrue();
        expect(res.reason).toBe('has-ssd-frame');
    });

    it('SSD window with insets: clears frame shadow ring and draws native Adwaita shadow', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            hasSsd: true,
            isX11: true,
            insets: {left: 25, top: 25, right: 25, bottom: 25},
            wmClass: 'navicat',
        });
        expect(res.drawShadow).toBeTrue();
        expect(res.drawClip).toBeTrue();
        expect(res.ring.clear).toBeTrue();
        expect(res.reason).toBe('ring-cleared(has-ssd-frame)');
    });

    it('corners that already look like ours: clip skipped, shadow still read from the margins', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            nativeLikeCorners: true,
            wmClass: 'org.gnome.Nautilus',
        });
        expect(res.drawShadow).toBeTrue(); // baseWin declares no margin
        expect(res.drawClip).toBeFalse();
        expect(res.reason).toContain('native-like-corners');
        expect(res.reason).toContain('no-csd');
    });

    it('corners that already look like ours, with a declared margin: both axes left alone', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            bufferWidth: 440, bufferHeight: 340,
            nativeLikeCorners: true,
            wmClass: 'org.gnome.Nautilus',
        });
        expect(res.drawShadow).toBeFalse();
        expect(res.drawClip).toBeFalse();
    });

    it('a 4px declared ring (WeChat/CEF: XWayland, extents 4,4,4,4) -> corners ours, ring cleared, our shadow', () => {
        // Captured real-world data: buf=[1156, 852], frame=[1148, 844], 4px per edge
        const res = evaluateWindowActions({
            ...baseWin,
            isX11: true,
            wmClass: 'wechat',
            bufferWidth: 1156, bufferHeight: 852,
            frameWidth: 1148, frameHeight: 844,
        });
        expect(res.drawClip).toBeTrue();
        expect(res.ring.clear).toBeTrue();
        expect(res.drawShadow).toBeTrue();
        expect(res.reason).toBe('ring-cleared(has-csd(4.0x4.0))');
    });

    it('a bare window (no declared extents) is still not client-decorated: zero is not a ring', () => {
        // A `>= 0` reading would make every bare window "declared", and on XWayland that
        // would put our shadow on top of Mutter's native one.
        const x11 = evaluateWindowActions({...baseWin, isX11: true, bufferAlpha: false, wmClass: 'wps'});
        expect(x11.ring.clear).toBeFalse();
        expect(x11.drawShadow).toBeFalse();
        expect(x11.reason).toBe('x11-mutter-native-shadow');

        const wayland = evaluateWindowActions({...baseWin, wmClass: 'bare-app'});
        expect(wayland.ring.clear).toBeFalse();
        expect(wayland.drawShadow).toBeTrue();
        expect(wayland.reason).toBe('no-csd(0.0x0.0)');
    });

    it('an unreadable ring is covered like a flat one, so the client ring stays painted', () => {
        // `insetsFromRects` refuses when the frame overshoots the buffer, so `insets` is null and
        // the pass reads flat. The takeover is kept: our shadow is still drawn while `ring.clear`
        // is false, so the client's own shadow stays painted under ours and the clip covers only
        // `flatSafeInsets` of its ring - a double shadow for as long as the reading lasts. That is
        // deliberate; the owner corrects the takeover per window with a rule.
        const ringed = evaluateWindowActions({
            ...baseWin,
            bufferWidth: 408, bufferHeight: 304,
            insets: {left: 4, top: 4, right: 4, bottom: 4},
            wmClass: 'intermittent-ring',
        });
        expect(ringed.drawShadow).toBeTrue();
        expect(ringed.drawClip).toBeTrue();
        expect(ringed.ring.clear).toBeTrue();

        const unreadable = evaluateWindowActions({
            ...baseWin,
            insets: null,
            wmClass: 'intermittent-ring',
        });
        expect(unreadable.drawShadow).toBeTrue();
        expect(unreadable.ring.clear).toBeFalse();
        expect(unreadable.ring.safeInset).toBeTrue();
    });

    it('a margin on one axis only is a declared ring too (asymmetric extents, e.g. TLBR 0,0,12,12)', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            wmClass: 'asymmetric-app',
            // Real per-side extents: left, right, top, bottom = 0, 0, 12, 12.
            insets: {left: 0, right: 0, top: 12, bottom: 12},
        });
        expect(res.drawClip).toBeTrue();
        expect(res.ring.clear).toBeTrue();
        expect(res.drawShadow).toBeTrue();
        expect(res.reason).toBe('ring-cleared(has-csd(0.0x12.0))');
    });

    it('a ring on the far side of each axis alone is still the client\'s ring (TLBR 0,0,24,24)', () => {
        // Double-shadow regression: the shadow axis must read the per-axis maximum. A
        // per-axis minimum answers "no ring", leaving the client's own shadow in place
        // while we draw ours.
        const res = evaluateWindowActions({
            ...baseWin,
            wmClass: 'one-side-ring-app',
            insets: {left: 0, right: 0, top: 24, bottom: 24},
        });
        expect(res.drawClip).toBeTrue();
        expect(res.ring.clear).toBeTrue();
        expect(res.drawShadow).toBeTrue();
        expect(res.reason).toBe('ring-cleared(has-csd(0.0x24.0))');
    });

    it('clears a ring that is positive only on one side of each axis (TLBR 0,24,0,24)', () => {
        // The case a per-axis minimum reads as no ring at all, and so leaves the client's
        // own shadow on screen next to ours.
        const res = evaluateWindowActions({
            ...baseWin,
            wmClass: 'staggered-ring-app',
            insets: {left: 0, right: 24, top: 0, bottom: 24},
        });
        expect(res.drawClip).toBeTrue();
        expect(res.ring.clear).toBeTrue();
        expect(res.drawShadow).toBeTrue();
        expect(res.reason).toBe('ring-cleared(has-csd(24.0x24.0))');
    });

    // ---- user rules: a state names the axes whose automatic decision is reversed ----

    it('a rule naming both decoration axes reverses both the heuristic drew', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            wmClass: 'custom-tool',
            rules: {[buildRuleKey('custom-tool')]: 'corners,shadow'},
        });
        expect(res.drawShadow).toBeFalse();
        expect(res.drawClip).toBeFalse();
        expect(res.ring.clear).toBeFalse();
        expect(res.drawResize).toBeTrue();
        expect(res.reason).toBe('rule-applied(custom-tool:corners,shadow)');
    });

    it('a rule naming all three axes leaves nothing of ours', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            wmClass: 'overlay-app',
            rules: {[buildRuleKey('overlay-app')]: 'corners,shadow,resize'},
        });
        expect(res.drawShadow).toBeFalse();
        expect(res.drawClip).toBeFalse();
        expect(res.ring.clear).toBeFalse();
        expect(res.drawResize).toBeFalse();
        expect(res.reason).toBe('rule-applied(overlay-app:corners,shadow,resize)');
    });

    it('reversing the shadow leaves the heuristic\'s corners: a rounded window without our shadow', () => {
        // The baseline draws both axes, so naming the shadow turns ours off while the
        // corners follow the heuristic and stay ours.
        const res = evaluateWindowActions({
            ...baseWin,
            wmClass: 'wechat',
            rules: {[buildRuleKey('wechat')]: 'shadow'},
        });
        expect(res.drawShadow).toBeFalse();
        expect(res.drawClip).toBeTrue();
        expect(res.reason).toBe('rule-applied(wechat:shadow)');
    });

    it('reversing the corners leaves the heuristic\'s shadow', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            wmClass: 'custom-tool',
            rules: {[buildRuleKey('custom-tool')]: 'corners'},
        });
        expect(res.drawShadow).toBeTrue();
        expect(res.drawClip).toBeFalse();
        expect(res.reason).toBe('rule-applied(custom-tool:corners)');
    });

    it('a rule reverses the named axes against the ringed window\'s baseline', () => {
        // The ring makes the automatic decision corners on / shadow on: drawing our corners
        // takes the client's shadow over. A rule reverses that decision, takeover included.
        const actionsFor = state => evaluateWindowActions({
            ...ringedWindow,
            wmClass: 'gtk4-app',
            rules: {[buildRuleKey('gtk4-app', {hasRing: true})]: state},
        });

        // Corners reversed off: neither our corners nor the takeover shadow are ours.
        const corners = actionsFor('corners');
        expect([corners.drawShadow, corners.drawClip]).toEqual([false, false]);

        // Shadow reversed: the takeover made it ours, so reversing retracts ours while
        // the corners still follow the decision.
        const shadow = actionsFor('shadow');
        expect([shadow.drawShadow, shadow.drawClip]).toEqual([false, true]);

        // Both reversed: our shadow without our corners.
        const both = actionsFor('corners,shadow');
        expect([both.drawShadow, both.drawClip]).toEqual([true, false]);
    });

    it('reversing the shadow re-enables it on an x11-mutter-native-shadow baseline', () => {
        // The baseline keeps Mutter's uncleatable X11 shadow off; naming the shadow
        // reverses that reading and draws ours, with the heuristic's corners untouched.
        const res = evaluateWindowActions({
            ...baseWin,
            isX11: true,
            bufferAlpha: false,
            wmClass: 'wps',
            rules: {[buildRuleKey('wps', {clientType: 'x11'})]: 'shadow'},
        });
        expect(res.drawShadow).toBeTrue();
        expect(res.drawClip).toBeTrue();
        expect(res.reason).toBe('rule-applied(wps:shadow)');
    });

    it('rules cannot override structural ineligibility: maximized', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            isMaximized: true,
            wmClass: 'wechat',
            rules: {[buildRuleKey('wechat')]: 'corners,shadow,resize'},
        });
        expect(res.drawShadow).toBeFalse();
        expect(res.drawClip).toBeFalse();
        expect(res.reason).toBe('maximized/fullscreen');
    });

    it('rules cannot override structural ineligibility: fullscreen', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            isFullscreen: true,
            wmClass: 'wechat',
            rules: {[buildRuleKey('wechat')]: 'corners,shadow,resize'},
        });
        expect(res.drawShadow).toBeFalse();
        expect(res.drawClip).toBeFalse();
        expect(res.reason).toBe('maximized/fullscreen');
    });

    it('rules cannot override structural ineligibility: non-normal window type', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            windowType: WindowType.DOCK,
            wmClass: 'dock-app',
            rules: {[buildRuleKey('dock-app', {windowType: WindowType.DOCK})]: 'corners,shadow,resize'},
        });
        expect(res.drawShadow).toBeFalse();
        expect(res.drawClip).toBeFalse();
        expect(res.reason).toBe(`window-type=${WindowType.DOCK}`);
    });

    it('has_ssd is part of the kind: an SSD window matches only its own key', () => {
        const ssd = {...baseWin, hasSsd: true, wmClass: 'legacy-x11'};
        // A rule written for the bare kind does not apply to the SSD kind...
        const bare = evaluateWindowActions({
            ...ssd,
            rules: {[buildRuleKey('legacy-x11')]: 'corners'},
        });
        expect(bare.reason).not.toContain('rule-applied');
        // ...and the SSD kind's own key does.
        const own = evaluateWindowActions({
            ...ssd,
            rules: {[buildRuleKey('legacy-x11', {hasSsd: true})]: 'corners'},
        });
        expect(own.reason).toBe('rule-applied(legacy-x11:corners)');
    });

    it('rule for one window kind leaves other kinds of the same app decorated', () => {
        const rules = {
            [buildRuleKey('wechat', {hasParent: true, allowsResize: false})]: 'corners,shadow',
        };

        // Main window (top-level, resizable) is a different kind -> untouched
        const mainWin = evaluateWindowActions({
            ...baseWin,
            wmClass: 'wechat',
            hasParent: false,
            allowsResize: true,
            rules,
        });
        expect(mainWin.drawShadow).toBeTrue();
        expect(mainWin.drawClip).toBeTrue();

        // Fixed child dialog matches the rule
        const dialogWin = evaluateWindowActions({
            ...baseWin,
            wmClass: 'wechat',
            hasParent: true,
            allowsResize: false,
            rules,
        });
        expect(dialogWin.drawShadow).toBeFalse();
        expect(dialogWin.drawClip).toBeFalse();
        expect(dialogWin.reason).toContain('rule-applied');

        // Resizable child of the same app is a different kind -> untouched
        const resizableChild = evaluateWindowActions({
            ...baseWin,
            wmClass: 'wechat',
            hasParent: true,
            allowsResize: true,
            rules,
        });
        expect(resizableChild.drawShadow).toBeTrue();
        expect(resizableChild.drawClip).toBeTrue();
    });

    it('client type is part of the window kind: an XWayland window does not match a Wayland rule', () => {
        const rules = {
            [buildRuleKey('wechat', {clientType: 'wayland', hasParent: true, allowsResize: false})]: 'corners,shadow',
        };

        const waylandChild = evaluateWindowActions({
            ...baseWin,
            wmClass: 'wechat',
            isX11: false,
            hasParent: true,
            allowsResize: false,
            rules,
        });
        expect(waylandChild.drawShadow).toBeFalse();

        // XWayland variant with 4px frame extents: decorated, because the stored
        // rule targets the Wayland kind only.
        const x11Child = evaluateWindowActions({
            ...baseWin,
            wmClass: 'wechat',
            isX11: true,
            bufferWidth: 408,
            bufferHeight: 304,
            hasParent: true,
            allowsResize: false,
            rules,
        });
        expect(x11Child.drawShadow).toBeTrue();
        expect(x11Child.drawClip).toBeTrue();
    });

    // ---- the client's own shadow ring ----

    it('CSD window (GTK4): with no rule, rounding its corners takes its own shadow over', () => {
        const res = evaluateWindowActions({...ringedWindow, wmClass: 'gtk4-app'});
        expect(res.drawShadow).toBeTrue();
        expect(res.drawClip).toBeTrue();
        expect(res.ring.clear).toBeTrue();
        expect(res.reason).toMatch(/^ring-cleared\(has-csd\(/);
    });

    it('the ring is cleared exactly when the shadow is ours', () => {
        const clearRingFor = state => evaluateWindowActions({
            ...ringedWindow,
            wmClass: 'gtk4-app',
            rules: {[buildRuleKey('gtk4-app', {hasRing: true})]: state},
        }).ring.clear;

        // The takeover makes the shadow ours, so reversing the shadow retracts it and the
        // ring stays the client's. Reversing both drops the takeover and then reverses the
        // client's own shadow instead, which is ours again.
        expect(clearRingFor('shadow')).toBeFalse();
        expect(clearRingFor('corners,shadow')).toBeTrue();
        // Reversing the corners off leaves the client's shadow (and its ring) theirs.
        expect(clearRingFor('corners')).toBeFalse();
    });

    it('reversing the corners leaves the client\'s own shadow and its ring alone', () => {
        // Corners off means the ring takeover does not fire, so the client keeps both
        // its shadow and the ring it was drawn with.
        const res = evaluateWindowActions({
            ...ringedWindow,
            wmClass: 'gtk4-app',
            rules: {[buildRuleKey('gtk4-app', {hasRing: true})]: 'corners'},
        });
        expect(res.drawClip).toBeFalse();
        expect(res.drawShadow).toBeFalse();
        expect(res.ring.clear).toBeFalse();
        expect(res.reason).toBe('rule-applied(gtk4-app:corners)');
    });

    it('reversing both axes takes the ring over without our corners', () => {
        // Corners reversed off + shadow reversed on: the ring becomes ours without
        // rounding the window with our corners.
        const res = evaluateWindowActions({
            ...ringedWindow,
            wmClass: 'gtk4-app',
            rules: {[buildRuleKey('gtk4-app', {hasRing: true})]: 'corners,shadow'},
        });
        expect(res.drawShadow).toBeTrue();
        expect(res.drawClip).toBeFalse();
        expect(res.ring.clear).toBeTrue();
        expect(res.reason).toBe('ring-cleared(rule-applied(gtk4-app:corners,shadow))');
    });

    it('applies exact size rule for fixed-size windows to differentiate dialogs', () => {
        const qrKey = buildRuleKey('multi-dlg-app', {hasRing: true, allowsResize: false, width: 360, height: 420});
        const toolbarKey = buildRuleKey('multi-dlg-app', {hasRing: true, allowsResize: false, width: 240, height: 48});

        const rules = {
            [qrKey]: 'shadow',
            [toolbarKey]: 'corners',
        };

        const qrWin = evaluateWindowActions({
            ...ringedWindow,
            allowsResize: false,
            frameWidth: 360,
            frameHeight: 420,
            wmClass: 'multi-dlg-app',
            rules,
        });
        // The QR dialog's rule reverses the shadow, which retracts the takeover; the
        // toolbar's reverses the corners, which drops the clip and the takeover with it.
        expect(qrWin.drawClip).toBeTrue();
        expect(qrWin.drawShadow).toBeFalse();

        const toolbarWin = evaluateWindowActions({
            ...ringedWindow,
            allowsResize: false,
            frameWidth: 240,
            frameHeight: 48,
            wmClass: 'multi-dlg-app',
            rules,
        });
        expect(toolbarWin.drawClip).toBeFalse();
        expect(toolbarWin.drawShadow).toBeFalse();
    });

    it('erases a client\'s ring only when the tiled style draws one', () => {
        // The two decisions were once made separately: clearRing said the ring was ours to erase and
        // the manager decided separately whether to create the actor. A tiled SSD window, or one that
        // does not allow resizing, drew no ring and still had the client\'s erased - no edge at all.
        for (const [extra, expected] of [[{}, true], [{hasSsd: true}, false], [{allowsResize: false}, false]]) {
            const res = evaluateWindowActions({
                ...ringedWindow,
                wmClass: 'gtk4-app',
                tiled: true,
                ...extra,
            });
            expect(res.drawRing).toBe(expected);
            expect(res.ring.clear).toBe(expected);
        }
    });

    it('a tile match draws the tiled ring, so the client\'s own ring is ours to clear', () => {
        // Tiled means flat corners, so the clip draws nothing - but the tiled style draws the 1px
        // ring itself, and the client's ring has to go for ours to replace it rather than stack on
        // top of it. Measured before this: the client's ~12% and our 15% composited to 25%.
        const res = evaluateWindowActions({
            ...ringedWindow,
            wmClass: 'gtk4-app',
            hasTileMatch: true,
            tiled: true,
        });
        expect(res.drawClip).toBeFalse();
        expect(res.drawShadow).toBeFalse();
        expect(res.ring.clear).toBeTrue();
    });

    it('crisp text on a has-csd window leaves it entirely alone', () => {
        // The clip is what resamples text, so the preference drops it. With no new corner
        // shape, the client's shadow still fits its window, so the ring stays its own.
        const res = evaluateWindowActions({
            ...ringedWindow,
            wmClass: 'gtk4-app',
            preferCrispText: true,
            monitorScale: 1.25,
        });
        expect(res.drawClip).toBeFalse();
        expect(res.drawShadow).toBeFalse();
        expect(res.ring.clear).toBeFalse();
    });

    it('GNOME tiling alignment: hasTileMatch suppresses shadow to prevent adjacent window obstruction', () => {
        // Aligns with Mutter's has_shadow() snap-tile gate (meta-window-actor-x11.c)
        const snapTiledWin = evaluateWindowActions({
            ...baseWin,
            isMaximized: false,
            hasTileMatch: true,
        });
        expect(snapTiledWin.drawShadow).toBeFalse();
        expect(snapTiledWin.drawClip).toBeTrue();
        expect(snapTiledWin.reason).toContain('tile-match(shadow-off');
    });

    it('GNOME tiling alignment: single tiled window without match retains shadow', () => {
        const singleTiledWin = evaluateWindowActions({
            ...baseWin,
            isMaximized: false,
            hasTileMatch: false,
        });
        expect(singleTiledWin.drawShadow).toBeTrue();
        expect(singleTiledWin.drawClip).toBeTrue();
    });

    it('GNOME tiling alignment: full maximized window skips all decorations', () => {
        const maximizedWin = evaluateWindowActions({
            ...baseWin,
            isMaximized: true,
            hasTileMatch: false,
        });
        expect(maximizedWin.drawShadow).toBeFalse();
        expect(maximizedWin.drawClip).toBeFalse();
        expect(maximizedWin.reason).toBe('maximized/fullscreen');
    });

    it('preferCrispText retains rounded corners on integer scale displays (1.0x, 2.0x)', () => {
        const res1 = evaluateWindowActions({
            ...baseWin,
            monitorScale: 1.0,
            preferCrispText: true,
        });
        expect(res1.drawShadow).toBeTrue();
        expect(res1.drawClip).toBeTrue();

        const res2 = evaluateWindowActions({
            ...baseWin,
            monitorScale: 2.0,
            preferCrispText: true,
        });
        expect(res2.drawShadow).toBeTrue();
        expect(res2.drawClip).toBeTrue();
    });

    it('preferCrispText skips corner clipping on fractional scale displays (1.25x, 1.333x, 1.5x) while retaining shadow', () => {
        for (const fracScale of [1.25, 1.333333, 1.5, 1.75]) {
            const res = evaluateWindowActions({
                ...baseWin,
                monitorScale: fracScale, // monitor physical scale
                preferCrispText: true,
            });
            expect(res.drawShadow).toBeTrue();
            expect(res.drawClip).toBeFalse();
        }
    });

    it('preferCrispText disabled retains rounded corners on fractional scale displays', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            monitorScale: 1.333333,
            preferCrispText: false,
        });
        expect(res.drawShadow).toBeTrue();
        expect(res.drawClip).toBeTrue();
    });
});

describe('isWindowMaximized', () => {
    it('uses win.is_maximized() canonical method', () => {
        const winTrue = {
            is_maximized: () => true,
        };
        expect(isWindowMaximized(winTrue)).toBeTrue();

        const winFalse = {
            is_maximized: () => false,
        };
        expect(isWindowMaximized(winFalse)).toBeFalse();
    });

    it('handles null/undefined gracefully', () => {
        expect(isWindowMaximized(null)).toBeFalse();
        expect(isWindowMaximized(undefined)).toBeFalse();
        expect(isWindowMaximized({})).toBeFalse();
    });
});

describe('isWindowTiled', () => {
    it('returns false for fully maximized window', () => {
        const win = {
            is_maximized: () => true,
            maximized_horizontally: true,
            maximized_vertically: true,
            get_tile_match: () => ({}),
        };
        expect(isWindowTiled(win)).toBeFalse();
        expect(isWindowTiled(win, {isMaximized: true})).toBeFalse();
    });

    it('returns true for single-axis half-tiled window (hMax !== vMax)', () => {
        const winSnapLeft = {
            is_maximized: () => false,
            maximized_horizontally: false,
            maximized_vertically: true,
        };
        expect(isWindowTiled(winSnapLeft)).toBeTrue();

        const winSnapTop = {
            is_maximized: () => false,
            maximized_horizontally: true,
            maximized_vertically: false,
        };
        expect(isWindowTiled(winSnapTop)).toBeTrue();
    });

    it('returns true when get_tile_match() returns an adjacent window', () => {
        const winWithMatch = {
            is_maximized: () => false,
            maximized_horizontally: false,
            maximized_vertically: false,
            get_tile_match: () => ({title: 'Adjacent Window'}),
        };
        expect(isWindowTiled(winWithMatch)).toBeTrue();
    });

    it('returns false for normal non-tiled floating window', () => {
        const floatingWin = {
            is_maximized: () => false,
            maximized_horizontally: false,
            maximized_vertically: false,
            get_tile_match: () => null,
        };
        expect(isWindowTiled(floatingWin)).toBeFalse();
    });

    it('does not call a window tiled just because its frame sits flush', () => {
        const win = {
            is_maximized: () => false,
            maximized_horizontally: false,
            maximized_vertically: false,
            get_tile_match: () => null,
            // The same rectangle a left tile would occupy, placed by hand: Mutter reports no
            // tiling state for it, so the frame is not evidence and must not be read as any.
            get_frame_rect: () => ({x: 0, y: 29, width: 960, height: 1051}),
            get_monitor: () => 0,
            get_work_area_for_monitor: () => ({x: 0, y: 29, width: 1920, height: 1051}),
        };
        expect(isWindowTiled(win)).toBeFalse();
    });

    it('handles null/undefined gracefully', () => {
        expect(isWindowTiled(null)).toBeFalse();
        expect(isWindowTiled(undefined)).toBeFalse();
    });
});

describe('the pick heuristic', () => {
    // What a window we decorate looks like: the client declares no margin at all.
    const plainWindow = {
        bufferWidth: 400, bufferHeight: 300,
        frameWidth: 400, frameHeight: 300,
        monitorScale: 1,
        windowType: WindowType.NORMAL,
        wmClass: 'plain-app',
    };
    // A client that declares its own margins, so the heuristic stands down.
    const csdWindow = {
        ...plainWindow,
        bufferWidth: 460, bufferHeight: 360,
        wmClass: 'csd-app',
    };
    // A client that already looks like us and paints its own shadow: no axis of ours.
    const nativeWindow = {...csdWindow, nativeLikeCorners: true, wmClass: 'adw-app'};
    const propertiesFor = win => ({
        wmClass: win.wmClass,
        clientType: 'wayland',
        windowType: String(win.windowType),
        hasParent: 'false',
        allowsResize: 'true',
        isAttachedDialog: 'false',
        hasRing: String(!win.hasSsd && (win.bufferWidth > win.frameWidth || win.bufferHeight > win.frameHeight)),
        hasSsd: String(Boolean(win.hasSsd)),
    });

    describe('suggestedRuleState', () => {
        it('corrects every axis the kind can be corrected on', () => {
            // Both are ordinary resizable windows: all three axes can be acted on.
            expect(suggestedRuleState(plainWindow)).toBe('corners,shadow,resize');
            expect(suggestedRuleState(csdWindow)).toBe('corners,shadow,resize');
        });

        it('corrects the axes of a window that already looks right too', () => {
            // nativeWindow looks like us and paints its own shadow, and Firefox's PiP is
            // deliberately left native-like: the heuristic draws no clip of ours on either.
            // The pick still proposes the full correction - the user picked the window
            // because it looks wrong, and correcting corners is how it gets rounded.
            expect(suggestedRuleState(nativeWindow)).toBe('corners,shadow,resize');
            expect(suggestedRuleState({...nativeWindow, wmClass: 'firefox'})).toBe('corners,shadow,resize');
        });

        it('leaves out an axis the runtime could not act on', () => {
            // The compositor's own frame owns the handles of an SSD window, so the resize
            // axis has no decision to reverse - a rule naming it could not take effect.
            const ssdNative = {...plainWindow, hasSsd: true, wmClass: 'ssd-adw-app'};
            expect(suggestedRuleState(ssdNative)).toBe('corners,shadow');
            // Same for a window that cannot be resized at all.
            expect(suggestedRuleState({...plainWindow, allowsResize: false, wmClass: 'fixed-app'}))
                .toBe('corners,shadow');
        });

        it('suggests nothing for a kind we never decorate', () => {
            expect(suggestedRuleState({...plainWindow, windowType: WindowType.MENU})).toBe('');
        });

        it('judges the kind, not the transient state the window is in', () => {
            // A maximized or tiled window is not decorated while it is in that state, but
            // the rule outlives it, and the axes are the kind's either way.
            expect(suggestedRuleState({...plainWindow, isMaximized: true})).toBe('corners,shadow,resize');
            expect(suggestedRuleState({...plainWindow, hasTileMatch: true, tiled: true})).toBe('corners,shadow,resize');
        });

        it('proposes the same correction for a kind that already has a rule', () => {
            // The suggestion answers for the kind's capability, so a stored rule neither
            // adds nor removes an axis; prefs separately refuses a pick that changes nothing.
            const decorated = {
                ...nativeWindow,
                rules: {[buildRuleKey('adw-app', {hasRing: true})]: 'corners'},
            };
            expect(suggestedRuleState(decorated)).toBe('corners,shadow,resize');
        });
    });

    describe('suggestedRuleWouldChange', () => {
        it('reports no effect when the state reverses nothing', () => {
            // '' names no axis, so the automatic decisions stand and the rule is a no-op.
            expect(suggestedRuleWouldChange(propertiesFor(plainWindow), plainWindow, '')).toBeFalse();
        });

        it('reports an effect when reversing the shadow retracts the ring takeover', () => {
            // csdWindow's automatic shadow is ours (the corner takeover drew it), so
            // reversing the shadow axis retracts it - a real change.
            expect(suggestedRuleWouldChange(propertiesFor(csdWindow), csdWindow, 'shadow')).toBeTrue();
        });

        it('reports an effect when reversing all three axes on a window we decorate', () => {
            expect(suggestedRuleWouldChange(propertiesFor(plainWindow), plainWindow, 'corners,shadow,resize')).toBeTrue();
        });

        it('reports an effect when storing corners only for a window that draws its own shadow', () => {
            // The rule lets the client keep its shadow, so the takeover no longer fires.
            expect(suggestedRuleWouldChange(propertiesFor(csdWindow), csdWindow, 'corners')).toBeTrue();
        });

        it('reports no effect when the state names an axis the structure gates', () => {
            // An SSD window has no band whatever the rule says, so reversing resize is inert.
            const ssdNative = {...nativeWindow, hasSsd: true, wmClass: 'ssd-native'};
            expect(suggestedRuleWouldChange(propertiesFor(ssdNative), ssdNative, 'resize')).toBeFalse();
        });

        it('reports an effect when reversing the band retracts it', () => {
            // Reversing resize turns the heuristic's band off.
            expect(suggestedRuleWouldChange(propertiesFor(nativeWindow), nativeWindow, 'resize')).toBeTrue();
        });

        it('reports no effect for a window type we never decorate', () => {
            const menu = {...plainWindow, windowType: WindowType.MENU};

            expect(suggestedRuleWouldChange(propertiesFor(menu), menu, 'corners,shadow')).toBeFalse();
            expect(suggestedRuleWouldChange(propertiesFor(menu), menu, 'corners,shadow,resize')).toBeFalse();
        });

        it('judges the rule against the kind, not the state the window is in', () => {
            // A maximized window is never decorated, but the rule outlives the state.
            const maximized = {...plainWindow, isMaximized: true};
            expect(suggestedRuleWouldChange(propertiesFor(maximized), maximized, 'corners,shadow,resize')).toBeTrue();
        });

        it('preserves the hasSsd / nativeLikeCorners kind attributes while normalizing transient state', () => {
            // Maximized (transient) is normalized away, but hasSsd (kind) is kept: the
            // proposal is judged against the SSD kind's own key.
            const ssd = {...plainWindow, hasSsd: true, isMaximized: true, wmClass: 'xclock'};
            expect(propertiesFor(ssd).hasSsd).toBe('true');
            expect(suggestedRuleWouldChange(propertiesFor(ssd), ssd, 'corners,shadow,resize')).toBeTrue();
            // Corners that already look like ours are left alone - but reversing all three
            // also retracts the heuristic band, so it still changes the outcome.
            const nativeLike = {...csdWindow, nativeLikeCorners: true, isMaximized: true, wmClass: 'adw-app'};
            expect(suggestedRuleWouldChange(propertiesFor(nativeLike), nativeLike, 'corners,shadow,resize')).toBeTrue();
            expect(suggestedRuleWouldChange(propertiesFor(nativeLike), nativeLike, '')).toBeFalse();
        });

        it('suggests nothing for a structurally ineligible window, and any rule is inert', () => {
            // A menu is never decorated, so there is nothing to correct - and a state
            // stored for it would have no effect, which is what the pre-flight reports.
            const menu = {...plainWindow, windowType: WindowType.MENU};
            expect(suggestedRuleState(menu)).toBe('');
            expect(suggestedRuleWouldChange(propertiesFor(menu), menu, 'corners,shadow')).toBeFalse();
        });

        it('returns null when the window declares no identity', () => {
            const anonymous = {...plainWindow, wmClass: ''};
            expect(suggestedRuleWouldChange(propertiesFor(anonymous), anonymous, 'corners,shadow')).toBeNull();
        });

        it('reports an effect on a window the visual floor abstained from', () => {
            // The floor is a reading, so naming an axis is a real correction - which is what makes
            // the known boundary (a window mapped tiny) recoverable by a pick.
            const floored = {
                ...plainWindow, wmClass: 'tiny-tool',
                bufferWidth: 38, bufferHeight: 38, frameWidth: 38, frameHeight: 38,
                initialFrameWidth: 38, initialFrameHeight: 38,
            };
            expect(suggestedRuleWouldChange(propertiesFor(floored), floored, 'corners')).toBeTrue();
            expect(suggestedRuleWouldChange(propertiesFor(floored), floored, 'shadow')).toBeTrue();
        });

        it('keys the rule the way the runtime looks it up', () => {
            expect(buildRuleKeyFromProperties(propertiesFor(plainWindow))).toBe(buildRuleKey('plain-app'));
        });
    });

    describe('expectedWindowRadius', () => {
        it('returns 0 for fullscreen, maximized, or tiled windows', () => {
            expect(expectedWindowRadius({isFullscreen: true, isActivelyClipped: true})).toBe(0);
            expect(expectedWindowRadius({isMaximized: true, isActivelyClipped: true})).toBe(0);
            expect(expectedWindowRadius({isTiled: true, isActivelyClipped: true})).toBe(0);
            expect(expectedWindowRadius({isFullscreen: true, hasNativeLikeCorners: true})).toBe(0);
            expect(expectedWindowRadius({isMaximized: true, hasNativeLikeCorners: true})).toBe(0);
            expect(expectedWindowRadius({isTiled: true, hasNativeLikeCorners: true})).toBe(0);
        });

        it('returns baseRadius when the window is actively clipped by the extension', () => {
            expect(expectedWindowRadius({isActivelyClipped: true})).toBe(ADWAITA_STYLE.window.radius);
            expect(expectedWindowRadius({isActivelyClipped: true, hasSsd: true})).toBe(ADWAITA_STYLE.window.radius);
            expect(expectedWindowRadius({isActivelyClipped: true, baseRadius: 12})).toBe(12);
        });

        it('returns baseRadius for native-like applications without SSD', () => {
            expect(expectedWindowRadius({hasNativeLikeCorners: true, hasSsd: false})).toBe(ADWAITA_STYLE.window.radius);
            expect(expectedWindowRadius({hasNativeLikeCorners: true, hasSsd: false, baseRadius: 16})).toBe(16);
        });

        it('returns 0 for native-like applications with SSD (server-side frame takes precedence unless clipped)', () => {
            expect(expectedWindowRadius({hasNativeLikeCorners: true, hasSsd: true, isActivelyClipped: false})).toBe(0);
        });

        it('returns 0 for unclipped windows without native-like corners (e.g. plain XWayland, Qt, SSD)', () => {
            expect(expectedWindowRadius({})).toBe(0);
            expect(expectedWindowRadius({hasSsd: true})).toBe(0);
            expect(expectedWindowRadius({hasNativeLikeCorners: false})).toBe(0);
        });
    });

    describe('highlightBoundingBox', () => {
        it('returns zero box for null or undefined frame', () => {
            expect(highlightBoundingBox(null)).toEqual({x: 0, y: 0, width: 0, height: 0});
            expect(highlightBoundingBox(undefined)).toEqual({x: 0, y: 0, width: 0, height: 0});
        });

        it('outsets the bounding box by the specified border width', () => {
            const frame = {x: 100, y: 100, width: 600, height: 400};
            expect(highlightBoundingBox(frame)).toEqual({
                x: 100 - HIGHLIGHT_BORDER_WIDTH,
                y: 100 - HIGHLIGHT_BORDER_WIDTH,
                width: 600 + HIGHLIGHT_BORDER_WIDTH * 2,
                height: 400 + HIGHLIGHT_BORDER_WIDTH * 2,
            });
            const explicit = HIGHLIGHT_BORDER_WIDTH + 1;
            expect(highlightBoundingBox(frame, explicit)).toEqual({
                x: 100 - explicit,
                y: 100 - explicit,
                width: 600 + explicit * 2,
                height: 400 + explicit * 2,
            });
        });

        it('supports custom border widths', () => {
            const frame = {x: 50, y: 80, width: 200, height: 150};
            expect(highlightBoundingBox(frame, 6)).toEqual({
                x: 44,
                y: 74,
                width: 212,
                height: 162,
            });
        });
    });

    describe('highlightOuterRadius', () => {
        it('returns 0 when inner radius is 0 (sharp 90 degree square corners)', () => {
            expect(highlightOuterRadius(0)).toBe(0);
            expect(highlightOuterRadius(0, 3)).toBe(0);
            expect(highlightOuterRadius(0, 6)).toBe(0);
        });

        it('calculates concentric outer radius (innerRadius + borderWidth) for rounded windows', () => {
            expect(highlightOuterRadius(15)).toBe(15 + HIGHLIGHT_BORDER_WIDTH);
            expect(highlightOuterRadius(15, 3)).toBe(18);
            expect(highlightOuterRadius(16, 3)).toBe(19);
            expect(highlightOuterRadius(12, 3)).toBe(15);
            expect(highlightOuterRadius(15, 6)).toBe(21);
        });
    });
});
