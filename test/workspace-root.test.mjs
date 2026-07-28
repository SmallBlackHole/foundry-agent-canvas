import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRequestHandler } from "../src/routes.mjs";
import { createWorkspaceRootResolver, initializeWorkspaceRoot } from "../src/workspace-root.mjs";

async function testDirectory(t) {
    const root = await mkdtemp(join(tmpdir(), "microsoft-foundry-root-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}

function jsonResponse() {
    return {
        body: "",
        status: 0,
        writeHead(status) {
            this.status = status;
        },
        end(body) {
            this.body = body;
        },
    };
}

test("prefers the active git root for a user-scoped extension", async (t) => {
    const root = await testDirectory(t);
    const extensionDir = join(root, "Users", "test", ".copilot", "extensions", "microsoft-foundry");
    const cwd = join(root, "workspace", "task-agent");
    const gitRoot = join(root, "workspace");
    await mkdir(extensionDir, { recursive: true });

    const workspaceRoot = createWorkspaceRootResolver({
        extensionDir,
        fallbackCwd: join(root, "wrong-cwd"),
    });
    workspaceRoot.update({ cwd, gitRoot });

    assert.equal(workspaceRoot.resolve(), gitRoot);
});

test("uses the active cwd when a session-scoped extension has no git root", async (t) => {
    const root = await testDirectory(t);
    const extensionDir = join(root, ".copilot", "session-state", "session-id", "extensions", "microsoft-foundry");
    const cwd = join(root, "workspace");
    await mkdir(extensionDir, { recursive: true });

    const workspaceRoot = createWorkspaceRootResolver({ extensionDir, fallbackCwd: join(root, "wrong-cwd") });
    workspaceRoot.update({ cwd });

    assert.equal(workspaceRoot.resolve(), cwd);
});

test("prefers the active workspace for a plugin-contributed extension", async (t) => {
    const root = await testDirectory(t);
    const extensionDir = join(root, "installed-plugin", "canvas-extension");
    const workspace = join(root, "workspace");
    await mkdir(extensionDir, { recursive: true });

    const workspaceRoot = createWorkspaceRootResolver({
        extensionDir,
        fallbackCwd: join(root, "plugin-process-cwd"),
    });
    workspaceRoot.update({ cwd: join(workspace, "task-agent"), gitRoot: workspace });

    assert.equal(workspaceRoot.resolve(), workspace);
});

test("falls back to the repository for a project-scoped extension", async (t) => {
    const root = await testDirectory(t);
    const extensionDir = join(root, ".github", "extensions", "microsoft-foundry");
    await mkdir(extensionDir, { recursive: true });

    const workspaceRoot = createWorkspaceRootResolver({ extensionDir, fallbackCwd: join(root, "wrong-cwd") });

    assert.equal(workspaceRoot.resolve(), root);
});

test("prefers the metadata snapshot when persisted context is stale", async (t) => {
    const root = await testDirectory(t);
    const currentWorkspace = join(root, "current-workspace");
    const staleWorkspace = join(root, "stale-workspace");
    const workspaceRoot = createWorkspaceRootResolver({ fallbackCwd: join(root, "wrong-cwd") });
    const session = {
        getEvents: async () => [
            {
                type: "session.start",
                data: { context: { cwd: staleWorkspace, gitRoot: staleWorkspace } },
            },
        ],
        on: () => () => {},
        rpc: {
            metadata: {
                snapshot: async () => ({ workingDirectory: currentWorkspace }),
            },
        },
    };

    await initializeWorkspaceRoot(session, workspaceRoot);

    assert.equal(workspaceRoot.resolve(), currentWorkspace);
});

test("keeps a live context change received during reload hydration", async (t) => {
    const root = await testDirectory(t);
    const liveWorkspace = join(root, "live-workspace");
    const staleWorkspace = join(root, "stale-workspace");
    const workspaceRoot = createWorkspaceRootResolver({ fallbackCwd: join(root, "wrong-cwd") });
    let contextChanged;
    let releaseSnapshot;
    const snapshot = new Promise((resolve) => {
        releaseSnapshot = resolve;
    });
    const session = {
        getEvents: async () => [],
        on: (eventType, handler) => {
            if (eventType === "session.context_changed") contextChanged = handler;
            return () => {};
        },
        rpc: {
            metadata: {
                snapshot: async () => snapshot,
            },
        },
    };

    const initialization = initializeWorkspaceRoot(session, workspaceRoot);
    contextChanged({ data: { cwd: liveWorkspace, gitRoot: liveWorkspace } });
    releaseSnapshot({ workingDirectory: staleWorkspace });
    await initialization;

    assert.equal(workspaceRoot.resolve(), liveWorkspace);
});

test("project init resolves a reloaded user extension before another prompt", async (t) => {
    const root = await testDirectory(t);
    const extensionDir = join(root, "Users", "test", ".copilot", "extensions", "microsoft-foundry");
    const workspace = join(root, "hosted-agent-sample");
    const cwd = join(workspace, "task-agent");
    const agentDir = join(cwd, "agent-framework-agent-basic-responses");
    await mkdir(extensionDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(
        join(agentDir, "azure.yaml"),
        [
            "name: agent-framework-agent-basic-responses",
            "services:",
            "  agent-framework-agent-basic-responses:",
            "    project: src/agent",
            "    host: azure.ai.agent",
            "    language: python",
            "",
        ].join("\n"),
    );

    const workspaceRoot = createWorkspaceRootResolver({
        extensionDir,
        fallbackCwd: join(root, "wrong-cwd"),
    });
    let releaseSnapshot;
    const snapshot = new Promise((resolve) => {
        releaseSnapshot = resolve;
    });
    const session = {
        getEvents: async () => [
            {
                type: "session.start",
                data: { context: { cwd, gitRoot: workspace } },
            },
        ],
        on: () => () => {},
        rpc: {
            metadata: {
                snapshot: async () => snapshot,
            },
        },
    };
    const workspaceRootReady = initializeWorkspaceRoot(session, workspaceRoot);
    const handler = createRequestHandler("test-instance", {
        session,
        publicDir: "",
        extDir: extensionDir,
        inspectorUiDir: "",
        workspaceRootFn: async () => {
            await workspaceRootReady;
            return workspaceRoot.resolve();
        },
    });
    const response = jsonResponse();

    const request = handler({ method: "GET", url: "/api/project-init" }, response);
    releaseSnapshot({ workingDirectory: cwd });
    await request;

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), {
        ok: true,
        hasAzure: true,
        hasAgent: true,
        initialized: true,
        sections: {
            initOpen: false,
            resourcesOpen: true,
            deployOpen: true,
        },
        selected: "agent-framework-agent-basic-responses",
        agents: [
            {
                agentName: "agent-framework-agent-basic-responses",
                manifestPath: join(agentDir, "azure.yaml"),
                projectDir: agentDir,
            },
        ],
    });
});
