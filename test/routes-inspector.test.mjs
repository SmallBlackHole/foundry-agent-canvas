import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeApiServices } from "../src/routes.mjs";

test("resolves the hosted agent project when Inspect locally is clicked", async () => {
    const calls = [];
    const project = {
        projectDir: "C:\\workspace\\apps\\support",
        manifestPath: "C:\\workspace\\apps\\support\\azure.yaml",
        projects: [],
    };
    const session = { log: async () => {}, send: async () => {} };
    const services = createRuntimeApiServices("inspect-project-test", {
        session,
        inspectorUiDir: "inspector-ui",
        workspaceRootFn: async () => "C:\\workspace",
        localInspector: {
            async resolveProject(root) {
                calls.push(["resolve", root]);
                return project;
            },
            async ensureProxy(directory) {
                calls.push(["proxy", directory]);
                return "http://127.0.0.1:1234";
            },
            async launchTerminal(currentSession, selectedProject) {
                calls.push(["launch", currentSession, selectedProject]);
                return { ok: true, status: "launched" };
            },
        },
    });

    assert.deepEqual(await services.startInspector(), {
        ok: true,
        url: "http://127.0.0.1:1234",
        terminal: { ok: true, status: "launched" },
    });
    assert.deepEqual(calls, [
        ["resolve", "C:\\workspace"],
        ["proxy", "inspector-ui"],
        ["launch", session, project],
    ]);
});
