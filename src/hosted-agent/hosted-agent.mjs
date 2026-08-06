const AGENT_API_VERSION = "v1";
const HOSTED_AGENT_FEATURE = "HostedAgents=V1Preview";
const NOT_DEPLOYED_STATUSES = new Set([
    "building",
    "canceled",
    "cancelled",
    "creating",
    "deleted",
    "deleting",
    "failed",
    "pending",
    "provisioning",
    "updating",
]);

function clean(value) {
    return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function reasonForResponse(status) {
    if (status === 401 || status === 403) return "unauthorized";
    if (status === 404) return "not_found";
    return "fetch_failed";
}

function deploymentFromAgent(agent, requestedName) {
    const latest = agent?.versions?.latest || null;
    const definition = latest?.definition || agent?.definition || null;
    const kind = clean(definition?.kind).toLowerCase();
    const name = clean(agent?.name) || clean(requestedName);
    const version = clean(latest?.version ?? agent?.version);
    const status = clean(latest?.status ?? agent?.status).toLowerCase();

    if (kind !== "hosted") {
        return {
            ok: true,
            deployed: false,
            reason: kind ? "not_hosted" : "unknown_kind",
            agentName: name,
            version: "",
        };
    }
    if (!name || !version) {
        return { ok: true, deployed: false, reason: "not_deployed", agentName: name, version: "" };
    }
    if (status && NOT_DEPLOYED_STATUSES.has(status)) {
        return { ok: true, deployed: false, reason: status, agentName: name, version };
    }
    return { ok: true, deployed: true, reason: "", agentName: name, version };
}

// Query the selected project's live agent resource. This intentionally bypasses
// the shared 30-second resource cache so deployment state is never reused.
export async function inspectHostedAgentDeployment(
    endpoint,
    agentName,
    { getToken, fetchImpl = globalThis.fetch } = {},
) {
    const projectEndpoint = clean(endpoint).replace(/\/+$/, "");
    const requestedName = clean(agentName);
    if (!projectEndpoint) return { ok: false, deployed: false, reason: "no_project", agentName: requestedName, version: "" };
    if (!requestedName) return { ok: false, deployed: false, reason: "no_agent", agentName: "", version: "" };
    if (typeof getToken !== "function" || typeof fetchImpl !== "function") {
        return { ok: false, deployed: false, reason: "unavailable", agentName: requestedName, version: "" };
    }

    try {
        const token = await getToken();
        const url = `${projectEndpoint}/agents/${encodeURIComponent(requestedName)}?api-version=${AGENT_API_VERSION}`;
        const res = await fetchImpl(url, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/json",
                "Foundry-Features": HOSTED_AGENT_FEATURE,
            },
        });
        if (res.status === 404) {
            return { ok: true, deployed: false, reason: "not_found", agentName: requestedName, version: "" };
        }
        if (!res.ok) {
            return {
                ok: false,
                deployed: false,
                reason: reasonForResponse(res.status),
                agentName: requestedName,
                version: "",
            };
        }
        return deploymentFromAgent(await res.json(), requestedName);
    } catch (err) {
        return {
            ok: false,
            deployed: false,
            reason: err?.message === "not_signed_in" ? "not_signed_in" : "fetch_failed",
            agentName: requestedName,
            version: "",
        };
    }
}

function encodedSubscriptionId(subscriptionId) {
    const hex = clean(subscriptionId).replace(/-/g, "");
    if (!/^[0-9a-f]{32}$/i.test(hex)) return "";
    return Buffer.from(hex, "hex").toString("base64url");
}

export function buildHostedAgentPortalUrl({
    subscriptionId,
    resourceGroup,
    accountName,
    projectName,
    agentName,
    version,
}) {
    const encodedSub = encodedSubscriptionId(subscriptionId);
    const parts = [resourceGroup, accountName, projectName, agentName, version].map(clean);
    if (!encodedSub || parts.some((part) => !part)) return "";
    const [rg, account, project, agent, agentVersion] = parts.map(encodeURIComponent);
    return (
        `https://ai.azure.com/nextgen/r/${encodedSub},${rg},,${account},${project}` +
        `/build/agents/${agent}/build?version=${agentVersion}`
    );
}

export async function resolveHostedAgentPortalAction(metadata, deps) {
    const deployment = await inspectHostedAgentDeployment(metadata?.endpoint, metadata?.agentName, deps);
    if (!deployment.ok || !deployment.deployed) return { ...deployment, available: false, portalUrl: "" };

    const portalUrl = buildHostedAgentPortalUrl({
        subscriptionId: metadata?.subscriptionId,
        resourceGroup: metadata?.resourceGroup,
        accountName: metadata?.accountName,
        projectName: metadata?.projectName,
        agentName: deployment.agentName,
        version: deployment.version,
    });
    return { ...deployment, available: !!portalUrl, portalUrl };
}
