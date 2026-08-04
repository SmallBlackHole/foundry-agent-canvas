import { createManagedAgentPlayground } from "../managed-playground/index.mjs";

function noProjectResult() {
    return {
        httpStatus: 400,
        body: {
            ok: false,
            error: "Select a Foundry project before starting the managed agent playground.",
        },
    };
}

export function createManagedPlaygroundServices({
    ctx,
    session,
    playground = createManagedAgentPlayground(),
}) {
    const selectedEndpoint = () => String(ctx.getEndpoint() || "").replace(/\/+$/, "");

    return {
        streamManagedAgent({ body }) {
            const endpoint = selectedEndpoint();
            if (!endpoint) return noProjectResult();
            return {
                stream: "ndjson",
                run: ({ signal, emit }) => playground.stream({
                    endpoint,
                    agentName: body.agentName,
                    agentVersion: body.agentVersion,
                    message: body.message,
                    conversationId: body.conversationId,
                    signal,
                    emit,
                }),
            };
        },

        async resetManagedAgentConversation({ body }) {
            const endpoint = selectedEndpoint();
            if (!endpoint) return noProjectResult();
            try {
                await playground.reset({
                    endpoint,
                    conversationId: body.conversationId,
                });
                return { ok: true, deleted: true };
            } catch (error) {
                if (error?.status === 404) {
                    return { ok: true, deleted: false };
                }
                try {
                    await session?.log(
                        `Managed agent conversation reset failed: ${error?.message ?? error}`,
                        { level: "warning" },
                    );
                } catch {
                    /* logging must not change the reset result */
                }
                return {
                    ok: false,
                    deleted: false,
                    error: error?.message || String(error),
                };
            }
        },
    };
}
