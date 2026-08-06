import { initialBuildSections } from "../build-sections.mjs";
import {
    discoverHostedAgentWorkspace,
    listHostedAgents,
} from "../hosted-agent/local-agent.mjs";
import {
    agentSummaries,
    selectedHostedAgentName,
    selectedHostedAgentPortalAction,
} from "./hosted-agent-selection.mjs";

export function createHostedAgentServices({
    ctx,
    workspaceRootFn,
    listAgents = listHostedAgents,
    createAgentOperations,
}) {
    const { getEntry } = ctx;
    let lastAgentNames = new Set();

    return {
        getHostedAgentDeployment() {
            return selectedHostedAgentPortalAction(getEntry(), workspaceRootFn);
        },
        // Powers the "Deploy & test" agent picker. The canvas only shows the
        // picker for workspaces with more than one hosted agent.
        async listHostedAgents() {
            const agents = await listAgents(await workspaceRootFn());
            lastAgentNames = new Set(agents.map((agent) => agent.agentName.toLowerCase()));
            return {
                ok: true,
                selected: selectedHostedAgentName(getEntry(), agents),
                agents: agentSummaries(agents),
            };
        },
        async selectHostedAgent({ body }) {
            const agentName = String(body?.agentName || "").trim();
            const entry = getEntry();
            if (entry) entry.state.agentName = agentName;
            if (body?.created === true) {
                const detected = lastAgentNames.has(agentName.toLowerCase());
                createAgentOperations?.finish?.(
                    ctx.instanceId,
                    detected ? "succeeded" : "failed",
                    detected ? undefined : "no_agent",
                );
            }
            return { ok: true, selected: agentName };
        },
        // The router turns an available action into a 302, so a portal URL from
        // anywhere but the Foundry portal is reported as unavailable instead.
        async getHostedAgentPlayground() {
            const result = await selectedHostedAgentPortalAction(getEntry(), workspaceRootFn);
            return result.available && result.portalUrl.startsWith("https://ai.azure.com/")
                ? result
                : { ...result, available: false, portalUrl: "" };
        },
        async getProjectInit() {
            const root = await workspaceRootFn();
            const { hasAzure, hasAgent, agents } = await discoverHostedAgentWorkspace(root);
            return {
                ok: true,
                hasAzure,
                hasAgent,
                initialized: hasAzure || hasAgent,
                sections: initialBuildSections({ hasAgent }),
                selected: selectedHostedAgentName(getEntry(), agents),
                agents: agentSummaries(agents),
            };
        },
    };
}
