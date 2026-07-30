import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("multi-agent picker is rendered between the project header and accordions", async () => {
    const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
    const headerIndex = html.indexOf('<header class="project-bar">');
    const pickerIndex = html.indexOf('id="hostedAgentBar"');
    const initIndex = html.indexOf('id="initBlock"');
    const deployIndex = html.indexOf('id="deployBlock"');

    assert.ok(headerIndex >= 0);
    assert.ok(headerIndex < pickerIndex);
    assert.ok(pickerIndex < initIndex);
    assert.ok(pickerIndex < deployIndex);
    assert.match(html, /id="hostedAgentBar" hidden/);
    assert.match(html, /id="newHostedAgentBtn"[\s\S]*?<span>New<\/span>/);
    assert.doesNotMatch(html.slice(deployIndex), /id="hostedAgentBar"/);
});

test("picker visibility counts workspace agents rather than a fallback selection", async () => {
    const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
    const functionSource = source.match(
        /function workspaceHostedAgentOptions\(\) \{[\s\S]*?\n\}/,
    )?.[0];
    assert.ok(functionSource);
    assert.match(source, /bar\.hidden = workspaceOptions\.length < 2;/);

    const context = {
        state: {
            hostedAgents: {
                items: [{ agentName: "workspace-agent" }],
                selected: "external-agent",
            },
        },
    };
    vm.runInNewContext(`${functionSource}\nresult = workspaceHostedAgentOptions();`, context);

    assert.deepEqual(
        JSON.parse(JSON.stringify(context.result)),
        [{ agentName: "workspace-agent" }],
    );
});

test("New starts an explicit render state and opens only Create", async () => {
    const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
    const functionSource = source.match(/function showNewAgent\(prompt = ""\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(functionSource);
    const calls = [];
    const context = {
        state: {
            hostedAgents: { creatingNew: false },
            init: { open: false },
            folds: { resources: true, deploy: true },
        },
        render() {
            calls.push("render");
        },
    };

    vm.runInNewContext(`${functionSource}\nshowNewAgent();`, context);

    assert.equal(context.state.hostedAgents.creatingNew, true);
    assert.equal(context.state.init.open, true);
    assert.deepEqual(context.state.folds, { resources: false, deploy: false });
    assert.deepEqual(calls, ["render"]);
    assert.match(source, /const renderedName = creatingNew \? "New Agent" : active\.agentName;/);
    assert.match(source, /newButton\.hidden = creatingNew;/);
});

test("selecting the current agent exits New without rewriting the selection", async () => {
    const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
    const functionSource = source.match(/async function selectHostedAgent\(agentName\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(functionSource);
    const calls = [];
    const context = {
        state: {
            agentName: "Preview Agent",
            hostedAgents: { selected: "Preview Agent", creatingNew: true },
            init: { open: true },
            folds: { resources: false, deploy: false },
        },
        postJSON() {
            throw new Error("selection must not be rewritten");
        },
        renderHostedAgentPicker() {
            calls.push("picker");
        },
        renderInit() {
            calls.push("init");
        },
        renderFolds() {
            calls.push("folds");
        },
        renderHostedAgentDeployment() {
            calls.push("deployment");
        },
        toast(message) {
            calls.push(message);
        },
    };

    vm.createContext(context);
    await vm.runInContext(`${functionSource}\nselectHostedAgent("Preview Agent");`, context);

    assert.equal(context.state.hostedAgents.creatingNew, false);
    assert.equal(context.state.init.open, false);
    assert.deepEqual(context.state.folds, { resources: true, deploy: true });
    assert.deepEqual(calls, ["init", "folds", "picker", "deployment", "Agent: Preview Agent"]);
});

test("Inspect Locally asks for an existing agent while New Agent is active", async () => {
    const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
    const handler = source.match(
        /if \(e\.target\.closest\("#inspectBtn"\)\) \{[\s\S]*?\n    \}/,
    )?.[0];
    assert.ok(handler);
    assert.match(handler, /if \(state\.hostedAgents\.creatingNew\)/);
    assert.match(handler, /toast\("Select an existing agent to inspect locally\."\)/);
    assert.match(handler, /else \{\s*launchInspector\(e\.target\.closest\("#inspectBtn"\)\);/);
});

test("the packaged icon set includes Add without the retired agent glyph", async () => {
    const [app, css, packageSource] = await Promise.all([
        readFile(new URL("../public/app.js", import.meta.url), "utf8"),
        readFile(new URL("../public/app.css", import.meta.url), "utf8"),
        readFile(new URL("../scripts/package.mjs", import.meta.url), "utf8"),
    ]);

    assert.match(css, /\.fi-add\s*\{[^}]*add_16_regular\.svg[^}]*--fi-size: 16px;/);
    assert.match(packageSource, /"add_16_regular\.svg",/);
    assert.doesNotMatch(app, /fluentIcon\("agent"\)|is-new-agent|\.agent-select/);
    assert.doesNotMatch(css, /agents_16_regular\.svg|\.fi-agent/);
    assert.doesNotMatch(packageSource, /"agents_16_regular\.svg",/);
});
