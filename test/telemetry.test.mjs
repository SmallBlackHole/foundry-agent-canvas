import assert from "node:assert/strict";
import { hostname } from "node:os";
import test from "node:test";

import {
    createCanvasTelemetry,
    createOtelEmitter,
    createTelemetryRecorder,
} from "../src/telemetry/index.mjs";
import {
    TELEMETRY_CONNECTION_STRING_ENV,
    TELEMETRY_EVENTS,
} from "../src/telemetry/schema.mjs";

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("telemetry is a no-op when the Canvas connection string is absent or empty", () => {
    let deviceReads = 0;
    for (const value of [undefined, "", "   "]) {
        const telemetry = createCanvasTelemetry({
            env: value === undefined
                ? {}
                : { [TELEMETRY_CONNECTION_STRING_ENV]: value },
            productVersion: "1.2.3",
            getDeviceId: () => {
                deviceReads += 1;
                return "device";
            },
            emitterFactory: () => assert.fail("must not create an exporter"),
        });
        assert.equal(telemetry.enabled, false);
        assert.equal(telemetry.recordActive(), false);
        assert.equal(telemetry.recordAction({ action: "report_issue" }), false);
    }
    assert.equal(deviceReads, 0);
});

test("a bundled connection string enables telemetry without a runtime environment value", () => {
    let configuredConnectionString = "";
    const telemetry = createCanvasTelemetry({
        env: {},
        bundledConnectionString:
            "InstrumentationKey=00000000-0000-0000-0000-000000000001",
        emitterFactory: ({ connectionString }) => {
            configuredConnectionString = connectionString;
            return { emit() {} };
        },
    });

    assert.equal(telemetry.enabled, true);
    assert.equal(
        configuredConnectionString,
        "InstrumentationKey=00000000-0000-0000-0000-000000000001",
    );
});

test("active, action, and operation events expose only their allowlisted schemas", async () => {
    const events = [];
    const telemetry = createTelemetryRecorder({
        productVersion: "1.2.3",
        deviceId: async () => "device-123",
        os: "win32",
        architecture: "x64",
        emitter: {
            emit(name, attributes, options) {
                events.push({ name, attributes, options });
            },
        },
    });

    assert.equal(telemetry.recordActive(), true);
    assert.equal(telemetry.recordAction({
        action: "switch_model",
        resourceKind: "model",
    }), true);
    assert.equal(telemetry.recordOperation({
        operation: "prompt_delivery",
        outcome: "accepted",
        durationMs: 12.6,
        source: "ui",
        resourceKind: "model",
    }), true);
    await nextTurn();

    assert.deepEqual(events[0], {
        name: TELEMETRY_EVENTS.action,
        attributes: {
            "ftk.canvas.action": "switch_model",
            "ftk.canvas.productVersion": "1.2.3",
            "ftk.canvas.resourceKind": "model",
        },
        options: undefined,
    });
    assert.deepEqual(events[1], {
        name: TELEMETRY_EVENTS.operation,
        attributes: {
            "ftk.canvas.operation": "prompt_delivery",
            "ftk.canvas.outcome": "accepted",
            "ftk.canvas.durationMs": 13,
            "ftk.canvas.source": "ui",
            "ftk.canvas.productVersion": "1.2.3",
            "ftk.canvas.resourceKind": "model",
        },
        options: { failed: false },
    });
    assert.deepEqual(events[2], {
        name: TELEMETRY_EVENTS.active,
        attributes: {
            "machine.devdeviceid": "device-123",
            "ftk.canvas.productVersion": "1.2.3",
            "ftk.canvas.os": "win32",
            "ftk.canvas.arch": "x64",
        },
        options: undefined,
    });
});

test("schema validation rejects view-state actions and arbitrary privacy fields", () => {
    const events = [];
    const telemetry = createTelemetryRecorder({
        productVersion: "1",
        emitter: {
            emit(...args) {
                events.push(args);
            },
        },
    });

    assert.equal(telemetry.recordAction({ action: "open_dropdown" }), false);
    assert.equal(telemetry.recordAction({
        action: "switch_model",
        resourceKind: "agent",
    }), false);
    assert.equal(telemetry.recordAction({
        action: "switch_model",
        resourceKind: "model",
        agentName: "private-agent",
    }), false);
    assert.equal(telemetry.recordOperation({
        operation: "prompt_delivery",
        outcome: "accepted",
        durationMs: 1,
        source: "ui",
        prompt: "private prompt",
    }), false);
    assert.deepEqual(events, []);
});

test("telemetry exporter failures are isolated from Canvas callers", async () => {
    const telemetry = createTelemetryRecorder({
        emitter: {
            emit() {
                throw new Error("export failed");
            },
            shutdown() {
                throw new Error("shutdown failed");
            },
        },
    });

    assert.equal(telemetry.recordAction({ action: "report_issue" }), false);
    assert.equal(telemetry.recordOperation({
        operation: "sign_out",
        outcome: "succeeded",
        durationMs: 1,
        source: "ui",
    }), false);
    await assert.doesNotReject(telemetry.shutdown());
});

test("the Azure Monitor exporter sends an allowlisted envelope without the machine hostname", async () => {
    let resolveRequest;
    const requestReceived = new Promise((resolve) => {
        resolveRequest = resolve;
    });
    const emitter = createOtelEmitter({
        connectionString:
            "InstrumentationKey=00000000-0000-0000-0000-000000000001",
        productVersion: "1.2.3",
        httpClient: {
            async sendRequest(request) {
                const body = typeof request.body === "function"
                    ? request.body()
                    : request.body;
                resolveRequest({
                    path: new URL(request.url).pathname,
                    body: Buffer.from(body).toString("utf-8"),
                });
                return {
                    request,
                    status: 200,
                    headers: request.headers,
                    bodyAsText:
                        '{"itemsReceived":1,"itemsAccepted":1,"errors":[]}',
                };
            },
        },
    });
    const telemetry = createTelemetryRecorder({
        productVersion: "1.2.3",
        emitter,
    });

    try {
        assert.equal(telemetry.recordAction({ action: "report_issue" }), true);
        const request = await Promise.race([
            requestReceived,
            new Promise((_, reject) => {
                const timer = setTimeout(
                    () => reject(new Error("telemetry request timed out")),
                    3_000,
                );
                timer.unref?.();
            }),
        ]);

        assert.equal(request.path, "/v2.1/track");
        const envelopes = JSON.parse(request.body);
        assert.equal(envelopes.length, 1);
        const [event] = envelopes;
        assert.equal(
            event.data.baseData.name,
            TELEMETRY_EVENTS.action,
        );
        assert.equal(
            event.data.baseData.properties["ftk.canvas.action"],
            "report_issue",
        );
        assert.equal(
            event.tags["ai.cloud.roleInstance"],
            "foundry-toolkit-canvas",
        );
        assert.equal(request.body.includes(hostname()), false);
    } finally {
        await telemetry.shutdown();
    }
});
