import { deployments } from "../foundry/catalog.mjs";
import {
    listDeployments,
    listGuardrails,
    listSkills,
    listToolboxes,
    listToolboxTools,
} from "../foundry/foundry.mjs";
import {
    enrichDeployment,
    enrichGuardrail,
    enrichSkill,
    enrichToolbox,
} from "../foundry/mappers.mjs";
import { normalizeFailureCode } from "../telemetry/schema.mjs";

function liveItems(result, mapItem) {
    if (result.ok) return { ok: true, items: result.data.map(mapItem) };
    return { ok: false, reason: result.reason, items: [] };
}

const forced = (url) => ({ force: url.searchParams.get("refresh") === "1" });

export function createResourceServices({ ctx, telemetry, now = Date.now }) {
    const { getSelection, getEndpoint } = ctx;

    async function load(resourceKind, run, mapResult) {
        const startedAt = now();
        try {
            const result = await run();
            const response = mapResult(result);
            telemetry?.recordOperation?.({
                operation: "load_resources",
                outcome: result.ok ? "succeeded" : "failed",
                ...(result.ok
                    ? {}
                    : { failureCode: normalizeFailureCode(result.reason) }),
                durationMs: Math.max(0, now() - startedAt),
                source: "ui",
                resourceKind,
            });
            return response;
        } catch (error) {
            telemetry?.recordOperation?.({
                operation: "load_resources",
                outcome: "failed",
                failureCode: normalizeFailureCode(error),
                durationMs: Math.max(0, now() - startedAt),
                source: "ui",
                resourceKind,
            });
            throw error;
        }
    }

    return {
        // Deployments are the one resource with a mock fallback: the canvas
        // always shows a model list so the build flow stays explorable before
        // sign-in or when the project read fails.
        async listDeployments({ url }) {
            return load(
                "model",
                () => listDeployments(getEndpoint(), forced(url)),
                (result) => result.ok
                    ? {
                        ok: true,
                        source: "live",
                        items: result.data.map(enrichDeployment),
                    }
                    : {
                        ok: true,
                        source: "mock",
                        reason: result.reason,
                        items: deployments,
                    },
            );
        },
        async listToolboxes({ url }) {
            return load(
                "toolbox",
                () => listToolboxes(getEndpoint(), forced(url)),
                (result) => liveItems(result, enrichToolbox),
            );
        },
        async listSkills({ url }) {
            return load(
                "project_skill",
                () => listSkills(getEndpoint(), forced(url)),
                (result) => liveItems(result, enrichSkill),
            );
        },
        async listGuardrails({ url }) {
            return load(
                "guardrail",
                () => listGuardrails(
                    getEndpoint(),
                    getSelection().subscription.id,
                    forced(url),
                ),
                (result) => liveItems(result, enrichGuardrail),
            );
        },
        async listToolboxTools({ url }) {
            return load(
                "toolbox",
                () => listToolboxTools(
                    getEndpoint(),
                    url.searchParams.get("name") || "",
                    url.searchParams.get("version") || "",
                ),
                (result) => result.ok
                    ? { ok: true, items: result.data }
                    : { ok: false, reason: result.reason, items: [] },
            );
        },
    };
}
