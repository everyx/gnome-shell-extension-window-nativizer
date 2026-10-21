/** The picker's own geometry: border width, outlined box, concentric corner, expected radius. */

import {ADWAITA_STYLE} from './adwaitaStyle.generated.js';
import {HIGHLIGHT_BORDER_WIDTH} from './inspectorStyle.generated.js';

// Picker highlight metrics match upstream Looking Glass (2px border) and screenshot selector fill.
export {HIGHLIGHT_BORDER_WIDTH};

/** Expected corner radius; maximized, tiled, fullscreen, unclipped non-Adwaita/SSD are square. */
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

/** Outset box for the border: St draws borders inward, which would erode client content. */
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

/** Concentric outer arc for an outset border; a square window stays 0. */
export function highlightOuterRadius(innerRadius, borderWidth = HIGHLIGHT_BORDER_WIDTH) {
    return innerRadius > 0 ? innerRadius + borderWidth : 0;
}
