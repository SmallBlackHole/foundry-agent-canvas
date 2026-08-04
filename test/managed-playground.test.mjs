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
            items: {
                create: async () => {
                    throw new Error("new conversation should include its initial message");
                },
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
    assert.deepEqual(calls[0], ["conversation.create", {
        items: [{
            role: "user",
            content: [{
                type: "input_text",
                text: "Help me",
            }],
        }],
    }, { signal }]);
    assert.deepEqual(calls[1][1], {
        conversation: "conversation-1",
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

test("commits two rounds to one conversation and deletes it on reset", async () => {
    const calls = [];
    const conversations = new Map();
    const openAIClient = {
        conversations: {
            create: async (body, options) => {
                calls.push(["conversation.create", body, options]);
                conversations.set("conversation-1", {
                    active: false,
                    items: [...body.items],
                    processed: 0,
                });
                return { id: "conversation-1" };
            },
            items: {
                create: async (conversationId, body, options) => {
                    calls.push(["conversation.items.create", conversationId, body, options]);
                    const conversation = conversations.get(conversationId);
                    assert.ok(conversation, "conversation must exist before adding a message");
                    assert.equal(conversation.active, false, "previous response must be complete");
                    conversation.items.push(...body.items);
                },
            },
            delete: async (conversationId, options) => {
                calls.push(["conversation.delete", conversationId, options]);
                const conversation = conversations.get(conversationId);
                assert.ok(conversation, "conversation must exist before reset");
                assert.equal(conversation.active, false, "response must be complete before reset");
                conversations.delete(conversationId);
            },
        },
        responses: {
            create: async (body, options) => {
                calls.push(["response.create", body, options]);
                const conversation = conversations.get(body.conversation);
                assert.ok(conversation, "response must use an existing conversation");
                assert.equal("input" in body, false, "messages must be committed before the response");
                assert.equal(conversation.active, false, "only one response may run at a time");
                const message = conversation.items[conversation.processed];
                assert.ok(message, "each response must have one unprocessed user message");
                conversation.active = true;
                return (async function* stream() {
                    yield {
                        type: "response.output_text.delta",
                        delta: `reply:${message.content[0].text}`,
                    };
                    conversation.processed += 1;
                    conversation.active = false;
                    yield { type: "response.completed" };
                })();
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
    const signal = new AbortController().signal;

    const first = await playground.stream({
        endpoint: "https://example.test/api/projects/project",
        agentName: "support-agent",
        agentVersion: "7",
        message: "First",
        signal,
        emit: async (event) => events.push(event),
    });
    const second = await playground.stream({
        endpoint: "https://example.test/api/projects/project",
        agentName: "support-agent",
        agentVersion: "7",
        message: "Second",
        conversationId: first.conversationId,
        signal,
        emit: async (event) => events.push(event),
    });
    await playground.reset({
        endpoint: "https://example.test/api/projects/project",
        conversationId: second.conversationId,
    });

    assert.deepEqual(first, {
        conversationId: "conversation-1",
        agentVersion: "7",
    });
    assert.deepEqual(second, first);
    assert.deepEqual(calls.map(([name]) => name), [
        "conversation.create",
        "response.create",
        "conversation.items.create",
        "response.create",
        "conversation.delete",
    ]);
    assert.deepEqual(calls[2], ["conversation.items.create", "conversation-1", {
        items: [{
            role: "user",
            content: [{
                type: "input_text",
                text: "Second",
            }],
        }],
    }, { signal }]);
    assert.equal(conversations.size, 0);
    assert.deepEqual(events, [
        { type: "agent", agentName: "support-agent", agentVersion: "7" },
        { type: "conversation", conversationId: "conversation-1" },
        { type: "delta", delta: "reply:First" },
        { type: "done", conversationId: "conversation-1", agentVersion: "7" },
        { type: "agent", agentName: "support-agent", agentVersion: "7" },
        { type: "conversation", conversationId: "conversation-1" },
        { type: "delta", delta: "reply:Second" },
        { type: "done", conversationId: "conversation-1", agentVersion: "7" },
    ]);
});

test("does not mark a response done when its stream ends without completion", async () => {
    const playground = createManagedAgentPlayground({
        projectClientFactory: () => ({
            agents: {
                get: async () => ({
                    versions: { latest: { version: "7" } },
                }),
            },
            getOpenAIClient: () => ({
                conversations: {
                    create: async () => ({ id: "conversation-1" }),
                },
                responses: {
                    create: async () => (async function* stream() {
                        yield { type: "response.output_text.delta", delta: "partial" };
                    })(),
                },
            }),
        }),
    });
    const events = [];

    await assert.rejects(playground.stream({
        endpoint: "https://example.test/api/projects/project",
        agentName: "support-agent",
        agentVersion: "7",
        message: "Hello",
        emit: async (event) => events.push(event),
    }), /ended before completion/);

    assert.deepEqual(events, [
        { type: "agent", agentName: "support-agent", agentVersion: "7" },
        { type: "conversation", conversationId: "conversation-1" },
        { type: "delta", delta: "partial" },
    ]);
});
