/**
 * detector unit tests: decoration decisions (jasmine-gjs).
 * Run: pnpm test
 */

import {
    WindowType, MUTTER_CSD_MIN_INSET_THRESHOLD,
} from '../src/lib/mutterRules.generated.js';
import {
    computeInsets, isFractionalScale, shouldClipWindow, isWindowMaximized,
    isWindowTiled, checkDecorationEligibility, inferDecorationBaseline,
    evaluateWindowActions, pickedRuleWouldChange,
} from '../src/lib/detector.js';
import {
    RuleDirection, buildRuleKey,
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

    it('WeChat article / browser window (XWayland, Chromium 4px resize grip) single side < 8px -> Mutter skips native shadow, baseline decorates', () => {
        // Captured real-world data: buf=[1156, 852], frame=[1148, 844], 4px per edge
        const r = inferDecorationBaseline({
            isX11: true,
            ...marginsFromRects(1156, 852, 1148, 844),
        });
        expect(r.shadow).toBeTrue();
        expect(r.corners).toBeTrue();
        expect(r.reason).toContain('no-csd');
        expect(r.reason).toContain(`4.0x4.0 < ${MUTTER_CSD_MIN_INSET_THRESHOLD}`);
    });

    it('Wayland window with small resize grip (Chromium 4px resize grip) single side < 8px -> detected as lacking CSD, baseline decorates', () => {
        const r = inferDecorationBaseline({
            isX11: false,
            ...marginsFromRects(1156, 852, 1148, 844),
        });
        expect(r.shadow).toBeTrue();
        expect(r.corners).toBeTrue();
        expect(r.reason).toContain('no-csd');
        expect(r.reason).toContain(`4.0x4.0 < ${MUTTER_CSD_MIN_INSET_THRESHOLD}`);
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

    it('X11 with a small non-zero grip declares custom frame extents -> baseline still decorates', () => {
        const r = inferDecorationBaseline({isX11: true, ...marginsFromRects(808, 604, 800, 600)});
        expect(r.shadow).toBeTrue();
        expect(r.corners).toBeTrue();
        expect(r.reason).toContain('no-csd');
    });

    it('genuine self-drawn CSD shadow (single side 20px+ >= 8px) -> keeps its shadow, still rounds', () => {
        // Margins: 20px left/right (bufferWidth=440, frameWidth=400), 20px top/bottom
        const r = inferDecorationBaseline(marginsFromRects(440, 340, 400, 300));
        expect(r.shadow).toBeFalse();
        expect(r.corners).toBeTrue();
        expect(r.reason).toContain('has-csd');
        expect(r.reason).toContain(`20.0x20.0 >= ${MUTTER_CSD_MIN_INSET_THRESHOLD}`);
    });

    it('oversized margin on a single axis (asymmetric) is not treated as a CSD shadow -> baseline decorates', () => {
        const r = inferDecorationBaseline(marginsFromRects(440, 300, 400, 300));
        expect(r.shadow).toBeTrue();
        expect(r.corners).toBeTrue();
        expect(r.reason).toContain('no-csd');
    });

    it('honours an explicit inset threshold', () => {
        const margins = marginsFromRects(410, 310, 400, 300); // single side 5px
        expect(inferDecorationBaseline({...margins, insetThreshold: 4}).reason).toContain('has-csd');
        expect(inferDecorationBaseline({...margins, insetThreshold: 8}).reason).toContain('no-csd');
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

    it('degenerate helper surface (wl-clipboard 1x1): no decoration', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            bufferWidth: 1, bufferHeight: 1, frameWidth: 1, frameHeight: 1,
        });
        expect(res.drawShadow).toBeFalse();
        expect(res.drawClip).toBeFalse();
        expect(res.reason).toBe('too-small(1x1)');
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

    it('X11 window with small frame extents (WeChat 4px resize grip): decorates with shadow and clip', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            isX11: true,
            wmClass: 'wechat',
            bufferWidth: 1156, bufferHeight: 852,
            frameWidth: 1148, frameHeight: 844,
        });
        expect(res.drawShadow).toBeTrue();
        expect(res.drawClip).toBeTrue();
        expect(res.reason).toContain('no-csd');
    });

    it('suppress rule naming both axes: both shadow and clip disabled', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            wmClass: 'overlay-app',
            rules: {suppress: {[buildRuleKey('overlay-app')]: 'shadow,corners'}},
        });
        expect(res.drawShadow).toBeFalse();
        expect(res.drawClip).toBeFalse();
        expect(res.reason).toContain('rule-applied');
    });

    it('suppress rule naming corners: retains shadow, disables clip', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            wmClass: 'wechat',
            rules: {suppress: {[buildRuleKey('wechat')]: 'corners'}},
        });
        expect(res.drawShadow).toBeTrue();
        expect(res.drawClip).toBeFalse();
        expect(res.reason).toContain('rule-applied');
    });

    it('suppress rule naming shadow: disables shadow, retains clip', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            wmClass: 'custom-tool',
            rules: {suppress: {[buildRuleKey('custom-tool')]: 'shadow'}},
        });
        expect(res.drawShadow).toBeFalse();
        expect(res.drawClip).toBeTrue();
        expect(res.reason).toContain('rule-applied');
    });

    it('suppression wins over a force rule for the same window kind', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            wmClass: 'wechat',
            rules: {
                suppress: {[buildRuleKey('wechat')]: 'corners'},
                force: {[buildRuleKey('wechat')]: 'shadow,corners'},
            },
        });
        expect(res.drawShadow).toBeTrue();
        expect(res.drawClip).toBeFalse();
        expect(res.reason).toBe('rule-applied(wechat:suppress:corners)');
    });

    it('CSD window (GTK4): keeps its own shadow and rounds the corners unless a rule says otherwise', () => {
        const win = {...baseWin, bufferWidth: 460, bufferHeight: 360, wmClass: 'gtk4-app'};
        const plain = evaluateWindowActions(win);
        expect(plain.drawShadow).toBeFalse();
        expect(plain.drawClip).toBeTrue();

        const suppressed = evaluateWindowActions({
            ...win,
            rules: {suppress: {[buildRuleKey('gtk4-app')]: 'corners'}},
        });
        expect(suppressed.drawShadow).toBeFalse();
        expect(suppressed.drawClip).toBeFalse();
    });

    it('CSD window (GTK4): the has-csd baseline reason surfaces when no rule matches', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            bufferWidth: 460, bufferHeight: 360, // single side 30px >= 8px
            wmClass: 'gtk4-app',
        });
        expect(res.drawShadow).toBeFalse();
        expect(res.drawClip).toBeTrue();
        expect(res.reason).toContain('has-csd');
    });

    it('force rule re-enables both axes on a has-csd baseline', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            bufferWidth: 460, bufferHeight: 360, // has-csd baseline: own shadow, corners ours
            wmClass: 'gtk4-app',
            rules: {force: {[buildRuleKey('gtk4-app')]: 'shadow,corners'}},
        });
        expect(res.drawShadow).toBeTrue();
        expect(res.drawClip).toBeTrue();
        expect(res.reason).toBe('rule-applied(gtk4-app:force:shadow,corners)');
    });

    it('force rule re-enables both axes on an x11-mutter-native-shadow baseline', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            isX11: true,
            wmClass: 'wps',
            rules: {force: {[buildRuleKey('wps', {clientType: 'x11'})]: 'shadow,corners'}},
        });
        expect(res.drawShadow).toBeTrue();
        expect(res.drawClip).toBeTrue();
        expect(res.reason).toContain('rule-applied');
    });

    it('per-axis force: corners on a has-csd baseline leaves the inferred actions alone', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            bufferWidth: 460, bufferHeight: 360, // has-csd baseline: own shadow, corners ours
            wmClass: 'gtk4-app',
            rules: {force: {[buildRuleKey('gtk4-app')]: 'corners'}},
        });
        expect(res.drawShadow).toBeFalse();
        expect(res.drawClip).toBeTrue();
        expect(res.reason).toBe('rule-applied(gtk4-app:force:corners)');
    });

    it('per-axis force: shadow turned ON while corners keeps the inferred baseline', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            bufferWidth: 460, bufferHeight: 360, // has-csd baseline: own shadow, corners ours
            wmClass: 'gtk4-app',
            rules: {force: {[buildRuleKey('gtk4-app')]: 'shadow'}},
        });
        expect(res.drawShadow).toBeTrue();
        expect(res.drawClip).toBeTrue();
        expect(res.reason).toBe('rule-applied(gtk4-app:force:shadow)');
    });

    it('per-axis suppress: corners turned OFF while shadow keeps the inferred baseline', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            isX11: true,
            wmClass: 'wps',
            rules: {suppress: {[buildRuleKey('wps', {clientType: 'x11'})]: 'corners'}},
        });
        expect(res.drawShadow).toBeFalse();
        expect(res.drawClip).toBeFalse();
        expect(res.reason).toBe('rule-applied(wps:suppress:corners)');
    });

    it('force rules cannot override structural ineligibility: maximized', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            isMaximized: true,
            wmClass: 'wechat',
            rules: {force: {[buildRuleKey('wechat')]: 'shadow,corners'}},
        });
        expect(res.drawShadow).toBeFalse();
        expect(res.drawClip).toBeFalse();
        expect(res.reason).toBe('maximized/fullscreen');
    });

    it('force rules cannot override structural ineligibility: fullscreen', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            isFullscreen: true,
            wmClass: 'wechat',
            rules: {force: {[buildRuleKey('wechat')]: 'shadow,corners'}},
        });
        expect(res.drawShadow).toBeFalse();
        expect(res.drawClip).toBeFalse();
        expect(res.reason).toBe('maximized/fullscreen');
    });

    it('force rules cannot override structural ineligibility: non-normal window type', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            windowType: WindowType.DOCK,
            wmClass: 'dock-app',
            rules: {force: {[buildRuleKey('dock-app', {windowType: WindowType.DOCK})]: 'shadow,corners'}},
        });
        expect(res.drawShadow).toBeFalse();
        expect(res.drawClip).toBeFalse();
        expect(res.reason).toBe(`window-type=${WindowType.DOCK}`);
    });

    it('user rules can suppress corners on SSD windows', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            hasSsd: true,
            wmClass: 'legacy-x11',
            rules: {suppress: {[buildRuleKey('legacy-x11')]: 'corners'}},
        });
        expect(res.drawShadow).toBeFalse();
        expect(res.drawClip).toBeFalse();
        expect(res.reason).toBe('rule-applied(legacy-x11:suppress:corners)');
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

    it('rule for one window kind leaves other kinds of the same app decorated', () => {
        const rules = {
            suppress: {
                [buildRuleKey('wechat', {hasParent: true, allowsResize: false})]: 'shadow,corners',
            },
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
            suppress: {
                [buildRuleKey('wechat', {clientType: 'wayland', hasParent: true, allowsResize: false})]: 'shadow,corners',
            },
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

    it('GNOME tiling alignment: hasTileMatch suppresses shadow to prevent adjacent window obstruction', () => {
        // Aligns with Mutter meta-window-actor-x11.c:392
        const snapTiledWin = evaluateWindowActions({
            ...baseWin,
            isMaximized: false,
            hasTileMatch: true,
        });
        expect(snapTiledWin.drawShadow).toBeFalse();
        expect(snapTiledWin.drawClip).toBeTrue();
        expect(snapTiledWin.reason).toContain('tile-match(suppress-shadow');
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

    it('handles null/undefined gracefully', () => {
        expect(isWindowTiled(null)).toBeFalse();
        expect(isWindowTiled(undefined)).toBeFalse();
    });
});

describe('pickedRuleWouldChange', () => {
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
    const propertiesFor = win => ({
        wmClass: win.wmClass,
        clientType: 'wayland',
        windowType: String(win.windowType),
        hasParent: 'false',
        allowsResize: 'true',
        isAttachedDialog: 'false',
    });

    it('reports no effect when forcing a decoration we already draw', () => {
        expect(pickedRuleWouldChange(propertiesFor(plainWindow), plainWindow, RuleDirection.FORCE)).toBeFalse();
    });

    it('reports an effect when forcing a decoration the client already draws', () => {
        expect(pickedRuleWouldChange(propertiesFor(csdWindow), csdWindow, RuleDirection.FORCE)).toBeTrue();
    });

    it('reports an effect when suppressing a decoration we draw', () => {
        expect(pickedRuleWouldChange(propertiesFor(plainWindow), plainWindow, RuleDirection.SUPPRESS)).toBeTrue();
    });

    it('reports an effect when suppressing the corners of a window that draws its own shadow', () => {
        expect(pickedRuleWouldChange(propertiesFor(csdWindow), csdWindow, RuleDirection.SUPPRESS)).toBeTrue();
    });

    it('reports no effect when suppressing a decoration we never draw', () => {
        const native = {...csdWindow, nativeLikeCorners: true};
        expect(pickedRuleWouldChange(propertiesFor(native), native, RuleDirection.SUPPRESS)).toBeFalse();
    });

    it('reports no effect either way for a window type we never decorate', () => {
        const menu = {...plainWindow, windowType: WindowType.MENU};

        expect(pickedRuleWouldChange(propertiesFor(menu), menu, RuleDirection.FORCE)).toBeFalse();
        expect(pickedRuleWouldChange(propertiesFor(menu), menu, RuleDirection.SUPPRESS)).toBeFalse();
    });

    it('judges the rule against the kind, not the state the window is in', () => {
        // A maximized window is never decorated, but the rule outlives the state.
        const maximized = {...plainWindow, isMaximized: true};
        expect(pickedRuleWouldChange(propertiesFor(maximized), maximized, RuleDirection.SUPPRESS)).toBeTrue();
    });

    it('preserves the hasSsd / nativeLikeCorners kind attributes while normalizing transient state', () => {
        // Maximized (transient) is normalized away, but hasSsd (kind) is kept:
        // suppressing corners on an SSD window still changes the outcome.
        const ssd = {...plainWindow, hasSsd: true, isMaximized: true, wmClass: 'xclock'};
        expect(pickedRuleWouldChange(propertiesFor(ssd), ssd, RuleDirection.SUPPRESS)).toBeTrue();
        // Corners that already look like ours are left alone, so suppressing them there
        // changes nothing - maximized or not.
        const nativeLike = {...csdWindow, nativeLikeCorners: true, isMaximized: true, wmClass: 'adw-app'};
        expect(pickedRuleWouldChange(propertiesFor(nativeLike), nativeLike, RuleDirection.SUPPRESS)).toBeFalse();
    });

    it('returns null when the window declares no identity', () => {
        const anonymous = {...plainWindow, wmClass: ''};
        expect(pickedRuleWouldChange(propertiesFor(anonymous), anonymous, RuleDirection.FORCE)).toBeNull();
    });

    it('keys the rule the way the runtime looks it up', () => {
        expect(buildRuleKeyFromProperties(propertiesFor(plainWindow))).toBe(buildRuleKey('plain-app'));
    });
});
