import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createRuntimeApiServices } from "../src/api/index.mjs";
import { servers } from "../src/state.mjs";

test("resolves the hosted agent project when Inspect locally is clicked", async () => {
    const calls = [];
    const project = {
        projectDir: "C:\\workspace\\apps\\support",
        manifestPath: "C:\\workspace\\apps\\support\\azure.yaml",
        projects: [],
    };
    const agents = [
        { agentName: "support-agent", projectDir: project.projectDir, manifestPath: project.manifestPath, agentType: "hosted" },
        { agentName: "research-agent", projectDir: "C:\\workspace\\apps\\research", manifestPath: "", agentType: "hosted" },
    ];
    const session = { log: async () => {}, send: async () => {} };
    const services = createRuntimeApiServices("inspect-project-test", {
        session,
        inspectorUiDir: "inspector-ui",
        workspaceRootFn: async () => "C:\\workspace",
        localInspector: {
            async listAgents(root) {
                calls.push(["list", root]);
                return agents;
            },
            async resolveProject(root, agentName) {
                calls.push(["resolve", root, agentName]);
                return project;
            },
            async ensureProxy(directory) {
                calls.push(["proxy", directory]);
                return "http://127.0.0.1:1234";
            },
            async launchTerminal(currentSession, selectedProject, options) {
                calls.push(["launch", currentSession, selectedProject, options]);
                return { ok: true, status: "launched" };
            },
        },
    });

    // Without an explicit pick the inspector targets the first workspace agent.
    assert.deepEqual(await services.startInspector(), {
        ok: true,
        url: "http://127.0.0.1:1234",
        terminal: { ok: true, status: "launched" },
    });
    assert.deepEqual(calls, [
        ["list", "C:\\workspace"],
        ["resolve", "C:\\workspace", "support-agent"],
        ["proxy", "inspector-ui"],
        // The builder instance id lets the launcher hand focus back after it
        // has forced the terminal to mount.
        ["launch", session, project, { builderInstanceId: "inspect-project-test" }],
    ]);
});

test("relaunching or closing the inspector retires the previous readiness poll", async () => {
    const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

    // Without this, a stale loop's 2-minute deadline fires over a newer launch
    // and reports a timeout for an inspector that is actually fine.
    assert.match(source, /const token = inspectorPollToken;/);
    assert.match(source, /if \(token !== inspectorPollToken\) return;/);
    assert.match(source, /inspectorPollToken \+= 1; \/\/ stop any in-flight readiness poll/);
});

test("lists workspace agents and inspects the one the picker selected", async (t) => {
    const resolved = [];
    const instanceId = "agent-picker-test";
    const agents = [
        { agentName: "support-agent", projectDir: "/w/support", manifestPath: "/w/support/azure.yaml", serviceKey: "support-agent", source: "azure_service_key", agentType: "hosted" },
        { agentName: "research-agent", projectDir: "/w/research", manifestPath: "/w/research/azure.yaml", serviceKey: "research", source: "azure_service_name", agentType: "hosted" },
        { agentName: "operations-agent", projectDir: "/w/operations", manifestPath: "/w/operations/azure.yaml", serviceKey: "operations", source: "azure_service_name", agentType: "managed" },
    ];
    servers.set(instanceId, { state: { agentName: "" } });
    t.after(() => servers.delete(instanceId));
    const services = createRuntimeApiServices(instanceId, {
        session: { log: async () => {}, send: async () => {} },
        inspectorUiDir: "inspector-ui",
        workspaceRootFn: async () => "/w",
        localInspector: {
            listAgents: async () => agents,
            async resolveProject(root, agentName) {
                resolved.push(agentName);
                return { projectDir: `/w/${agentName}`, manifestPath: "", projects: [] };
            },
            ensureProxy: async () => "http://127.0.0.1:1234",
            launchTerminal: async () => ({ ok: true, status: "launched" }),
        },
    });

    assert.deepEqual(await services.listHostedAgents(), {
        ok: true,
        selected: "support-agent",
        agentType: "hosted",
        agents: [
            { agentName: "support-agent", projectDir: "/w/support", manifestPath: "/w/support/azure.yaml", agentType: "hosted" },
            { agentName: "research-agent", projectDir: "/w/research", manifestPath: "/w/research/azure.yaml", agentType: "hosted" },
            { agentName: "operations-agent", projectDir: "/w/operations", manifestPath: "/w/operations/azure.yaml", agentType: "managed" },
        ],
    });

    assert.deepEqual(
        await services.selectHostedAgent({ body: { agentName: " research-agent " } }),
        { ok: true, selected: "research-agent" },
    );
    await services.startInspector();
    assert.deepEqual(resolved, ["research-agent"]);
});
