import { deployments } from "../catalog.mjs";
import {
    listDeployments,
    listGuardrails,
    listSkills,
    listToolboxes,
    listToolboxTools,
} from "../foundry.mjs";
import { enrichDeployment, enrichGuardrail, enrichSkill, enrichToolbox } from "../mappers.mjs";

function liveItems(result, mapItem) {
    if (result.ok) return { ok: true, items: result.data.map(mapItem) };
    return { ok: false, reason: result.reason, items: [] };
}

const forced = (url) => ({ force: url.searchParams.get("refresh") === "1" });

export function createResourceServices({ ctx }) {
    const { getSelection, getEndpoint } = ctx;

    return {
        // Deployments are the one resource with a mock fallback: the canvas
        // always shows a model list so the build flow stays explorable before
        // sign-in or when the project read fails.
        async listDeployments({ url }) {
            const result = await listDeployments(getEndpoint(), forced(url));
            if (result.ok) {
                return {
                    ok: true,
                    source: "live",
                    items: result.data.map(enrichDeployment),
                };
            }
            return {
                ok: true,
                source: "mock",
                reason: result.reason,
                items: deployments,
            };
        },
        async listToolboxes({ url }) {
            return liveItems(await listToolboxes(getEndpoint(), forced(url)), enrichToolbox);
        },
        async listSkills({ url }) {
            return liveItems(await listSkills(getEndpoint(), forced(url)), enrichSkill);
        },
        async listGuardrails({ url }) {
            return liveItems(
                await listGuardrails(getEndpoint(), getSelection().subscription.id, forced(url)),
                enrichGuardrail,
            );
        },
        async listToolboxTools({ url }) {
            const result = await listToolboxTools(
                getEndpoint(),
                url.searchParams.get("name") || "",
                url.searchParams.get("version") || "",
            );
            return result.ok
                ? { ok: true, items: result.data }
                : { ok: false, reason: result.reason, items: [] };
        },
    };
}
