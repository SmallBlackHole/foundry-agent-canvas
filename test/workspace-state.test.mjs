import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

import { createRequestHandler } from "../src/routes.mjs";
import { servers } from "../src/state.mjs";
import {
    cancelWorkspaceStateMonitor,
    flushPendingWorkspaceState,
    refreshWorkspaceState,
    startWorkspaceStateMonitor,
} from "../src/workspace-state.mjs";

async function testDirectory(t) {
    const root = await mkdtemp(join(tmpdir(), "foundry-agent-canvas-state-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}

function entryWithFrames() {
    const frames = [];
    return {
        entry: {
            sseClients: new Set([
                {
                    write(frame) {
                        frames.push(frame);
                    },
                },
            ]),
        },
        frames,
    };
}

test("workspace inspection reports no transition before an agent exists", async (t) => {
    const root = await testDirectory(t);
    const { entry, frames } = entryWithFrames();

    const result = await refreshWorkspaceState(entry, async () => root);

    assert.equal(result.hasAgent, false);
    assert.equal(result.transitioned, false);
    assert.deepEqual(result.sections, {
        initOpen: true,
        resourcesOpen: false,
        deployOpen: false,
    });
    assert.deepEqual(frames, []);
});

test("workspace inspection finds a nested hosted-agent manifest", async (t) => {
    const root = await testDirectory(t);
    const agentDir = join(root, "samples", "nested-agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
        join(agentDir, "azure.yaml"),
        ["services:", "  nested-agent:", "    project: src/agent", "    host: azure.ai.agent", ""].join("\n"),
    );
    const { entry } = entryWithFrames();

    const result = await refreshWorkspaceState(entry, async () => root);

    assert.equal(result.hasAgent, true);
    assert.equal(result.transitioned, true);
    assert.equal(result.manifestPath, join(agentDir, "azure.yaml"));
});

test("workspace transition reaches the live client once even when it connects late", async () => {
    const entry = { sseClients: new Set() };
    const frames = [];
    const inspectWorkspace = async () => ({ hasAzure: true, hasAgent: true, manifestPath: "nested/azure.yaml" });

    const first = await refreshWorkspaceState(entry, async () => "workspace", { inspectWorkspace });
    const duplicate = await refreshWorkspaceState(entry, async () => "workspace", { inspectWorkspace });
    const delivered = flushPendingWorkspaceState(entry, {
        write(frame) {
            frames.push(frame);
        },
    });

    assert.equal(first.transitioned, true);
    assert.equal(duplicate.transitioned, false);
    assert.equal(delivered, true);
    assert.equal(frames.length, 1);
    assert.equal(entry.pendingWorkspaceStateFrame, null);
    assert.deepEqual(JSON.parse(frames[0].slice("data: ".length)), {
        type: "workspaceState",
        source: "monitor",
        hasAzure: true,
        hasAgent: true,
        initialized: true,
        manifestPath: "nested/azure.yaml",
        sections: {
            initOpen: false,
            resourcesOpen: true,
            deployOpen: true,
        },
    });
});

test("workspace transition is retained when every connected SSE client is stale", async () => {
    const entry = {
        sseClients: new Set([
            {
                write() {
                    throw new Error("stale client");
                },
            },
        ]),
    };
    const result = await refreshWorkspaceState(entry, async () => "workspace", {
        inspectWorkspace: async () => ({ hasAzure: true, hasAgent: true, manifestPath: "agent/azure.yaml" }),
    });
    const frames = [];

    assert.equal(result.transitioned, true);
    assert.ok(entry.pendingWorkspaceStateFrame);
    assert.equal(
        flushPendingWorkspaceState(entry, {
            write(frame) {
                frames.push(frame);
            },
        }),
        true,
    );
    assert.equal(frames.length, 1);
});

test("SPA applies live workspace-state frames to the visible sections", async () => {
    const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
    const functionSource = source.match(/function applyWorkspaceTransition\(info\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(functionSource);
    assert.match(source, /msg\.type === "workspaceState"\) applyWorkspaceTransition\(msg\)/);
    const calls = [];
    const context = {
        info: {
            hasAgent: true,
            sections: { initOpen: false, resourcesOpen: true, deployOpen: true },
        },
        applyInitDefaults(value) {
            calls.push(["sections", value.sections]);
        },
        renderInit() {
            calls.push(["init"]);
        },
        renderFolds() {
            calls.push(["folds"]);
        },
    };

    vm.runInNewContext(`${functionSource}\nresult = applyWorkspaceTransition(info);`, context);

    assert.equal(context.result, true);
    assert.deepEqual(calls, [
        ["sections", context.info.sections],
        ["init"],
        ["folds"],
    ]);
});

test("bounded polling detects creation when filesystem watching is unavailable", async () => {
    const { entry, frames } = entryWithFrames();
    let checks = 0;
    const inspectWorkspace = async () => {
        checks += 1;
        return {
            hasAzure: checks >= 2,
            hasAgent: checks >= 2,
            manifestPath: checks >= 2 ? "agent/azure.yaml" : "",
        };
    };
    const controller = startWorkspaceStateMonitor(
        entry,
        (source) =>
            refreshWorkspaceState(entry, async () => "workspace", {
                inspectWorkspace,
                source,
            }),
        {
            workspaceRoot: "workspace",
            intervalMs: 0,
            maxAttempts: 3,
            watchFactory() {
                throw new Error("watch unavailable");
            },
        },
    );

    const result = await controller.promise;

    assert.equal(checks, 2);
    assert.equal(result.transitioned, true);
    assert.equal(frames.length, 1);
    assert.equal(JSON.parse(frames[0].slice("data: ".length)).source, "poll");
    assert.equal(entry.workspaceStateMonitor, null);
});

test("recursive watcher detects an agent created in a nested folder", async (t) => {
    const root = await testDirectory(t);
    const { entry, frames } = entryWithFrames();
    let notifyChange;
    let watcherClosed = false;
    const controller = startWorkspaceStateMonitor(
        entry,
        (source) => refreshWorkspaceState(entry, async () => root, { source }),
        {
            workspaceRoot: root,
            intervalMs: 60_000,
            debounceMs: 0,
            watchFactory(watchedRoot, options, listener) {
                assert.equal(watchedRoot, root);
                assert.equal(options.recursive, true);
                notifyChange = listener;
                return {
                    close() {
                        watcherClosed = true;
                    },
                    on() {},
                };
            },
        },
    );
    await new Promise((resolve) => setImmediate(resolve));
    const agentDir = join(root, "generated", "agents", "nested");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
        join(agentDir, "azure.yaml"),
        ["services:", "  nested:", "    host: azure.ai.agent", ""].join("\n"),
    );

    notifyChange();
    const result = await controller.promise;

    assert.equal(result.hasAgent, true);
    assert.equal(result.manifestPath, join(agentDir, "azure.yaml"));
    assert.equal(watcherClosed, true);
    assert.equal(frames.length, 1);
    assert.equal(JSON.parse(frames[0].slice("data: ".length)).source, "watch");
});

test("canceling the monitor closes its recursive watcher", async () => {
    const entry = { sseClients: new Set() };
    let watcherClosed = false;
    const controller = startWorkspaceStateMonitor(
        entry,
        async (source) => ({ source, hasAgent: false }),
        {
            workspaceRoot: "workspace",
            intervalMs: 60_000,
            watchFactory() {
                return {
                    close() {
                        watcherClosed = true;
                    },
                    on() {},
                };
            },
        },
    );

    assert.equal(cancelWorkspaceStateMonitor(entry), true);
    assert.equal(await controller.promise, null);
    assert.equal(watcherClosed, true);
    assert.equal(controller.watcher, null);
    assert.equal(controller.debounceTimer, null);
    assert.equal(controller.pollTimer, null);
    assert.equal(entry.workspaceStateMonitor, null);
});

test("monitor timeout releases its watcher and timer handles", async () => {
    const entry = { sseClients: new Set() };
    let watcherClosed = false;
    const controller = startWorkspaceStateMonitor(
        entry,
        async (source) => ({ source, hasAgent: false }),
        {
            workspaceRoot: "workspace",
            intervalMs: 60_000,
            maxAttempts: 1,
            watchFactory() {
                return {
                    close() {
                        watcherClosed = true;
                    },
                    on() {},
                };
            },
        },
    );

    assert.equal((await controller.promise).hasAgent, false);
    assert.equal(watcherClosed, true);
    assert.equal(controller.watcher, null);
    assert.equal(controller.debounceTimer, null);
    assert.equal(controller.pollTimer, null);
    assert.equal(entry.workspaceStateMonitor, null);
});

test("starting a replacement monitor closes the previous watcher", async () => {
    const entry = { sseClients: new Set() };
    const closed = [];
    const options = (id) => ({
        workspaceRoot: "workspace",
        intervalMs: 60_000,
        watchFactory() {
            return {
                close() {
                    closed.push(id);
                },
                on() {},
            };
        },
    });
    const first = startWorkspaceStateMonitor(
        entry,
        async (source) => ({ source, hasAgent: false }),
        options("first"),
    );
    const second = startWorkspaceStateMonitor(
        entry,
        async (source) => ({ source, hasAgent: false }),
        options("second"),
    );

    assert.equal(await first.promise, null);
    assert.deepEqual(closed, ["first"]);
    cancelWorkspaceStateMonitor(entry);
    assert.equal(await second.promise, null);
    assert.deepEqual(closed, ["first", "second"]);
});

test("watcher errors close the watcher while bounded polling remains active", async () => {
    const entry = { sseClients: new Set() };
    let emitError;
    let watcherClosed = false;
    const controller = startWorkspaceStateMonitor(
        entry,
        async (source) => ({ source, hasAgent: false }),
        {
            workspaceRoot: "workspace",
            intervalMs: 60_000,
            watchFactory() {
                return {
                    close() {
                        watcherClosed = true;
                    },
                    on(event, handler) {
                        if (event === "error") emitError = handler;
                    },
                };
            },
        },
    );

    emitError(new Error("watch failed"));

    assert.equal(watcherClosed, true);
    assert.equal(controller.watcher, null);
    assert.equal(entry.workspaceStateMonitor, controller);
    cancelWorkspaceStateMonitor(entry);
    assert.equal(await controller.promise, null);
});

test("canceling during an in-flight scan prevents a late canvas transition", async () => {
    const { entry, frames } = entryWithFrames();
    let releaseInspection;
    let markInspectionStarted;
    let markInspectionDone;
    const inspectionStarted = new Promise((resolve) => {
        markInspectionStarted = resolve;
    });
    const inspectionDone = new Promise((resolve) => {
        markInspectionDone = resolve;
    });
    const inspection = new Promise((resolve) => {
        releaseInspection = resolve;
    });
    const controller = startWorkspaceStateMonitor(
        entry,
        async (source, isActive) => {
            try {
                return await refreshWorkspaceState(entry, async () => "workspace", {
                    inspectWorkspace: async () => {
                        markInspectionStarted();
                        return inspection;
                    },
                    isActive,
                    source,
                });
            } finally {
                markInspectionDone();
            }
        },
        {
            workspaceRoot: "workspace",
            intervalMs: 60_000,
            watchFactory() {
                return { close() {}, on() {} };
            },
        },
    );
    await inspectionStarted;

    cancelWorkspaceStateMonitor(entry);
    releaseInspection({ hasAzure: true, hasAgent: true, manifestPath: "nested/azure.yaml" });
    await controller.promise;
    await inspectionDone;

    assert.equal(entry.workspaceStateTransitioned, false);
    assert.equal(entry.pendingWorkspaceStateFrame, null);
    assert.equal(frames.length, 0);
});

test("creation flow forwards the original prompt unchanged", async (t) => {
    const root = await testDirectory(t);
    const instanceId = "prompt-test-instance";
    const entry = { state: {}, sseClients: new Set() };
    servers.set(instanceId, entry);
    t.after(() => {
        cancelWorkspaceStateMonitor(entry);
        servers.delete(instanceId);
    });
    let sentPrompt = "";
    const handler = createRequestHandler(instanceId, {
        session: {
            send: async ({ prompt }) => {
                sentPrompt = prompt;
            },
            log: async () => {},
        },
        publicDir: "",
        extDir: "",
        inspectorUiDir: "",
        workspaceRootFn: async () => root,
        waitForFoundrySkill: async () => {},
    });
    const originalPrompt = "Create a hosted agent in a nested sample folder.";
    const request = Readable.from([JSON.stringify({ prompt: originalPrompt, creationFlow: true })]);
    request.method = "POST";
    request.url = "/api/send";
    const response = {
        status: 0,
        body: "",
        writeHead(status) {
            this.status = status;
        },
        end(body) {
            this.body = body;
        },
    };

    await handler(request, response);

    assert.equal(response.status, 200);
    assert.equal(sentPrompt, originalPrompt);
    assert.ok(entry.workspaceStateMonitor);
});
