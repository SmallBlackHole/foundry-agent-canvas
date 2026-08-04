import { DEPLOY_PROMPT } from "../catalog.mjs";
import { markManagedAgentPrompt } from "../managed-prompt-context.mjs";
import { checkPluginUpdate } from "../plugin-update.mjs";
import { bootstrapInstance, defaultState } from "../state.mjs";

export function createCanvasServices({
    ctx,
    session,
    extensionDir,
    waitForFoundrySkill,
    markPendingRefresh,
    pluginVersion = "",
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
            if (typeof body.refresh === "string" && body.refresh) {
                markPendingRefresh?.(body.refresh);
            }
            await waitForFoundrySkill?.();
            await session.send({
                prompt: markManagedAgentPrompt(body.prompt, body.managedAction),
            });
            return {};
        },
        async getPluginUpdate({ url }) {
            return pluginUpdate.check({
                extensionDir,
                force: url.searchParams.get("refresh") === "1",
            });
        },
    };
}
