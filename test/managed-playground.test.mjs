import assert from "node:assert/strict";
import test from "node:test";

import { createCanvasTokenCredential } from "../src/managed-playground/foundry-client.mjs";
import { createManagedAgentPlayground } from "../src/managed-playground/index.mjs";

test("adapts Canvas auth to the Azure TokenCredential contract", async () => {
    const scopes = [];
    const credential = createCanvasTokenCredential({
        getAccessToken: async (scope) => {
            scopes.push(scope);
            return "token-value";
        },
        now: () => 1_000,
    });

    assert.deepEqual(await credential.getToken([
        "https://ai.azure.com/.default",
        "ignored",
    ]), {
        token: "token-value",
        expiresOnTimestamp: 301_000,
    });
    assert.deepEqual(scopes, ["https://ai.azure.com/.default"]);
});

test("creates a conversation and streams only assistant text deltas", async () => {
    const calls = [];
    const signal = new AbortController().signal;
    const openAIClient = {
        conversations: {
            create: async (...args) => {
                calls.push(["conversation.create", ...args]);
                return { id: "conversation-1" };
            },
            delete: async () => {},
        },
        responses: {
            create: async (...args) => {
                calls.push(["response.create", ...args]);
                return (async function* stream() {
                    yield { type: "response.reasoning_summary_text.delta", delta: "hidden" };
                    yield { type: "response.output_item.added", item: { type: "mcp_call" } };
                    yield { type: "response.output_text.delta", delta: "Hello" };
                    yield { type: "response.output_text.delta", delta: " world" };
                    yield { type: "response.completed" };
                })();
            },
        },
    };
    const projectClient = {
        agents: {
            get: async () => ({
                versions: { latest: { version: "7" } },
            }),
        },
        getOpenAIClient: async () => openAIClient,
    };
    const createdClients = [];
    const playground = createManagedAgentPlayground({
        projectClientFactory(endpoint, credential) {
            createdClients.push({ endpoint, credential });
            return projectClient;
        },
    });
    const events = [];

    const result = await playground.stream({
        endpoint: "https://example.test/api/projects/project",
        agentName: "support-agent",
        agentVersion: "",
        message: "Help me",
        signal,
        emit: async (event) => events.push(event),
    });

    assert.equal(createdClients[0].endpoint, "https://example.test/api/projects/project");
    assert.equal(typeof createdClients[0].credential.getToken, "function");
    assert.deepEqual(calls[0], ["conversation.create", {}, { signal }]);
    assert.deepEqual(calls[1][1], {
        conversation: "conversation-1",
        input: [{
            role: "user",
            content: [{
                type: "input_text",
                text: "Help me",
            }],
        }],
        stream: true,
    });
    assert.equal(calls[1][2].signal, signal);
    assert.equal("headers" in calls[1][2], false);
    assert.deepEqual(calls[1][2].body, {
        agent_reference: {
            type: "agent_reference",
            name: "support-agent",
            version: "7",
        },
    });
    assert.deepEqual(events, [
        { type: "agent", agentName: "support-agent", agentVersion: "7" },
        { type: "conversation", conversationId: "conversation-1" },
        { type: "delta", delta: "Hello" },
        { type: "delta", delta: " world" },
        { type: "done", conversationId: "conversation-1", agentVersion: "7" },
    ]);
    assert.deepEqual(result, {
        conversationId: "conversation-1",
        agentVersion: "7",
    });
});

test("reuses and deletes an existing conversation", async () => {
    const calls = [];
    const openAIClient = {
        conversations: {
            create: async () => {
                throw new Error("existing conversation must be reused");
            },
            delete: async (...args) => calls.push(["delete", ...args]),
        },
        responses: {
            create: async (...args) => {
                calls.push(["create", ...args]);
                return (async function* stream() {})();
            },
        },
    };
    const playground = createManagedAgentPlayground({
        projectClientFactory: () => ({
            agents: {
                get: async () => ({
                    versions: { latest: { version: "7" } },
                }),
            },
            getOpenAIClient: () => openAIClient,
        }),
    });
    const events = [];

    await playground.stream({
        endpoint: "https://example.test/api/projects/project",
        agentName: "support-agent",
        agentVersion: "7",
        message: "Continue",
        conversationId: "conversation-existing",
        emit: async (event) => events.push(event),
    });
    await playground.reset({
        endpoint: "https://example.test/api/projects/project",
        conversationId: "conversation-existing",
    });

    assert.equal(calls[0][1].conversation, "conversation-existing");
    assert.deepEqual(calls[1], ["delete", "conversation-existing", { signal: undefined }]);
    assert.deepEqual(events, [
        { type: "agent", agentName: "support-agent", agentVersion: "7" },
        { type: "conversation", conversationId: "conversation-existing" },
        { type: "done", conversationId: "conversation-existing", agentVersion: "7" },
    ]);
});
