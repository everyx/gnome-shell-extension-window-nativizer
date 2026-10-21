// Seam module: tools/gjs-surface.js imports it to assert every seam export is callable.

export {
    isWindowMaximized,
    isWindowFullscreen,
    isWindowTiled,
    getWindowFrameRect,
    getWindowBufferRect,
    getWindowActor,
    getWindowClientType,
    getWindowType,
    getWindowPid,
    getWindowTransientFor,
    isWindowAttachedDialog,
    isWindowAllowsResize,
    isWindowHidden,
    isWindowOnAllWorkspaces,
    isWindowLocatedOnWorkspace,
    getWindowDisplayTitle,
    isWindowMinimized,
    isWindowDecorated,
    isWindowMaximizedHorizontally,
    isWindowMaximizedVertically,
    isWindowAppearsFocused,
    getWindowTileMatch,
    getWindowFromActor,
    findMetaWindow,
    findMetaWindowCached,
    getWindowSubpixelOffset,
    getAppliedSubpixelPhase,
    invalidateMonitorCache
} from './window.js';

export {
    getDisplay,
    getFocusWindow,
    getWindowGroup,
    getMonitorManager,
    getMonitorCount,
    getMonitorScale,
    getMonitorGeometry,
    getPhysicalMonitorScale,
    resolveMonitorBounds,
    getTabList,
    focusWindow,
    setActorAboveSibling,
    setActorBelowSibling,
    getWindowActors,
    getActiveWorkspaceIndex,
    getActiveWorkspace,
    getStage,
    getStageDimensions
} from './display.js';

export {ShaderEffect} from './shaderEffect.js';
export {beginWindowGrabOp, getPointerSprite, getResizeGrabOp} from './grabOp.js';
export {CursorShape, setActorCursor, cursorTypeFor} from './actorCursor.js';
export {coglContextForBake} from './coglContext.js';
export {resolveUniformLocation} from './uniformLocation.js';
