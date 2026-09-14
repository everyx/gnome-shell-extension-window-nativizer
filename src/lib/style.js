// Tracks libadwaita's window.csd — see docs/decoration-model.md.

import {ADWAITA_STYLE} from './adwaitaStyle.generated.js';

/**
 * @param {object} winState - Focused/maximized/fullscreen/tiled/highContrast
 * @returns {{radius: number, shadows: Array<object>, outline: object|null}}
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
    if (winState.tiled)
        return {...window.tiled, outline: null};

    const base = winState.focused ? window : window.backdrop;
    const style = {radius: base.radius, shadows: base.shadows};
    if (winState.highContrast) {
        style.shadows = winState.focused
            ? window.highContrast.shadows
            : window.highContrast.backdropShadows;
    }
    style.outline = outline;
    return style;
}
