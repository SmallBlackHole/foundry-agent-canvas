import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

import {
    flushPendingWorkspaceState,
    refreshWorkspaceState,
} from "../../src/hosted-agent/workspace-state.mjs";

async function testDirectory(t) {
    const root = await mkdtemp(join(tmpdir(), "microsoft-foundry-state-"));
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
        hasAgent: true,
        sections: {
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
    const source = await readFile(new URL("../../public/app.js", import.meta.url), "utf8");
    const functionSource = source.match(/function applyWorkspaceTransition\(info\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(functionSource);
    assert.match(source, /msg\.type === "workspaceState"\) applyWorkspaceTransition\(msg\)/);
    const calls = [];
    const context = {
        info: {
            hasAgent: true,
            sections: { resourcesOpen: true, deployOpen: true },
        },
        state: {
            init: { open: true },
            folds: { resources: false, deploy: false },
        },
        renderFolds() {
            calls.push(["folds"]);
        },
        loadHostedAgents() {
            calls.push(["agents"]);
        },
    };

    vm.runInNewContext(`${functionSource}\nresult = applyWorkspaceTransition(info);`, context);

    assert.equal(context.result, true);
    assert.equal(context.state.init.open, true);
    assert.deepEqual(context.state.folds, { resources: true, deploy: true });
    assert.deepEqual(calls, [["folds"], ["agents"]]);
});

test("creation prompt no longer asks Copilot to invoke a canvas action", async () => {
    const source = await readFile(new URL("../../public/app.js", import.meta.url), "utf8");
    const functionSource = source.match(/function initPromptText\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(functionSource);
    const context = {
        state: { init: { idea: "summarize support tickets" } },
        sentenceCase(text) {
            return text.charAt(0).toUpperCase() + text.slice(1);
        },
    };

    vm.runInNewContext(`${functionSource}\nresult = initPromptText();`, context);

    assert.doesNotMatch(context.result, /refreshWorkspaceState/);
    assert.doesNotMatch(context.result, /invoke the .* action for this canvas/);
    assert.match(context.result, /Create a foundry hosted agent for this task/);
    assert.match(context.result, /Then run it locally to make sure it runs successfully/);
});

test("canvas-provided user request bypasses the generated inspiration prompt", async () => {
    const source = await readFile(new URL("../../public/app.js", import.meta.url), "utf8");
    const modeSource = source.match(/function showNewAgent\(prompt = ""\) \{[\s\S]*?\n\}/)?.[0];
    const functionSource = source.match(/function setInitUserPrompt\(prompt\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(modeSource);
    assert.ok(functionSource);
    const original =
        "build a foundry agent to run the powershell scripts under queries folder 7am every day, then follow the analysis methodolgy markdown files";
    const state = {
        init: { idea: "old idea", open: false, promptText: "", promptDirty: false },
        hostedAgents: { creatingNew: false },
        folds: { resources: true, deploy: true },
    };
    const context = {
        state,
        setInitPreviewPrompt(text) {
            state.init.promptText = text;
            state.init.promptDirty = true;
        },
        render() {
            state.rendered = true;
        },
        toast() {},
    };

    vm.runInNewContext(
        `${modeSource}\n${functionSource}\nsetInitUserPrompt(original);`,
        { ...context, original },
    );

    assert.equal(context.state.init.promptText, original);
    assert.equal(context.state.init.promptDirty, true);
    assert.equal(context.state.init.idea, "");
    assert.equal(context.state.init.open, true);
    assert.equal(context.state.hostedAgents.creatingNew, true);
    assert.deepEqual(context.state.folds, { resources: false, deploy: false });
    assert.equal(context.state.rendered, true);
});

test("the client sends the create prompt without a pending workspace refresh", async () => {
    const source = await readFile(new URL("../../public/app.js", import.meta.url), "utf8");
    assert.match(
        source,
        /state\.hostedAgents\.creatingNew = true;\s*renderHostedAgentPicker\(\);\s*renderHostedAgentDeployment\(\);\s*recordAction\("start_agent_creation", "agent"\);\s*sendToChat\(withActionContext\(text\), "", "agent"\)/,
    );
    assert.doesNotMatch(source, /sendToChat\(withActionContext\(text\), "workspace"\)/);
});

test("the client opens the build sections immediately after sending", async () => {
    const source = await readFile(new URL("../../public/app.js", import.meta.url), "utf8");
    const handler = source.match(/if \(e\.target\.closest\("#initStart"\)\) \{[\s\S]*?\n    \}/)?.[0];
    const functionSource = source.match(/function showBuildSections\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(handler);
    assert.ok(functionSource);
    assert.match(
        handler,
        /state\.hostedAgents\.creatingNew = true;\s*renderHostedAgentPicker\(\);\s*renderHostedAgentDeployment\(\);\s*recordAction\("start_agent_creation", "agent"\);\s*sendToChat\(withActionContext\(text\), "", "agent"\);\s*showBuildSections\(\);/,
    );

    const calls = [];
    const context = {
        state: {
            init: { open: true },
            folds: { resources: false, deploy: false },
        },
        renderInit() {
            calls.push("init");
        },
        renderFolds() {
            calls.push("folds");
        },
    };
    vm.runInNewContext(`${functionSource}\nshowBuildSections();`, context);

    assert.equal(context.state.init.open, false);
    assert.deepEqual(context.state.folds, { resources: true, deploy: true });
    assert.deepEqual(calls, ["init", "folds"]);
});

test("canvas retains the workspace refresh action as a manual/recovery path", async () => {
    const source = await readFile(new URL("../../extension.mjs", import.meta.url), "utf8");

    assert.match(source, /name: "refreshWorkspaceState"/);
    assert.match(source, /description: "Refresh the canvas workspace state after the hosted-agent code is created\."/);
    assert.match(source, /return refreshWorkspaceState\(entry, resolveWorkspaceRoot\)/);
    assert.doesNotMatch(source, /refreshWorkspace: refreshWorkspaceState/);
});

test("session idle asks every open canvas to refresh hosted agents", async () => {
    const source = await readFile(new URL("../../extension.mjs", import.meta.url), "utf8");
    const functionSource = source.match(
        /function notifyHostedAgentRefresh\(\) \{[\s\S]*?\n\}/,
    )?.[0];
    assert.ok(functionSource);
    assert.match(
        source,
        /session\.on\("session\.idle", \(\) => \{\s*notifyHostedAgentRefresh\(\);/,
    );

    const frames = [];
    const context = {
        openInstances: new Set(["canvas-1", "missing"]),
        servers: new Map([["canvas-1", { id: "canvas-1" }]]),
        pushFrame(entry, frame) {
            frames.push({ entry, frame });
        },
    };
    vm.runInNewContext(`${functionSource}\nnotifyHostedAgentRefresh();`, context);

    assert.deepEqual(JSON.parse(JSON.stringify(frames)), [{
        entry: { id: "canvas-1" },
        frame: { type: "hostedAgentsChanged" },
    }]);
});
