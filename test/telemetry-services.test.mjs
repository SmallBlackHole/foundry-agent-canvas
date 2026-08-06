import assert from "node:assert/strict";
import test from "node:test";

import { createCanvasServices } from "../src/api/canvas-services.mjs";
import { createHostedAgentServices } from "../src/api/hosted-agent-services.mjs";
import { createInspectorServices } from "../src/api/inspector-services.mjs";

function operationRecorder() {
    const events = [];
    return {
        events,
        telemetry: {
            recordOperation(event) {
                events.push(event);
                return true;
            },
        },
    };
}

test("chat-delegated resource requests report prompt accepted, not resource success", async () => {
    const { events, telemetry } = operationRecorder();
    const created = [];
    const deployed = [];
    const marks = [];
    const services = createCanvasServices({
        ctx: { instanceId: "canvas-1", getEntry: () => null },
        session: { send: async () => {} },
        extensionDir: "",
        telemetry,
        markPendingRefresh: (kind) => marks.push(["mark", kind]),
        clearPendingRefresh: (kind) => marks.push(["clear", kind]),
        createAgentOperations: {
            start: (key) => created.push(["start", key]),
        },
        deploymentOperations: {
            start: (key) => deployed.push(["start", key]),
            finish: (...args) => deployed.push(["finish", ...args]),
        },
        now: (() => {
            let value = 10;
            return () => value += 5;
        })(),
    });

    assert.deepEqual(await services.sendPrompt({
        body: { prompt: "private prompt", resourceKind: "model" },
    }), {});
    assert.deepEqual(events[0], {
        operation: "prompt_delivery",
        outcome: "accepted",
        durationMs: 5,
        source: "ui",
        resourceKind: "model",
    });
    assert.deepEqual(created, []);
    assert.deepEqual(deployed, []);

    await services.sendPrompt({
        body: {
            prompt: "private create prompt",
            resourceKind: "agent",
        },
    });
    assert.deepEqual(created, [["start", "canvas-1"]]);

    await services.sendPrompt({
        body: {
            prompt: "private deploy prompt",
            refresh: "deployment",
            resourceKind: "agent",
        },
    });
    assert.deepEqual(marks, [["mark", "deployment"]]);
    assert.deepEqual(deployed, [["start", "canvas-1"]]);
    assert.equal(events.every((event) => !("prompt" in event)), true);
});

test("prompt delivery failure clears deployment verification without changing the error", async () => {
    const { events, telemetry } = operationRecorder();
    const calls = [];
    const services = createCanvasServices({
        ctx: { instanceId: "canvas-1", getEntry: () => null },
        session: {
            send: async () => {
                throw Object.assign(new Error("private failure"), { code: "timeout" });
            },
        },
        extensionDir: "",
        telemetry,
        markPendingRefresh: (kind) => calls.push(["mark", kind]),
        clearPendingRefresh: (kind) => calls.push(["clear", kind]),
        deploymentOperations: {
            start: (key) => calls.push(["start", key]),
            finish: (...args) => calls.push(["finish", ...args]),
        },
        now: (() => {
            let value = 100;
            return () => value += 10;
        })(),
    });

    await assert.rejects(services.sendPrompt({
        body: {
            prompt: "private deploy prompt",
            refresh: "deployment",
            resourceKind: "agent",
        },
    }), /private failure/);
    assert.deepEqual(calls, [
        ["mark", "deployment"],
        ["start", "canvas-1"],
        ["clear", "deployment"],
        ["finish", "canvas-1", "failed", "prompt_not_accepted"],
    ]);
    assert.equal(events[0].outcome, "failed");
    assert.equal(events[0].failureCode, "timeout");
    assert.equal("prompt" in events[0], false);
});

test("workspace refresh completes create-agent reliability without emitting agent data", async () => {
    const finishes = [];
    const services = createHostedAgentServices({
        ctx: {
            instanceId: "canvas-1",
            getEntry: () => ({ state: { agentName: "" } }),
        },
        workspaceRootFn: async () => "C:\\workspace",
        listAgents: async () => [{
            agentName: "private-agent-name",
            projectDir: "C:\\workspace\\agent",
            manifestPath: "C:\\workspace\\agent\\azure.yaml",
        }],
        createAgentOperations: {
            finish: (...args) => finishes.push(args),
        },
    });

    await services.listHostedAgents();
    assert.deepEqual(
        await services.selectHostedAgent({
            body: { agentName: "private-agent-name", created: true },
        }),
        { ok: true, selected: "private-agent-name" },
    );
    assert.deepEqual(finishes, [["canvas-1", "succeeded", undefined]]);
});

test("Inspector startup and readiness emit success and bounded timeout outcomes", async () => {
    const { events, telemetry } = operationRecorder();
    let current = 0;
    const ready = [true, false, false];
    const services = createInspectorServices({
        ctx: {
            instanceId: "canvas-1",
            getEntry: () => ({ state: { agentName: "" } }),
        },
        session: {},
        inspectorUiDir: "inspector-ui",
        workspaceRootFn: async () => "C:\\workspace",
        telemetry,
        readinessMaxAttempts: 2,
        now: () => current,
        localInspector: {
            listAgents: async () => [{ agentName: "private-agent" }],
            resolveProject: async () => ({ projectDir: "private" }),
            ensureProxy: async () => "http://127.0.0.1:1234",
            launchTerminal: async () => ({ ok: true }),
            isReady: async () => ready.shift(),
        },
    });

    current = 10;
    await services.startInspector();
    current = 30;
    assert.deepEqual(await services.getInspectorReady(), { ready: true });

    current = 40;
    await services.startInspector();
    current = 50;
    assert.deepEqual(await services.getInspectorReady(), { ready: false });
    current = 70;
    assert.deepEqual(await services.getInspectorReady(), { ready: false });

    assert.deepEqual(events.map((event) => ({
        operation: event.operation,
        outcome: event.outcome,
        failureCode: event.failureCode,
    })), [
        {
            operation: "inspector_startup",
            outcome: "succeeded",
            failureCode: undefined,
        },
        {
            operation: "inspector_readiness",
            outcome: "succeeded",
            failureCode: undefined,
        },
        {
            operation: "inspector_startup",
            outcome: "succeeded",
            failureCode: undefined,
        },
        {
            operation: "inspector_readiness",
            outcome: "timed_out",
            failureCode: "timeout",
        },
    ]);
});
