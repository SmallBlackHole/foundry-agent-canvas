import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findHostedAgentManifest, inspectHostedAgentWorkspace } from "../src/local-agent.mjs";

async function testWorkspace(t) {
    const root = await mkdtemp(join(tmpdir(), "foundry-agent-canvas-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}

test("finds an agent manifest in a nested workspace folder", async (t) => {
    const root = await testWorkspace(t);
    const nested = join(root, "apps", "customer-support", "agent");
    await mkdir(nested, { recursive: true });
    const manifest = join(nested, "agent.yaml");
    await writeFile(manifest, "name: customer-support\n");

    assert.equal(await findHostedAgentManifest(root), manifest);
});

test("preserves root-level agent.yml detection", async (t) => {
    const root = await testWorkspace(t);
    const manifest = join(root, "agent.yml");
    await writeFile(manifest, "name: root-agent\n");

    assert.equal(await findHostedAgentManifest(root), manifest);
});

test("detects a hosted agent from a nested azure.ai.agent service", async (t) => {
    const root = await testWorkspace(t);
    const nested = join(root, "hello-agent", "agent-framework-agent-basic-responses");
    await mkdir(nested, { recursive: true });
    const manifest = join(nested, "azure.yaml");
    await writeFile(
        manifest,
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

    assert.deepEqual(await inspectHostedAgentWorkspace(root), {
        hasAzure: true,
        hasAgent: true,
        manifestPath: manifest,
    });
});

test("does not treat a generic nested azure project as a hosted agent", async (t) => {
    const root = await testWorkspace(t);
    const nested = join(root, "apps", "web");
    await mkdir(nested, { recursive: true });
    await writeFile(
        join(nested, "azure.yaml"),
        [
            "name: web-app",
            "services:",
            "  web:",
            "    project: src",
            "    host: appservice",
            "    language: js",
            "",
        ].join("\n"),
    );

    assert.deepEqual(await inspectHostedAgentWorkspace(root), {
        hasAzure: true,
        hasAgent: false,
        manifestPath: "",
    });
});

test("returns no manifest when the workspace has no hosted agent", async (t) => {
    const root = await testWorkspace(t);
    await mkdir(join(root, "apps", "empty"), { recursive: true });

    assert.equal(await findHostedAgentManifest(root), "");
});

test("ignores manifests inside generated and vendor directories", async (t) => {
    const root = await testWorkspace(t);
    for (const dir of [".git", ".pnpm-store", "dist", "node_modules"]) {
        const nested = join(root, dir, "nested");
        await mkdir(nested, { recursive: true });
        await writeFile(join(nested, "agent.yml"), "name: ignored\n");
    }

    assert.equal(await findHostedAgentManifest(root), "");
});
