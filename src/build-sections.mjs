export function initialBuildSections(info = {}) {
    const hasHostedAgent = info.hasAgent === true;
    return {
        initOpen: !hasHostedAgent,
        resourcesOpen: hasHostedAgent,
        deployOpen: hasHostedAgent,
    };
}
