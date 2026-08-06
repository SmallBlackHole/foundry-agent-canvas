import { launchAgentTerminal } from "../agent-terminal.mjs";
import { ensureInspectorProxy, isAgentReachable } from "../inspector.mjs";
import { listHostedAgents, resolveHostedAgentProject } from "../local-agent.mjs";
import { selectedHostedAgentName } from "./hosted-agent-selection.mjs";
import { normalizeFailureCode } from "../telemetry/schema.mjs";
import { runTelemetryOperation } from "../telemetry/operations.mjs";

export function createInspectorServices({
    ctx,
    session,
    inspectorUiDir,
    workspaceRootFn,
    telemetry,
    now = Date.now,
    readinessMaxAttempts = 60,
    localInspector = {
        ensureProxy: ensureInspectorProxy,
        launchTerminal: launchAgentTerminal,
        listAgents: listHostedAgents,
        resolveProject: resolveHostedAgentProject,
    },
}) {
    const { instanceId, getEntry } = ctx;
    const isReady = localInspector.isReady || isAgentReachable;
    let readiness = null;

    return {
        async getInspectorReady() {
            const ready = await isReady();
            if (readiness) {
                readiness.attempts += 1;
                if (ready) {
                    telemetry?.recordOperation?.({
                        operation: "inspector_readiness",
                        outcome: "succeeded",
                        durationMs: Math.max(0, now() - readiness.startedAt),
                        source: "ui",
                        resourceKind: "agent",
                    });
                    readiness = null;
                } else if (readiness.attempts >= readinessMaxAttempts) {
                    telemetry?.recordOperation?.({
                        operation: "inspector_readiness",
                        outcome: "timed_out",
                        failureCode: "timeout",
                        durationMs: Math.max(0, now() - readiness.startedAt),
                        source: "ui",
                        resourceKind: "agent",
                    });
                    readiness = null;
                }
            }
            return { ready };
        },
        async startInspector() {
            const result = await runTelemetryOperation(telemetry, {
                operation: "inspector_startup",
                source: "ui",
                resourceKind: "agent",
                now,
                classify: (value) => value?.ok
                    ? { outcome: "succeeded" }
                    : {
                        outcome: "failed",
                        failureCode: normalizeFailureCode(value?.reason || "unavailable"),
                    },
            }, async () => {
                const root = await workspaceRootFn();
                const agents = await localInspector.listAgents(root);
                const agentName = selectedHostedAgentName(getEntry(), agents);
                const project = await localInspector.resolveProject(root, agentName);
                const proxyUrl = await localInspector.ensureProxy(inspectorUiDir);
                if (!proxyUrl) {
                    return {
                        ok: false,
                        reason: "unavailable",
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
                        reason: "unavailable",
                        error: terminal?.error || "Could not start the agent in the integrated terminal.",
                        terminal,
                    };
                }
                return { ok: true, url: proxyUrl, terminal };
            });
            if (result.ok) {
                readiness = { startedAt: now(), attempts: 0 };
            }
            return result;
        },
    };
}
