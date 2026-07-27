import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
            async launchTerminal(currentSession, selectedProject, options) {
                calls.push(["launch", currentSession, selectedProject, options]);
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
