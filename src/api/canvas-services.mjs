import { DEPLOY_PROMPT } from "../catalog.mjs";
import { checkPluginUpdate } from "../plugin-update.mjs";
import { bootstrapInstance, defaultState } from "../state.mjs";
import { normalizeFailureCode } from "../telemetry/schema.mjs";

export function createCanvasServices({
    ctx,
    session,
    extensionDir,
    waitForFoundrySkill,
    markPendingRefresh,
    clearPendingRefresh,
    pluginVersion = "",
    telemetry,
    createAgentOperations,
    deploymentOperations,
    now = Date.now,
    pluginUpdate = {
        check: checkPluginUpdate,
    },
}) {
    const { getEntry } = ctx;

    return {
        async getState() {
            return {
                ...(getEntry()?.state ?? defaultState()),
                deployPrompt: DEPLOY_PROMPT,
                pluginVersion,
            };
        },
        async bootstrap() {
            const entry = getEntry();
            if (!entry) return { ok: false, reason: "no_instance" };
            try {
                return { ok: true, ...(await bootstrapInstance(entry)) };
            } catch (error) {
                await session.log(`bootstrap failed: ${error?.message ?? error}`, { level: "error" });
                return { ok: false, reason: "bootstrap_failed" };
            }
        },
        // The refresh marker has to be registered before the prompt is sent so
        // the deployment re-check is already pending when the agent goes idle.
        async sendPrompt({ body }) {
            const startedAt = now();
            const refresh = typeof body.refresh === "string" ? body.refresh : "";
            if (typeof body.refresh === "string" && body.refresh) {
                markPendingRefresh?.(body.refresh);
            }
            if (refresh === "deployment") deploymentOperations?.start?.(ctx.instanceId);
            try {
                await waitForFoundrySkill?.();
                await session.send({ prompt: body.prompt });
                telemetry?.recordOperation?.({
                    operation: "prompt_delivery",
                    outcome: "accepted",
                    durationMs: Math.max(0, now() - startedAt),
                    source: "ui",
                    ...(body.resourceKind ? { resourceKind: body.resourceKind } : {}),
                });
                if (body.resourceKind === "agent" && !refresh) {
                    createAgentOperations?.start?.(ctx.instanceId);
                }
                return {};
            } catch (error) {
                if (refresh) clearPendingRefresh?.(refresh);
                if (refresh === "deployment") {
                    deploymentOperations?.finish?.(
                        ctx.instanceId,
                        "failed",
                        "prompt_not_accepted",
                    );
                }
                telemetry?.recordOperation?.({
                    operation: "prompt_delivery",
                    outcome: "failed",
                    failureCode: normalizeFailureCode(error),
                    durationMs: Math.max(0, now() - startedAt),
                    source: "ui",
                    ...(body.resourceKind ? { resourceKind: body.resourceKind } : {}),
                });
                throw error;
            }
        },
        async getPluginUpdate({ url }) {
            return pluginUpdate.check({
                extensionDir,
                force: url.searchParams.get("refresh") === "1",
            });
        },
    };
}
