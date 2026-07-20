import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRequestHandler } from "../src/routes.mjs";
import { createWorkspaceRootResolver } from "../src/workspace-root.mjs";

async function testDirectory(t) {
    const root = await mkdtemp(join(tmpdir(), "foundry-agent-canvas-root-"));
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
    const extensionDir = join(root, "Users", "test", ".copilot", "extensions", "foundry-agent-canvas");
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
    const extensionDir = join(root, ".copilot", "session-state", "session-id", "extensions", "foundry-agent-canvas");
    const cwd = join(root, "workspace");
    await mkdir(extensionDir, { recursive: true });

    const workspaceRoot = createWorkspaceRootResolver({ extensionDir, fallbackCwd: join(root, "wrong-cwd") });
    workspaceRoot.update({ cwd });

    assert.equal(workspaceRoot.resolve(), cwd);
});

test("falls back to the repository for a project-scoped extension", async (t) => {
    const root = await testDirectory(t);
    const extensionDir = join(root, ".github", "extensions", "foundry-agent-canvas");
    await mkdir(extensionDir, { recursive: true });

    const workspaceRoot = createWorkspaceRootResolver({ extensionDir, fallbackCwd: join(root, "wrong-cwd") });

    assert.equal(workspaceRoot.resolve(), root);
});

test("project init scans the active workspace for a user-scoped extension", async (t) => {
    const root = await testDirectory(t);
    const extensionDir = join(root, "Users", "test", ".copilot", "extensions", "foundry-agent-canvas");
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
    workspaceRoot.update({ cwd, gitRoot: workspace });
    const handler = createRequestHandler("test-instance", {
        session: {},
        publicDir: "",
        extDir: extensionDir,
        inspectorUiDir: "",
        workspaceRootFn: workspaceRoot.resolve,
    });
    const response = jsonResponse();

    await handler({ method: "GET", url: "/api/project-init" }, response);

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
    });
});
