export function initialBuildSections(info = {}) {
    const hasWorkspaceAgent =
        info.hasAgent === true ||
        info.agentType === "hosted" ||
        info.agentType === "managed";
    return {
        initOpen: !hasWorkspaceAgent,
        resourcesOpen: hasWorkspaceAgent,
        deployOpen: hasWorkspaceAgent,
    };
}
