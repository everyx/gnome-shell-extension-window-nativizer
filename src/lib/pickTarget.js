/**
 * The window picker's hit test as a pure decision.
 *
 * The picker walks the live MetaWindowActor list, resolves workspaces through platform
 * adapters and reads Meta.Window properties - all GI. The rule that turns those readings
 * into a window is plain data: topmost first, skip unmapped/minimized/hidden/other-workspace/
 * non-decoratable candidates, and take the first whose frame rect contains the point. It
 * lived inside InspectorService, where the only way to exercise it was the D-Bus e2e.
 */

/**
 * @typedef {object} PickCandidate
 * @property {object|null} window - The Meta.Window to return if this candidate matches
 * @property {boolean} minimized
 * @property {boolean} hidden
 * @property {boolean} mapped - False only when the actor declares itself unmapped
 * @property {boolean} onAllWorkspaces
 * @property {boolean} onWorkspace - Located on the active workspace
 * @property {boolean} decoratable
 * @property {{x:number,y:number,width:number,height:number}|null} frame - Frame rect in stage coords
 */

/**
 * Picks the topmost window whose frame rect contains the point.
 *
 * Candidates are ordered bottom-to-top, so the scan runs backwards. Null entries stand for
 * actors that went away while the list was being read and are skipped.
 *
 * @param {Array<PickCandidate|null>} candidates
 * @param {object|null} activeWorkspace - Truthy when a workspace is current
 * @param {number} stageX
 * @param {number} stageY
 * @returns {object|null} The window, or null when no candidate matches
 */
export function pickTarget(candidates, activeWorkspace, stageX, stageY) {
    for (let i = candidates.length - 1; i >= 0; i--) {
        const candidate = candidates[i];
        if (!candidate)
            continue;
        if (!candidate.window || candidate.minimized || candidate.hidden)
            continue;
        if (!candidate.mapped)
            continue;
        if (activeWorkspace && !candidate.onAllWorkspaces && !candidate.onWorkspace)
            continue;
        if (!candidate.decoratable)
            continue;

        const frame = candidate.frame;
        if (frame && stageX >= frame.x && stageX < frame.x + frame.width &&
            stageY >= frame.y && stageY < frame.y + frame.height)
            return candidate.window;
    }
    return null;
}
