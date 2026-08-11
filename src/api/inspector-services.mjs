import { launchAgentTerminal } from "../hosted-agent/agent-terminal.mjs";
import { ensureInspectorProxy, isAgentReachable } from "../inspector/inspector.mjs";
import {
    listHostedAgents,
    resolveHostedAgentProject,
} from "../hosted-agent/local-agent.mjs";
import { selectedHostedAgentName } from "./hosted-agent-selection.mjs";
import {
    TELEMETRY_FAILURE_CODE,
    TELEMETRY_OPERATION,
    TELEMETRY_OUTCOME,
    TELEMETRY_RESOURCE_KIND,
    TELEMETRY_SOURCE,
} from "../../public/telemetry-constants.js";
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
                        operation: TELEMETRY_OPERATION.INSPECTOR_READINESS,
                        outcome: TELEMETRY_OUTCOME.SUCCEEDED,
                        durationMs: Math.max(0, now() - readiness.startedAt),
                        source: TELEMETRY_SOURCE.UI,
                        resourceKind: TELEMETRY_RESOURCE_KIND.AGENT,
                    });
                    readiness = null;
                } else if (readiness.attempts >= readinessMaxAttempts) {
                    telemetry?.recordOperation?.({
                        operation: TELEMETRY_OPERATION.INSPECTOR_READINESS,
                        outcome: TELEMETRY_OUTCOME.TIMED_OUT,
                        failureCode: TELEMETRY_FAILURE_CODE.TIMEOUT,
                        durationMs: Math.max(0, now() - readiness.startedAt),
                        source: TELEMETRY_SOURCE.UI,
                        resourceKind: TELEMETRY_RESOURCE_KIND.AGENT,
                    });
                    readiness = null;
                }
            }
            return { ready };
        },
        async startInspector() {
            const result = await runTelemetryOperation(telemetry, {
                operation: TELEMETRY_OPERATION.INSPECTOR_STARTUP,
                source: TELEMETRY_SOURCE.UI,
                resourceKind: TELEMETRY_RESOURCE_KIND.AGENT,
                now,
                classify: (value) => value?.ok
                    ? { outcome: TELEMETRY_OUTCOME.SUCCEEDED }
                    : {
                        outcome: TELEMETRY_OUTCOME.FAILED,
                        failureCode: normalizeFailureCode(
                            value?.reason || TELEMETRY_FAILURE_CODE.UNAVAILABLE,
                        ),
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
