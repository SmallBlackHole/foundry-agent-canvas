import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    findHostedAgentManifest,
    inspectHostedAgentWorkspace,
    listHostedAgents,
    resolveHostedAgentName,
    resolveHostedAgentProject,
} from "../src/local-agent.mjs";

async function testWorkspace(t) {
    const root = await mkdtemp(join(tmpdir(), "microsoft-foundry-"));
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

test("prefers the root hosted-agent project over nested projects", async (t) => {
    const root = await testWorkspace(t);
    const nested = join(root, "apps", "alpha");
    await mkdir(nested, { recursive: true });
    await writeFile(
        join(root, "azure.yaml"),
        ["services:", "  root-agent:", "    host: azure.ai.agent", ""].join("\n"),
    );
    await writeFile(
        join(nested, "azure.yaml"),
        ["services:", "  nested-agent:", "    host: azure.ai.agent", ""].join("\n"),
    );

    const result = await resolveHostedAgentProject(root);
    assert.equal(result.projectDir, root);
    assert.equal(result.manifestPath, join(root, "azure.yaml"));
    assert.deepEqual(
        result.projects.map(({ projectDir }) => projectDir),
        [root, nested],
    );
});

test("selects nested hosted-agent projects by depth then folder name", async (t) => {
    const root = await testWorkspace(t);
    const alpha = join(root, "apps", "alpha");
    const zeta = join(root, "apps", "zeta");
    const deeper = join(root, "a-first", "nested", "agent");
    for (const directory of [zeta, deeper, alpha]) {
        await mkdir(directory, { recursive: true });
        await writeFile(
            join(directory, "azure.yaml"),
            ["services:", `  ${directory === alpha ? "alpha" : "agent"}:`, "    host: azure.ai.agent", ""].join("\n"),
        );
    }

    const result = await resolveHostedAgentProject(root);
    assert.equal(result.projectDir, alpha);
    assert.deepEqual(
        result.projects.map(({ projectDir }) => projectDir),
        [alpha, zeta, deeper],
    );
});

test("does not use a legacy agent manifest as an azd project", async (t) => {
    const root = await testWorkspace(t);
    await writeFile(join(root, "agent.yaml"), "name: legacy-agent\n");

    assert.deepEqual(await resolveHostedAgentProject(root), {
        projectDir: "",
        manifestPath: "",
        projects: [],
    });
});

test("selects a nested hosted agent when the root azure project is generic", async (t) => {
    const root = await testWorkspace(t);
    const nested = join(root, "apps", "support");
    await mkdir(nested, { recursive: true });
    await writeFile(
        join(root, "azure.yaml"),
        ["services:", "  web:", "    host: appservice", ""].join("\n"),
    );
    await writeFile(
        join(nested, "azure.yaml"),
        ["services:", "  support-agent:", "    host: azure.ai.agent", ""].join("\n"),
    );

    const result = await resolveHostedAgentProject(root);
    assert.equal(result.projectDir, nested);
    assert.equal(result.manifestPath, join(nested, "azure.yaml"));
});

test("resolves the configured hosted agent name from nested azure.yml", async (t) => {
    const root = await testWorkspace(t);
    const nested = join(root, "apps", "customer-support");
    await mkdir(nested, { recursive: true });
    const manifest = join(nested, "azure.yml");
    await writeFile(
        manifest,
        [
            "services:",
            "  customer-support-service:",
            "    host: azure.ai.agent",
            "    name: customer-support-agent",
            "    project: src",
            "",
        ].join("\n"),
    );

    assert.deepEqual(await resolveHostedAgentName(root), {
        agentName: "customer-support-agent",
        ambiguous: false,
        candidates: ["customer-support-agent"],
        manifestPath: manifest,
        projectDir: nested,
        serviceKey: "customer-support-service",
        source: "azure_service_name",
    });
});

test("falls back to the hosted service key when name is missing or parameterized", async (t) => {
    const root = await testWorkspace(t);
    await writeFile(
        join(root, "azure.yaml"),
        [
            "services:",
            "  support-agent:",
            "    host: azure.ai.agent",
            "    name: ${AGENT_NAME}",
            "",
        ].join("\n"),
    );

    const result = await resolveHostedAgentName(root);
    assert.equal(result.agentName, "support-agent");
    assert.equal(result.serviceKey, "support-agent");
    assert.equal(result.source, "azure_service_key");
});

test("explicit canvas input wins over ambiguous workspace services", async (t) => {
    const root = await testWorkspace(t);
    await writeFile(
        join(root, "azure.yaml"),
        [
            "services:",
            "  first-agent:",
            "    host: azure.ai.agent",
            "  second-agent:",
            "    host: azure.ai.agent",
            "",
        ].join("\n"),
    );

    assert.deepEqual(await resolveHostedAgentName(root, "selected-agent"), {
        agentName: "selected-agent",
        ambiguous: false,
        candidates: ["selected-agent"],
        manifestPath: "",
        projectDir: "",
        serviceKey: "",
        source: "canvas_input",
    });
});

test("defaults to the first hosted service and reports the alternatives", async (t) => {
    const root = await testWorkspace(t);
    await writeFile(
        join(root, "azure.yaml"),
        [
            "services:",
            "  first-agent:",
            "    host: azure.ai.agent",
            "  second-agent:",
            "    host: azure.ai.agent",
            "",
        ].join("\n"),
    );

    const result = await resolveHostedAgentName(root);
    assert.equal(result.agentName, "first-agent");
    assert.equal(result.ambiguous, true);
    assert.deepEqual(result.candidates, ["first-agent", "second-agent"]);
});

test("lists every hosted agent with the azd project that runs it", async (t) => {
    const root = await testWorkspace(t);
    const support = join(root, "apps", "support");
    const research = join(root, "apps", "research");
    await mkdir(support, { recursive: true });
    await mkdir(research, { recursive: true });
    await writeFile(
        join(support, "azure.yaml"),
        ["services:", "  support-agent:", "    host: azure.ai.agent", ""].join("\n"),
    );
    await writeFile(
        join(research, "azure.yaml"),
        [
            "services:",
            "  research-service:",
            "    host: azure.ai.agent",
            "    name: research-agent",
            "  web:",
            "    host: appservice",
            "",
        ].join("\n"),
    );

    assert.deepEqual(await listHostedAgents(root), [
        {
            agentName: "research-agent",
            manifestPath: join(research, "azure.yaml"),
            projectDir: research,
            serviceKey: "research-service",
            source: "azure_service_name",
        },
        {
            agentName: "support-agent",
            manifestPath: join(support, "azure.yaml"),
            projectDir: support,
            serviceKey: "support-agent",
            source: "azure_service_key",
        },
    ]);
});

test("lists legacy agent manifests only without a hosted Azure service", async (t) => {
    const root = await testWorkspace(t);
    const manifest = join(root, "agent.yaml");
    await writeFile(manifest, "name: legacy-agent\n");

    assert.deepEqual(await listHostedAgents(root), [
        {
            agentName: "legacy-agent",
            manifestPath: manifest,
            projectDir: "",
            serviceKey: "",
            source: "agent_manifest_name",
        },
    ]);
});

test("runs the azd project that declares the selected hosted agent", async (t) => {
    const root = await testWorkspace(t);
    const alpha = join(root, "apps", "alpha");
    const zeta = join(root, "apps", "zeta");
    await mkdir(alpha, { recursive: true });
    await mkdir(zeta, { recursive: true });
    await writeFile(
        join(alpha, "azure.yaml"),
        ["services:", "  alpha-agent:", "    host: azure.ai.agent", ""].join("\n"),
    );
    await writeFile(
        join(zeta, "azure.yaml"),
        ["services:", "  zeta-service:", "    host: azure.ai.agent", "    name: zeta-agent", ""].join("\n"),
    );

    const selected = await resolveHostedAgentProject(root, "zeta-agent");
    assert.equal(selected.projectDir, zeta);
    assert.equal(selected.manifestPath, join(zeta, "azure.yaml"));

    // An unknown selection falls back to the first project rather than failing.
    assert.equal((await resolveHostedAgentProject(root, "missing-agent")).projectDir, alpha);
    assert.equal((await resolveHostedAgentProject(root)).projectDir, alpha);
});

test("uses a legacy agent manifest name only without a hosted Azure service", async (t) => {
    const root = await testWorkspace(t);
    const manifest = join(root, "agent.yml");
    await writeFile(manifest, "name: legacy-agent\n");
    await writeFile(
        join(root, "azure.yaml"),
        [
            "services:",
            "  web:",
            "    host: appservice",
            "",
        ].join("\n"),
    );

    assert.deepEqual(await resolveHostedAgentName(root), {
        agentName: "legacy-agent",
        ambiguous: false,
        candidates: ["legacy-agent"],
        manifestPath: manifest,
        projectDir: "",
        serviceKey: "",
        source: "agent_manifest_name",
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
