import { initialBuildSections } from "./build-sections.mjs";
import { inspectHostedAgentWorkspace } from "./local-agent.mjs";
import { pushFrame } from "./server-utils.mjs";

export const WORKSPACE_STATE_FRAME_TYPE = "workspaceState";

export function flushPendingWorkspaceState(entry, client) {
    const frame = entry?.pendingWorkspaceStateFrame;
    if (!frame) return false;
    try {
        client.write(`data: ${JSON.stringify(frame)}\n\n`);
        entry.pendingWorkspaceStateFrame = null;
        return true;
    } catch {
        return false;
    }
}

export async function refreshWorkspaceState(
    entry,
    workspaceRootFn,
    { inspectWorkspace = inspectHostedAgentWorkspace, push = pushFrame } = {},
) {
    const root = await workspaceRootFn();
    const info = await inspectWorkspace(root);
    const sections = initialBuildSections(info);
    let transitioned = false;

    if (info.hasAgent && !entry.workspaceStateTransitioned) {
        entry.workspaceStateTransitioned = true;
        const frame = {
            type: WORKSPACE_STATE_FRAME_TYPE,
            hasAgent: true,
            sections,
        };
        if (!entry.sseClients?.size || push(entry, frame) === 0) {
            entry.pendingWorkspaceStateFrame = frame;
        }
        transitioned = true;
    }

    return {
        hasAzure: info.hasAzure,
        hasAgent: info.hasAgent,
        initialized: info.hasAzure || info.hasAgent,
        manifestPath: info.manifestPath || "",
        sections,
        transitioned,
    };
}
