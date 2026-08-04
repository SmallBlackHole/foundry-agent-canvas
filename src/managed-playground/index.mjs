import {
    createCanvasTokenCredential,
    createFoundryProjectClient,
} from "./foundry-client.mjs";

function text(value) {
    return typeof value === "string" ? value.trim() : "";
}

function abortError() {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    return error;
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError();
}

function userMessage(message) {
    return {
        role: "user",
        content: [{
            type: "input_text",
            text: message,
        }],
    };
}

function terminalResponseError(event) {
    if (event?.type === "response.failed") {
        const detail = text(event.response?.error?.message);
        return new Error(detail ? `Foundry response failed: ${detail}` : "Foundry response failed");
    }
    if (event?.type === "response.incomplete") {
        const reason = text(event.response?.incomplete_details?.reason);
        return new Error(
            reason
                ? `Foundry response was incomplete: ${reason}`
                : "Foundry response was incomplete",
        );
    }
    if (event?.type === "error") {
        const detail = text(event.message);
        return new Error(detail ? `Foundry response error: ${detail}` : "Foundry response error");
    }
    return null;
}

export function createManagedAgentPlayground({
    getAccessToken,
    now,
    projectClientFactory = createFoundryProjectClient,
} = {}) {
    const credential = createCanvasTokenCredential({
        ...(getAccessToken ? { getAccessToken } : {}),
        ...(now ? { now } : {}),
    });

    async function getClients(endpoint) {
        const projectClient = projectClientFactory(endpoint, credential);
        return {
            projectClient,
            openAIClient: await projectClient.getOpenAIClient(),
        };
    }

    async function resolveAgentVersion(projectClient, agentName, agentVersion, signal) {
        const requestedVersion = text(agentVersion);
        if (requestedVersion) return requestedVersion;
        throwIfAborted(signal);
        const agent = await projectClient.agents.get(agentName, {
            abortSignal: signal,
        });
        throwIfAborted(signal);
        const latestVersion = text(agent?.versions?.latest?.version);
        if (!latestVersion) {
            throw new Error(`Managed agent "${agentName}" is not deployed.`);
        }
        return latestVersion;
    }

    return {
        async stream({
            endpoint,
            agentName,
            agentVersion,
            message,
            conversationId,
            signal,
            emit,
        }) {
            throwIfAborted(signal);
            const { projectClient, openAIClient } = await getClients(endpoint);
            throwIfAborted(signal);
            const activeAgentVersion = await resolveAgentVersion(
                projectClient,
                agentName,
                agentVersion,
                signal,
            );

            await emit({
                type: "agent",
                agentName,
                agentVersion: activeAgentVersion,
            });

            const existingConversationId = text(conversationId);
            const input = userMessage(message);
            let conversation;
            if (existingConversationId) {
                conversation = { id: existingConversationId };
                await openAIClient.conversations.items.create(
                    existingConversationId,
                    { items: [input] },
                    { signal },
                );
            } else {
                conversation = await openAIClient.conversations.create(
                    { items: [input] },
                    { signal },
                );
            }
            throwIfAborted(signal);
            const activeConversationId = text(conversation?.id);
            if (!activeConversationId) {
                throw new Error("Foundry did not return a conversation id");
            }

            await emit({
                type: "conversation",
                conversationId: activeConversationId,
            });

            const response = await openAIClient.responses.create(
                {
                    conversation: activeConversationId,
                    stream: true,
                },
                {
                    signal,
                    body: {
                        agent_reference: {
                            type: "agent_reference",
                            name: agentName,
                            version: activeAgentVersion,
                        },
                    },
                },
            );

            let completed = false;
            for await (const event of response) {
                throwIfAborted(signal);
                if (event?.type === "response.output_text.delta" && event.delta) {
                    await emit({
                        type: "delta",
                        delta: event.delta,
                    });
                }
                if (event?.type === "response.completed") {
                    completed = true;
                }
                const terminalError = terminalResponseError(event);
                if (terminalError) throw terminalError;
            }

            throwIfAborted(signal);
            if (!completed) {
                throw new Error("Foundry response stream ended before completion");
            }
            await emit({
                type: "done",
                conversationId: activeConversationId,
                agentVersion: activeAgentVersion,
            });
            return {
                conversationId: activeConversationId,
                agentVersion: activeAgentVersion,
            };
        },

        async reset({ endpoint, conversationId, signal }) {
            throwIfAborted(signal);
            const { openAIClient } = await getClients(endpoint);
            throwIfAborted(signal);
            await openAIClient.conversations.delete(conversationId, { signal });
        },
    };
}
