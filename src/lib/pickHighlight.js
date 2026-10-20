/**
 * The picker's own geometry: how much room the highlight border takes, the box it outlines, the
 * concentric corner it draws, and the radius the highlighted window is expected to show.
 */

import {ADWAITA_STYLE} from './adwaitaStyle.generated.js';
import {HIGHLIGHT_BORDER_WIDTH} from './inspectorStyle.generated.js';

// Picker highlight metrics match upstream Looking Glass (2px border) and screenshot selector fill.
export {HIGHLIGHT_BORDER_WIDTH};

/**
 * Expected visual corner radius for an inspected window.
 * Maximized, tiled, fullscreen, and unclipped non-Adwaita/SSD windows have square (0px) corners.
 *
 * @returns Visual corner radius in pixels (0 for square corners)
 */
export function expectedWindowRadius({
    isFullscreen = false,
    isMaximized = false,
    isTiled = false,
    isActivelyClipped = false,
    hasNativeLikeCorners = false,
    hasSsd = false,
    baseRadius = ADWAITA_STYLE.window.radius,
} = {}) {
    if (isFullscreen || isMaximized || isTiled)
        return 0;

    if (isActivelyClipped)
        return baseRadius;

    if (!hasSsd && hasNativeLikeCorners)
        return baseRadius;

    return 0;
}

/**
 * Outset bounding box for the inspector highlight border around the window.
 * Outsetting prevents St CSS inward border drawing from eroding into the client window content.
 *
 */
export function highlightBoundingBox(frame, borderWidth = HIGHLIGHT_BORDER_WIDTH) {
    if (!frame)
        return {x: 0, y: 0, width: 0, height: 0};
    return {
        x: frame.x - borderWidth,
        y: frame.y - borderWidth,
        width: Math.max(0, frame.width + borderWidth * 2),
        height: Math.max(0, frame.height + borderWidth * 2),
    };
}

/**
 * Concentric outer arc for an outset border; square windows stay 0px.
 *
 */
export function highlightOuterRadius(innerRadius, borderWidth = HIGHLIGHT_BORDER_WIDTH) {
    return innerRadius > 0 ? innerRadius + borderWidth : 0;
}
