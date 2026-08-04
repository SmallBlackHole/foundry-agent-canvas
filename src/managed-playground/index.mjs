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
            const conversation = existingConversationId
                ? { id: existingConversationId }
                : await openAIClient.conversations.create({}, { signal });
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
                    input: [{
                        role: "user",
                        content: [{
                            type: "input_text",
                            text: message,
                        }],
                    }],
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

            for await (const event of response) {
                throwIfAborted(signal);
                if (event?.type === "response.output_text.delta" && event.delta) {
                    await emit({
                        type: "delta",
                        delta: event.delta,
                    });
                }
            }

            throwIfAborted(signal);
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
