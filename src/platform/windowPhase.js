/** The subpixel-phase mirror of Mutter's surface transform; `check-upstream-mirrors` pins it. */

import {WindowClientType} from '../lib/mutterRules.generated.js';
import {INTEGRAL_EPSILON, roundHalfAwayFromZero} from './numeric.js';
import {getSurfaceContainer} from './surfaceContainer.js';
import {monitorGeometryAt, monitorScaleAt, resolveFrameMonitorIndex} from './monitor.js';
import {getWindowActor, getWindowClientType} from './window.js';

/** Mirror of Mutter's subpixel phase: `roundf` snaps away from zero, `Math.round` does not. */
export function getWindowSubpixelOffset(win, St = null, container = null) {
    if (!win)
        return {x: 0, y: 0};

    try {
        if (getWindowClientType(win) !== WindowClientType.WAYLAND)
            return {x: 0, y: 0};

        const actor = getWindowActor(win);
        if (!actor)
            return {x: 0, y: 0};

        const monitorIndex = resolveFrameMonitorIndex(win);
        // null is "no reading", not -1's "no overlap": the caller then keeps its last good phase.
        if (monitorIndex === null)
            return null;
        if (monitorIndex < 0)
            return {x: 0, y: 0};

        const scale = monitorScaleAt(monitorIndex);
        if (scale === null)
            return null;
        if (!(scale > 0) || !Number.isFinite(scale) || Math.abs(scale - Math.round(scale)) < INTEGRAL_EPSILON)
            return {x: 0, y: 0};

        const geom = monitorGeometryAt(monitorIndex);
        const monitorX = geom?.x ?? 0;
        const monitorY = geom?.y ?? 0;

        // Layout coords only: actor plus container position, resolved with the same St as the clip.
        const surfaceContainer = container ?? getSurfaceContainer(actor, win, St);
        const absX = (actor.x ?? 0) + (surfaceContainer?.x ?? 0);
        const absY = (actor.y ?? 0) + (surfaceContainer?.y ?? 0);
        const relX = absX - monitorX;
        const relY = absY - monitorY;

        const adjRelX = roundHalfAwayFromZero(relX * scale) / scale;
        const adjRelY = roundHalfAwayFromZero(relY * scale) / scale;

        return {
            x: adjRelX - relX,
            y: adjRelY - relY,
        };
    } catch {
        return null;
    }
}

/** The phase Mutter actually applied, read from the container's transform; beats the mirror. */
export function getAppliedSubpixelPhase(win, St = null, container = null) {
    try {
        if (!win || getWindowClientType(win) !== WindowClientType.WAYLAND)
            return null;

        const actor = getWindowActor(win);
        if (!actor)
            return null;

        // The same St the clip uses, so transform and subtracted origin name one actor, never two.
        const surfaceContainer = container ?? getSurfaceContainer(actor, win, St);
        if (!surfaceContainer || typeof surfaceContainer.get_transform !== 'function')
            return null;

        const matrix = surfaceContainer.get_transform();
        if (!matrix ||
            typeof matrix.get_x_translation !== 'function' ||
            typeof matrix.get_y_translation !== 'function')
            return null;

        // `geometry_scale` is the only writer, so a non-unit scale means the translation has it.
        const scaleX = typeof matrix.get_x_scale === 'function' ? matrix.get_x_scale() : 1;
        const scaleY = typeof matrix.get_y_scale === 'function' ? matrix.get_y_scale() : 1;
        if (Math.abs(scaleX - 1) > INTEGRAL_EPSILON || Math.abs(scaleY - 1) > INTEGRAL_EPSILON)
            return null;

        const x = matrix.get_x_translation() -
            ((surfaceContainer.x ?? 0) + (surfaceContainer.translation_x ?? 0));
        const y = matrix.get_y_translation() -
            ((surfaceContainer.y ?? 0) + (surfaceContainer.translation_y ?? 0));
        // A torn-down container hands back NaN, and assigning that to a translation is a critical.
        if (!Number.isFinite(x) || !Number.isFinite(y))
            return null;

        return {x, y};
    } catch {
        return null;
    }
}
