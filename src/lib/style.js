import {ADWAITA_STYLE} from './adwaitaStyle.generated.js';

/**
 * @param {object} winState - Focused/maximized/fullscreen/tiled/highContrast/animationsEnabled/dark
 * @returns {{radius: number, shadows: Array<object>, animate: boolean, outline: object|null, border?: boolean}}
 */
export function styleForWindow(winState) {
    const {window} = ADWAITA_STYLE;
    const outline = winState.highContrast
        ? window.outline.highContrast : window.outline.normal;

    // Upstream has no shadows or outline when flush with the screen edge.
    if (winState.fullscreen)
        return {...window.fullscreen, outline: null};
    if (winState.maximized)
        return {...window.maximized, outline: null};
    if (winState.tiled) {
        // Tiled border approximates upstream currentColor mix using system color scheme.
        const color = winState.dark ? [255, 255, 255] : [0, 0, 0];
        return {
            ...window.tiled,
            outline: null,
            shadows: window.tiled.shadows.map(layer => ({...layer, color})),
        };
    }

    // Upstream transitions on unfocus only (backdrop); gated by system animation setting.
    const base = winState.focused ? window : window.backdrop;
    const style = {
        radius: base.radius,
        shadows: base.shadows,
        animate: base.animate && winState.animationsEnabled !== false,
    };
    if (winState.highContrast) {
        style.shadows = winState.focused
            ? window.highContrast.shadows
            : window.highContrast.backdropShadows;
    }
    style.outline = outline;
    return style;
}

/**
 * @param {number} base - Base style transition weight (0..1)
 * @param {number} paintOpacity - Normalized actor paint opacity (0..1)
 * @returns {number} Modulated pipeline opacity in [0, 1]
 */
export function pipelineOpacityFor(base, paintOpacity) {
    if (paintOpacity <= 0)
        return 0;
    const clampedBase = Math.max(0, Math.min(1, base));
    const clampedPaint = Math.min(1, paintOpacity);
    return clampedBase * clampedPaint;
}
