import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createApiRouter } from "../src/api-router.mjs";
import { createRuntimeApiServices } from "../src/api/index.mjs";
import { servers } from "../src/state.mjs";

async function withRouter(services, run) {
    const errors = [];
    const router = createApiRouter({
        services,
        reportError: async (error, request) => errors.push({ error, request }),
    });
    const server = createServer((req, res) => router(req, res));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    try {
        await run(`http://127.0.0.1:${port}`, errors);
    } finally {
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
}

function parseNdjson(value) {
    return value.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("streams a managed agent through the selected Canvas project", async (t) => {
    const instanceId = "managed-playground-route-test";
    const calls = [];
    servers.set(instanceId, {
        state: {
            selection: {
                subscription: { id: "sub-1", name: "Subscription" },
                project: {
                    endpoint: "https://example.test/api/projects/project/",
                    name: "Project",
                    subscriptionId: "sub-1",
                },
            },
        },
    });
    t.after(() => servers.delete(instanceId));
    const services = createRuntimeApiServices(instanceId, {
        session: { log: async () => {}, send: async () => {} },
        workspaceRootFn: async () => "",
        managedPlayground: {
            async stream(input) {
                calls.push(["stream", input]);
                const conversationId = input.conversationId || "conversation-1";
                await input.emit({
                    type: "agent",
                    agentName: input.agentName,
                    agentVersion: "7",
                });
                await input.emit({ type: "conversation", conversationId });
                await input.emit({ type: "delta", delta: input.message });
                await input.emit({
                    type: "done",
                    conversationId,
                    agentVersion: "7",
                });
            },
            async reset(input) {
                calls.push(["reset", input]);
            },
        },
    });

    await withRouter(services, async (base) => {
        const response = await fetch(`${base}/api/managed-agent/playground/stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                agentName: " support-agent ",
                message: " Hello ",
            }),
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
        assert.deepEqual(parseNdjson(await response.text()), [
            { type: "agent", agentName: "support-agent", agentVersion: "7" },
            { type: "conversation", conversationId: "conversation-1" },
            { type: "delta", delta: "Hello" },
            { type: "done", conversationId: "conversation-1", agentVersion: "7" },
        ]);

        const secondResponse = await fetch(`${base}/api/managed-agent/playground/stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                agentName: "support-agent",
                agentVersion: "7",
                message: "Continue",
                conversationId: "conversation-1",
            }),
        });
        assert.equal(secondResponse.status, 200);
        assert.deepEqual(parseNdjson(await secondResponse.text()), [
            { type: "agent", agentName: "support-agent", agentVersion: "7" },
            { type: "conversation", conversationId: "conversation-1" },
            { type: "delta", delta: "Continue" },
            { type: "done", conversationId: "conversation-1", agentVersion: "7" },
        ]);

        assert.deepEqual(await (await fetch(`${base}/api/managed-agent/playground/reset`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ conversationId: " conversation-1 " }),
        })).json(), {
            ok: true,
            deleted: true,
        });
    });

    assert.equal(calls[0][1].endpoint, "https://example.test/api/projects/project");
    assert.equal(calls[0][1].agentName, "support-agent");
    assert.equal(calls[0][1].agentVersion, "");
    assert.equal(calls[0][1].message, "Hello");
    assert.equal(calls[0][1].conversationId, "");
    assert.equal(calls[0][1].signal instanceof AbortSignal, true);
    assert.equal(calls[1][1].conversationId, "conversation-1");
    assert.equal(calls[1][1].message, "Continue");
    assert.equal(calls[1][1].signal instanceof AbortSignal, true);
    assert.deepEqual(calls[2], ["reset", {
        endpoint: "https://example.test/api/projects/project",
        conversationId: "conversation-1",
    }]);
});

test("validates the PoC inputs and requires a selected project", async () => {
    await withRouter({
        streamManagedAgent: () => {
            throw new Error("validation should run before the service");
        },
        resetManagedAgentConversation: () => {
            throw new Error("validation should run before the service");
        },
    }, async (base) => {
        assert.deepEqual(await (await fetch(`${base}/api/managed-agent/playground/stream`, {
            method: "POST",
            body: JSON.stringify({
                agentName: "",
                message: "hello",
            }),
        })).json(), {
            ok: false,
            error: "Missing agentName",
        });
        assert.deepEqual(await (await fetch(`${base}/api/managed-agent/playground/reset`, {
            method: "POST",
            body: "{}",
        })).json(), {
            ok: false,
            error: "Missing conversationId",
        });
    });

    const instanceId = "managed-playground-no-project-test";
    servers.set(instanceId, {
        state: {
            selection: {
                subscription: { id: "", name: "" },
                project: null,
            },
        },
    });
    try {
        const services = createRuntimeApiServices(instanceId, {
            session: { log: async () => {}, send: async () => {} },
            workspaceRootFn: async () => "",
            managedPlayground: {
                stream: async () => {
                    throw new Error("must not run without a project");
                },
            },
        });
        await withRouter(services, async (base) => {
            const response = await fetch(`${base}/api/managed-agent/playground/stream`, {
                method: "POST",
                body: JSON.stringify({
                    agentName: "agent",
                    agentVersion: "1",
                    message: "hello",
                }),
            });
            assert.equal(response.status, 400);
            assert.deepEqual(await response.json(), {
                ok: false,
                error: "Select a Foundry project before starting the managed agent playground.",
            });
        });
    } finally {
        servers.delete(instanceId);
    }
});

test("aborts the Foundry stream when the fetch client disconnects", async () => {
    let markAborted;
    const aborted = new Promise((resolve) => {
        markAborted = resolve;
    });
    await withRouter({
        streamManagedAgent: () => ({
            stream: "ndjson",
            async run({ signal, emit }) {
                await emit({ type: "conversation", conversationId: "conversation-1" });
                await new Promise((resolve, reject) => {
                    signal.addEventListener("abort", () => {
                        markAborted(signal.aborted);
                        const error = new Error("client disconnected");
                        error.name = "AbortError";
                        reject(error);
                    }, { once: true });
                });
            },
        }),
    }, async (base, errors) => {
        const controller = new AbortController();
        const response = await fetch(`${base}/api/managed-agent/playground/stream`, {
            method: "POST",
            signal: controller.signal,
            body: JSON.stringify({
                agentName: "agent",
                agentVersion: "1",
                message: "hello",
            }),
        });
        const reader = response.body.getReader();
        const first = await reader.read();
        assert.equal(new TextDecoder().decode(first.value).includes("\"conversation\""), true);
        controller.abort();
        assert.equal(await aborted, true);
        assert.deepEqual(errors, []);
    });
});

test("writes terminal stream failures as NDJSON and reports them once", async () => {
    await withRouter({
        streamManagedAgent: () => ({
            stream: "ndjson",
            async run({ emit }) {
                await emit({ type: "conversation", conversationId: "conversation-1" });
                throw new Error("stream failed");
            },
        }),
    }, async (base, errors) => {
        const response = await fetch(`${base}/api/managed-agent/playground/stream`, {
            method: "POST",
            body: JSON.stringify({
                agentName: "agent",
                agentVersion: "1",
                message: "hello",
            }),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(parseNdjson(await response.text()), [
            { type: "conversation", conversationId: "conversation-1" },
            { type: "error", error: "stream failed" },
        ]);
        assert.equal(errors.length, 1);
        assert.deepEqual(errors[0].request, {
            method: "POST",
            path: "/api/managed-agent/playground/stream",
        });
    });
});
