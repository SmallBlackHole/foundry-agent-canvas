import assert from "node:assert/strict";
import test from "node:test";

import {
    createPendingOperationTracker,
    runTelemetryOperation,
} from "../../src/telemetry/operations.mjs";
import {
    deploymentVerificationOutcome,
    foundrySkillOperation,
    pendingDeploymentOutcome,
} from "../../src/telemetry/outcomes.mjs";

function recorder() {
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

test("operation helper preserves success and failure results", async () => {
    const { events, telemetry } = recorder();
    let current = 100;
    const succeeded = await runTelemetryOperation(telemetry, {
        operation: "sign_out",
        source: "ui",
        now: () => current,
    }, async () => {
        current = 125;
        return { ok: true, value: 7 };
    });
    assert.deepEqual(succeeded, { ok: true, value: 7 });
    assert.deepEqual(events[0], {
        operation: "sign_out",
        source: "ui",
        resourceKind: undefined,
        durationMs: 25,
        outcome: "succeeded",
        failureCode: undefined,
    });

    current = 200;
    await assert.rejects(
        runTelemetryOperation(telemetry, {
            operation: "load_resources",
            source: "ui",
            resourceKind: "model",
            now: () => current,
        }, async () => {
            current = 240;
            throw Object.assign(new Error("private error"), { code: "timeout" });
        }),
        /private error/,
    );
    assert.deepEqual(events[1], {
        operation: "load_resources",
        source: "ui",
        resourceKind: "model",
        outcome: "failed",
        failureCode: "timeout",
        durationMs: 40,
    });
});

test("pending operations emit verified success and bounded timeout outcomes", () => {
    const { events, telemetry } = recorder();
    let current = 1_000;
    const tracker = createPendingOperationTracker({
        telemetry,
        operation: "create_agent",
        source: "session_idle",
        resourceKind: "agent",
        maxIdleAttempts: 3,
        now: () => current,
    });

    tracker.start("canvas-1");
    current = 1_050;
    assert.equal(tracker.finish("canvas-1", "succeeded"), true);
    assert.equal(tracker.has("canvas-1"), false);

    tracker.start("canvas-2");
    current = 1_100;
    assert.equal(tracker.tick("canvas-2"), false);
    assert.equal(tracker.tick("canvas-2"), false);
    assert.equal(tracker.tick("canvas-2"), true);
    assert.equal(tracker.has("canvas-2"), false);

    assert.deepEqual(events, [
        {
            operation: "create_agent",
            source: "session_idle",
            resourceKind: "agent",
            outcome: "succeeded",
            durationMs: 50,
        },
        {
            operation: "create_agent",
            source: "session_idle",
            resourceKind: "agent",
            outcome: "timed_out",
            failureCode: "timeout",
            durationMs: 50,
        },
    ]);
});

test("repeated and cleared pending operations emit terminal cancellation", () => {
    const { events, telemetry } = recorder();
    let current = 1_000;
    const tracker = createPendingOperationTracker({
        telemetry,
        operation: "deployment_verification",
        source: "session_idle",
        resourceKind: "agent",
        now: () => current,
    });

    assert.equal(tracker.start("canvas-1"), true);
    current = 1_025;
    assert.equal(tracker.start("canvas-1"), true);
    current = 1_050;
    assert.equal(tracker.finish("canvas-1", "succeeded"), true);

    current = 2_000;
    assert.equal(tracker.start("canvas-2"), true);
    current = 2_010;
    assert.equal(tracker.clear("canvas-2"), true);

    assert.deepEqual(events, [
        {
            operation: "deployment_verification",
            source: "session_idle",
            resourceKind: "agent",
            outcome: "cancelled",
            failureCode: "cancelled",
            durationMs: 25,
        },
        {
            operation: "deployment_verification",
            source: "session_idle",
            resourceKind: "agent",
            outcome: "succeeded",
            durationMs: 25,
        },
        {
            operation: "deployment_verification",
            source: "session_idle",
            resourceKind: "agent",
            outcome: "cancelled",
            failureCode: "cancelled",
            durationMs: 10,
        },
    ]);
});

test("Foundry skill outcomes distinguish successful sync from usable stale fallback", () => {
    assert.deepEqual(foundrySkillOperation({
        ok: true,
        action: "install",
        previousStatus: "missing",
        changed: true,
        ready: true,
        reloaded: true,
    }), {
        operation: "foundry_skill_sync",
        outcome: "succeeded",
        source: "automatic",
        skillAction: "install",
        previousStatus: "missing",
        changed: true,
        ready: true,
        reloaded: true,
    });

    assert.deepEqual(foundrySkillOperation({
        ok: false,
        action: "update",
        previousStatus: "outdated",
        changed: false,
        ready: true,
        reloaded: false,
    }), {
        operation: "foundry_skill_sync",
        outcome: "failed",
        failureCode: "install_failed",
        source: "automatic",
        skillAction: "update",
        previousStatus: "outdated",
        changed: false,
        ready: true,
        reloaded: false,
    });
});

test("deployment success requires a live deployed version", () => {
    assert.deepEqual(deploymentVerificationOutcome({
        ok: true,
        deployed: true,
        version: "3",
    }), { outcome: "succeeded" });
    assert.deepEqual(deploymentVerificationOutcome({
        ok: true,
        deployed: true,
        version: "",
    }), {
        outcome: "failed",
        failureCode: "unknown",
    });
    assert.deepEqual(deploymentVerificationOutcome({
        ok: true,
        deployed: false,
        reason: "creating",
    }), { outcome: "unknown" });
    assert.deepEqual(pendingDeploymentOutcome({
        outcome: "timed_out",
        failureCode: "timeout",
        result: { ok: true, deployed: false, reason: "creating" },
    }), {
        outcome: "timed_out",
        failureCode: "timeout",
    });
});
