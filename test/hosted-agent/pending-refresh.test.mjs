import assert from "node:assert/strict";
import test from "node:test";

import {
    createPendingRefreshManager,
    DEPLOYMENT_REFRESH,
} from "../../src/hosted-agent/pending-refresh.mjs";

function aliveEntry(id = "canvas-1") {
    return { id, server: { listening: true }, sseClients: new Set() };
}

function managerWith(overrides = {}) {
    const logs = [];
    const terminals = [];
    const servers = overrides.servers || new Map();
    const manager = createPendingRefreshManager({
        servers,
        inspectDeployment: overrides.inspectDeployment || (async () => ({ ok: true, deployed: false, reason: "not_deployed" })),
        refreshDeployment: overrides.refreshDeployment || (async () => ({})),
        log: async (message, options) => logs.push({ message, options }),
        onTerminal: overrides.onTerminal
            || (async (...args) => terminals.push(args)),
        maxAttempts: overrides.maxAttempts ?? 12,
    });
    return { manager, servers, logs, terminals };
}

test("mark ignores unknown kinds and empty instance ids", () => {
    const { manager } = managerWith();
    assert.equal(manager.mark("", DEPLOYMENT_REFRESH), false);
    assert.equal(manager.mark("canvas-1", "bogus"), false);
    assert.equal(manager.hasPending(), false);
    assert.equal(manager.mark("canvas-1", DEPLOYMENT_REFRESH), true);
    assert.equal(manager.hasPending(), true);
});

test("idle with no pending work does nothing", async () => {
    const servers = new Map();
    let inspected = 0;
    const { manager } = managerWith({
        servers,
        inspectDeployment: async () => {
            inspected += 1;
            return { ok: true, deployed: true };
        },
    });
    await manager.handleSessionIdle();
    assert.equal(inspected, 0);
});

test("intermediate idle states keep the deployment pending without pushing a frame", async () => {
    const servers = new Map([["canvas-1", aliveEntry()]]);
    let pushed = 0;
    const { manager } = managerWith({
        servers,
        inspectDeployment: async () => ({ ok: true, deployed: false, reason: "creating" }),
        refreshDeployment: async () => {
            pushed += 1;
            return {};
        },
    });

    manager.mark("canvas-1", DEPLOYMENT_REFRESH);
    await manager.handleSessionIdle();

    assert.equal(pushed, 0);
    assert.equal(manager.hasPending(), true);
});

test("deployment refresh pushes the verified result once and reuses it", async () => {
    const servers = new Map([["canvas-1", aliveEntry()]]);
    const deployment = { ok: true, deployed: true, available: true, portalUrl: "https://ai.azure.com/x", version: "3" };
    let inspections = 0;
    let pushedDeployment = null;
    const { manager } = managerWith({
        servers,
        inspectDeployment: async () => {
            inspections += 1;
            return deployment;
        },
        refreshDeployment: async (_entry, inspect) => {
            // The manager must reuse the already-fetched result, not query again.
            pushedDeployment = await inspect();
            return pushedDeployment;
        },
    });

    manager.mark("canvas-1", DEPLOYMENT_REFRESH);
    await manager.handleSessionIdle();

    assert.equal(inspections, 1);
    assert.equal(pushedDeployment, deployment);
    assert.equal(manager.hasPending(), false);
});

test("deployment refresh stops on a definitive failure reason", async () => {
    const servers = new Map([["canvas-1", aliveEntry()]]);
    let pushed = 0;
    const { manager, logs } = managerWith({
        servers,
        inspectDeployment: async () => ({ ok: true, deployed: false, reason: "failed" }),
        refreshDeployment: async () => {
            pushed += 1;
        },
    });

    manager.mark("canvas-1", DEPLOYMENT_REFRESH);
    await manager.handleSessionIdle();

    assert.equal(pushed, 0);
    assert.equal(manager.hasPending(), false);
    assert.ok(logs.some((l) => /failed/.test(l.message)));
});

test("pending work is bounded by the attempt budget", async () => {
    const servers = new Map([["canvas-1", aliveEntry()]]);
    let calls = 0;
    const { manager, logs } = managerWith({
        servers,
        maxAttempts: 3,
        inspectDeployment: async () => {
            calls += 1;
            return { ok: true, deployed: false, reason: "creating" };
        },
    });

    manager.mark("canvas-1", DEPLOYMENT_REFRESH);
    for (let i = 0; i < 5; i += 1) await manager.handleSessionIdle();

    assert.equal(calls, 3);
    assert.equal(manager.hasPending(), false);
    assert.ok(logs.some((l) =>
        /gave up/.test(l.message) && l.options?.level === "warning"));
});

test("stale (closed) canvas instances are dropped without running a refresh", async () => {
    const servers = new Map([["canvas-1", { server: { listening: false } }]]);
    let calls = 0;
    const { manager, terminals } = managerWith({
        servers,
        inspectDeployment: async () => {
            calls += 1;
            return { ok: true, deployed: true };
        },
    });

    manager.mark("canvas-1", DEPLOYMENT_REFRESH);
    await manager.handleSessionIdle();

    assert.equal(calls, 0);
    assert.equal(manager.hasPending(), false);
    assert.deepEqual(terminals, [[
        "canvas-1",
        DEPLOYMENT_REFRESH,
        { outcome: "cancelled", failureCode: "cancelled" },
    ]]);
});

test("a missing canvas entry is treated as stale and cleared", async () => {
    const servers = new Map();
    let calls = 0;
    const { manager, terminals } = managerWith({
        servers,
        inspectDeployment: async () => {
            calls += 1;
            return { ok: true, deployed: true };
        },
    });

    manager.mark("canvas-1", DEPLOYMENT_REFRESH);
    await manager.handleSessionIdle();

    assert.equal(calls, 0);
    assert.equal(manager.hasPending(), false);
    assert.deepEqual(terminals, [[
        "canvas-1",
        DEPLOYMENT_REFRESH,
        { outcome: "cancelled", failureCode: "cancelled" },
    ]]);
});

test("a refresh failure is logged and never rejects the idle handler", async () => {
    const servers = new Map([["canvas-1", aliveEntry()]]);
    const { manager, logs } = managerWith({
        servers,
        maxAttempts: 1,
        inspectDeployment: async () => {
            throw new Error("boom");
        },
    });

    manager.mark("canvas-1", DEPLOYMENT_REFRESH);
    await assert.doesNotReject(manager.handleSessionIdle());

    assert.ok(logs.some((l) => /boom/.test(l.message) && l.options?.level === "error"));
    // Budget of 1 exhausted after the failed attempt, so pending is cleared.
    assert.equal(manager.hasPending(), false);
});

test("an in-flight op is not started concurrently by a second idle", async () => {
    const servers = new Map([["canvas-1", aliveEntry()]]);
    let active = 0;
    let maxActive = 0;
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    const { manager } = managerWith({
        servers,
        inspectDeployment: async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await gate;
            active -= 1;
            return { ok: true, deployed: false, reason: "creating" };
        },
    });

    manager.mark("canvas-1", DEPLOYMENT_REFRESH);
    const first = manager.handleSessionIdle();
    // Second idle arrives while the first refresh is still awaiting.
    const second = manager.handleSessionIdle();
    release();
    await Promise.all([first, second]);

    assert.equal(maxActive, 1);
});

test("an in-flight deployment cannot complete a newer marked attempt", async () => {
    const servers = new Map([["canvas-1", aliveEntry()]]);
    const deployments = [
        { ok: true, deployed: true, version: "1" },
        { ok: true, deployed: true, version: "2" },
    ];
    const terminals = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => {
        releaseFirst = resolve;
    });
    let calls = 0;
    const { manager } = managerWith({
        servers,
        inspectDeployment: async () => {
            const deployment = deployments[calls];
            calls += 1;
            if (calls === 1) await firstGate;
            return deployment;
        },
        onTerminal: async (...args) => terminals.push(args),
    });

    manager.mark("canvas-1", DEPLOYMENT_REFRESH);
    const firstIdle = manager.handleSessionIdle();
    manager.mark("canvas-1", DEPLOYMENT_REFRESH);
    releaseFirst();
    await firstIdle;

    assert.equal(manager.hasPending(), true);
    assert.deepEqual(terminals, []);

    await manager.handleSessionIdle();
    assert.equal(manager.hasPending(), false);
    assert.equal(calls, 2);
    assert.deepEqual(terminals, [[
        "canvas-1",
        DEPLOYMENT_REFRESH,
        {
            outcome: "succeeded",
            result: deployments[1],
        },
    ]]);
});
