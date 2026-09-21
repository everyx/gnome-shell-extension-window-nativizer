/**
 * detector unit tests: decoration decisions (jasmine-gjs).
 * Run: pnpm test
 */

import {WindowType} from '../src/lib/mutterRules.generated.js';
import {
    computeInsets, isFractionalScale, shouldClipWindow, isWindowMaximized,
    isWindowTiled, isDecoratableWindowType, checkDecorationEligibility, inferDecorationBaseline,
    evaluateWindowActions, suggestedRuleState, suggestedRuleWouldChange,
    declaredSides, declaresOwnShadow,
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
    // These are the structural gates: facts about the window that a user rule
    // must never be able to override.
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

    it('Wayland window declaring a 4px ring (Chromium/CEF) -> read the same way as on X11', () => {
        const r = inferDecorationBaseline({
            isX11: false,
            ...marginsFromRects(1156, 852, 1148, 844),
        });
        expect(r.shadow).toBeFalse();
        expect(r.corners).toBeTrue();
        expect(r.reason).toBe('has-csd(4.0x4.0)');
    });

    it('X11 / XWayland windows without frame extents (WPS Office, Dida) -> Mutter C core manages native shadow, clips corners', () => {
        const r = inferDecorationBaseline({isX11: true, ...marginsFromRects(800, 600, 800, 600)});
        expect(r.shadow).toBeFalse();
        expect(r.corners).toBeTrue();
        expect(r.reason).toBe('x11-mutter-native-shadow');
    });

    it('server-side decorations (SSD, traditional X11 app with system titlebar) -> retains native shadow, clips corners', () => {
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

    it('X11 with a small declared margin -> the client owns that shadow, baseline still rounds', () => {
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
        expect(res.clearRing).toBeTrue();
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
        // 25px sits below MIN_DECORABLE_SIZE (30) but above MIN_BAND_WINDOW (24), so
        // decoration is off while the band still fits - the resize axis must not inherit
        // the decoration gate.
        const res = evaluateWindowActions({
            ...baseWin,
            bufferWidth: 25, bufferHeight: 300, frameWidth: 25, frameHeight: 300,
        });
        expect(res.drawShadow).toBeFalse();
        expect(res.drawClip).toBeFalse();
        expect(res.drawResize).toBeTrue();
        expect(res.reason).toBe('too-small(25x300)');
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

    it('X11 window without frame extents (WPS, dida): skips shadow due to native Mutter shadow, clips corners', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            isX11: true,
            wmClass: 'wps',
        });
        expect(res.drawShadow).toBeFalse();
        expect(res.drawClip).toBeTrue();
        expect(res.reason).toBe('x11-mutter-native-shadow');
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
        expect(res.clearRing).toBeTrue();
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

    it('a 4px declared ring (WeChat/CEF: X11, extents 4,4,4,4) -> corners ours, ring cleared, our shadow', () => {
        // Captured real-world data: buf=[1156, 852], frame=[1148, 844], 4px per edge
        const res = evaluateWindowActions({
            ...baseWin,
            isX11: true,
            wmClass: 'wechat',
            bufferWidth: 1156, bufferHeight: 852,
            frameWidth: 1148, frameHeight: 844,
        });
        expect(res.drawClip).toBeTrue();
        expect(res.clearRing).toBeTrue();
        expect(res.drawShadow).toBeTrue();
        expect(res.reason).toBe('ring-cleared(has-csd(4.0x4.0))');
    });

    it('a bare window (no declared extents) is still not client-decorated: zero is not a ring', () => {
        // A `>= 0` reading would make every bare window "declared", and on X11 that
        // would put our shadow on top of Mutter's native one.
        const x11 = evaluateWindowActions({...baseWin, isX11: true, wmClass: 'wps'});
        expect(x11.clearRing).toBeFalse();
        expect(x11.drawShadow).toBeFalse();
        expect(x11.reason).toBe('x11-mutter-native-shadow');

        const wayland = evaluateWindowActions({...baseWin, wmClass: 'bare-app'});
        expect(wayland.clearRing).toBeFalse();
        expect(wayland.drawShadow).toBeTrue();
        expect(wayland.reason).toBe('no-csd(0.0x0.0)');
    });

    it('a margin on one axis only is a declared ring too (asymmetric extents, e.g. TLBR 0,0,12,12)', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            wmClass: 'asymmetric-app',
            // Real per-side extents: left, right, top, bottom = 0, 0, 12, 12.
            insets: {left: 0, right: 0, top: 12, bottom: 12},
        });
        expect(res.drawClip).toBeTrue();
        expect(res.clearRing).toBeTrue();
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
        expect(res.clearRing).toBeTrue();
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
        expect(res.clearRing).toBeTrue();
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
        expect(res.clearRing).toBeFalse();
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
        expect(res.clearRing).toBeFalse();
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

    it('client type is part of the window kind: an X11 window does not match a Wayland rule', () => {
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
        expect(res.clearRing).toBeTrue();
        expect(res.reason).toMatch(/^ring-cleared\(has-csd\(/);
    });

    it('the ring is cleared exactly when the shadow is ours', () => {
        const clearRingFor = state => evaluateWindowActions({
            ...ringedWindow,
            wmClass: 'gtk4-app',
            rules: {[buildRuleKey('gtk4-app', {hasRing: true})]: state},
        }).clearRing;

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
        expect(res.clearRing).toBeFalse();
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
        expect(res.clearRing).toBeTrue();
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

    it('a tile match is about our shadow, so it no longer clears a client\'s own ring', () => {
        // Tiled means flat corners, so there is no clip; the client's ring is not
        // ours to erase just because a policy dropped the shadow we would draw.
        const res = evaluateWindowActions({
            ...ringedWindow,
            wmClass: 'gtk4-app',
            hasTileMatch: true,
            tiled: true,
        });
        expect(res.drawClip).toBeFalse();
        expect(res.drawShadow).toBeFalse();
        expect(res.clearRing).toBeFalse();
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
        expect(res.clearRing).toBeFalse();
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

        it('keys the rule the way the runtime looks it up', () => {
            expect(buildRuleKeyFromProperties(propertiesFor(plainWindow))).toBe(buildRuleKey('plain-app'));
        });
    });
});
