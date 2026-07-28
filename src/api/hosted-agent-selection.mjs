import { emptySelection } from "../../public/selection-state.js";
import { getToken } from "../foundry-auth.mjs";
import { resolveHostedAgentPortalAction } from "../hosted-agent.mjs";
import { resolveHostedAgentName } from "../local-agent.mjs";

// Resolves the portal action for the hosted agent the deploy/test actions
// target. Used by the API surface and by extension.mjs for deployment-state
// refreshes, so it stays free of any service-group wiring.
export async function selectedHostedAgentPortalAction(entry, workspaceRootFn) {
    const selection = entry?.state.selection ?? emptySelection();
    const project = selection.project;
    const agent = await resolveHostedAgentName(
        await workspaceRootFn(),
        entry ? entry.state.agentName : "",
    );
    return resolveHostedAgentPortalAction(
        {
            endpoint: project?.endpoint || "",
            agentName: agent.agentName,
            subscriptionId: selection.subscription.id,
            resourceGroup: project?.resourceGroup || "",
            accountName: project?.accountName || "",
            projectName: project?.name || "",
        },
        { getToken },
    );
}

// The hosted agent the deploy/test actions target: the user's explicit pick when
// it is still present in the workspace, otherwise the first agent found. An
// explicit pick that no longer matches any workspace agent is kept as-is because
// it can come from the canvas open input.
export function selectedHostedAgentName(entry, agents) {
    const explicit = String(entry?.state.agentName || "").trim();
    if (!explicit) return agents[0]?.agentName || "";
    const match = agents.find(
        (agent) => agent.agentName.toLowerCase() === explicit.toLowerCase(),
    );
    return match ? match.agentName : explicit;
}

export function agentSummaries(agents) {
    return agents.map(({ agentName, manifestPath, projectDir }) => ({
        agentName,
        manifestPath,
        projectDir,
    }));
}
