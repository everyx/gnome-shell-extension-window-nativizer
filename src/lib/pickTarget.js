/** Plain data, so it is testable without GI: the topmost candidate whose frame holds the point. */

/** Candidates run bottom-to-top, so the scan goes backwards; nulls are actors that went away. */
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
