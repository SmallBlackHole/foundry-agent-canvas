import { launchAgentTerminal } from "../agent-terminal.mjs";
import { ensureInspectorProxy, isAgentReachable } from "../inspector.mjs";
import { listHostedAgents, resolveHostedAgentProject } from "../local-agent.mjs";
import { selectedHostedAgentName } from "./hosted-agent-selection.mjs";

export function createInspectorServices({
    ctx,
    session,
    inspectorUiDir,
    workspaceRootFn,
    localInspector = {
        ensureProxy: ensureInspectorProxy,
        launchTerminal: launchAgentTerminal,
        listAgents: listHostedAgents,
        resolveProject: resolveHostedAgentProject,
    },
}) {
    const { instanceId, getEntry } = ctx;

    return {
        async getInspectorReady() {
            return { ready: await isAgentReachable() };
        },
        async startInspector() {
            const root = await workspaceRootFn();
            const agents = await localInspector.listAgents(root);
            const agentName = selectedHostedAgentName(getEntry(), agents);
            const project = await localInspector.resolveProject(root, agentName);
            const proxyUrl = await localInspector.ensureProxy(inspectorUiDir);
            if (!proxyUrl) {
                return {
                    ok: false,
                    error: "Inspector failed to start. Check the extension logs for details.",
                };
            }
            // Starting the agent has to focus the terminal panel, so the launcher
            // needs this canvas instance to hand focus back afterwards.
            const terminal = await localInspector.launchTerminal(session, project, {
                builderInstanceId: instanceId,
            });
            if (!terminal?.ok) {
                return {
                    ok: false,
                    error: terminal?.error || "Could not start the agent in the integrated terminal.",
                    terminal,
                };
            }
            return { ok: true, url: proxyUrl, terminal };
        },
    };
}
