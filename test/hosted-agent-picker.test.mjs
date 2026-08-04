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

test("chat actions append the selected workspace agent and Foundry project", async () => {
    const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
    const functionSource = source.match(
        /function withActionContext\(prompt\) \{[\s\S]*?\n\}/,
    )?.[0];
    assert.ok(functionSource);

    const context = {
        state: {
            agentName: "",
            hostedAgents: {
                selected: "research-agent",
                creatingNew: false,
            },
            selection: {
                subscription: { name: "Development" },
                project: {
                    name: "Agent Project",
                    endpoint: "https://example.test/api/projects/agent-project",
                },
            },
        },
    };
    vm.createContext(context);
    vm.runInContext(
        `${functionSource}\nresult = withActionContext("deploy it as a Foundry hosted agent");`,
        context,
    );

    assert.equal(
        context.result,
        [
            "deploy it as a Foundry hosted agent",
            "",
            'Apply this request to my selected workspace agent "research-agent".',
            'Use my selected Foundry project "Agent Project" in subscription "Development" '
                + "(endpoint: https://example.test/api/projects/agent-project).",
        ].join("\n"),
    );

    context.state.hostedAgents.creatingNew = true;
    vm.runInContext('result = withActionContext("create an agent");', context);
    assert.doesNotMatch(context.result, /research-agent/);
    assert.match(context.result, /Use my selected Foundry project "Agent Project"/);

    assert.match(source, /sendToChat\(withActionContext\(m\.prompt\)\)/);
    assert.match(source, /sendToChat\(withActionContext\(t\.prompt\)\)/);
    assert.match(source, /sendToChat\(withActionContext\(g\.prompt\)\)/);
    assert.match(source, /sendToChat\(withActionContext\(s\.prompt\)\)/);
    assert.match(source, /sendToChat\(withActionContext\(state\.deployPrompt\), "deployment"\)/);
});

test("Create Start enters new-agent state before adding action context", async () => {
    const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
    const functionSource = source.match(
        /function withActionContext\(prompt\) \{[\s\S]*?\n\}/,
    )?.[0];
    const handler = source.match(
        /if \(e\.target\.closest\("#initStart"\)\) \{[\s\S]*?\n    \}/,
    )?.[0];
    assert.ok(functionSource);
    assert.ok(handler);

    const calls = [];
    const context = {
        state: {
            agentName: "",
            init: { promptText: "" },
            hostedAgents: {
                selected: "research-agent",
                creatingNew: false,
            },
            selection: {
                subscription: { name: "Development" },
                project: {
                    name: "Agent Project",
                    endpoint: "https://example.test/api/projects/agent-project",
                },
            },
        },
        e: {
            target: {
                closest(selector) {
                    return selector === "#initStart" ? {} : null;
                },
            },
        },
        document: {
            getElementById(id) {
                return id === "initPrompt" ? { value: "create a research agent" } : null;
            },
        },
        remindProjectSelection() {
            return true;
        },
        renderHostedAgentPicker() {
            calls.push("picker");
        },
        renderHostedAgentDeployment() {
            calls.push("deployment");
        },
        sendToChat(prompt) {
            calls.push(["send", prompt]);
        },
        showBuildSections() {
            calls.push("build");
        },
    };
    vm.createContext(context);

    await vm.runInContext(
        `${functionSource}\n(async () => {\n${handler}\n})();`,
        context,
    );

    assert.equal(context.state.hostedAgents.creatingNew, true);
    assert.deepEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), [
        "picker",
        "deployment",
        "send",
        "build",
    ]);
    assert.doesNotMatch(calls[2][1], /research-agent/);
    assert.match(calls[2][1], /Use my selected Foundry project "Agent Project"/);
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

test("switching agents hides the previous portal action before saving the selection", async () => {
    const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
    const functionSource = source.match(/async function selectHostedAgent\(agentName\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(functionSource);

    const calls = [];
    let finishSelection;
    const context = {
        state: {
            agentName: "support-agent",
            hostedAgents: { selected: "support-agent", creatingNew: false },
            init: { open: false },
            folds: { resources: true, deploy: true },
        },
        renderHostedAgentPicker() {
            calls.push("picker");
        },
        resetHostedAgentDeployment() {
            calls.push("reset");
        },
        postJSON() {
            calls.push("save");
            return new Promise((resolve) => {
                finishSelection = resolve;
            });
        },
        closeInspector() {
            calls.push("close-inspector");
        },
        loadHostedAgentDeployment() {
            calls.push("load-deployment");
        },
        toast(message) {
            calls.push(message);
        },
    };
    vm.createContext(context);
    const selection = vm.runInContext(
        `${functionSource}\nselectHostedAgent("research-agent");`,
        context,
    );

    assert.deepEqual(calls, ["picker", "reset", "save"]);
    finishSelection({ ok: true });
    await selection;
    assert.deepEqual(calls, [
        "picker",
        "reset",
        "save",
        "close-inspector",
        "load-deployment",
        "Agent: research-agent",
    ]);
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

test("session idle refresh selects the sole newly created agent", async () => {
    const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
    const functionSource = source.match(
        /async function refreshHostedAgentsAfterSession\(\) \{[\s\S]*?\n\}/,
    )?.[0];
    assert.ok(functionSource);
    assert.match(
        source,
        /msg\.type === "hostedAgentsChanged"\) refreshHostedAgentsAfterSession\(\)/,
    );

    const state = {
        hostedAgents: {
            creatingNew: true,
            items: [{ agentName: "alpha" }, { agentName: "beta" }],
        },
    };
    const selected = [];
    const context = {
        state,
        workspaceHostedAgentOptions() {
            return state.hostedAgents.items;
        },
        async loadHostedAgents() {
            state.hostedAgents.items = [
                { agentName: "alpha" },
                { agentName: "beta" },
                { agentName: "new-agent" },
            ];
        },
        async selectHostedAgent(agentName) {
            selected.push(agentName);
            state.hostedAgents.creatingNew = false;
        },
    };
    vm.createContext(context);

    await vm.runInContext(
        `${functionSource}\nrefreshHostedAgentsAfterSession();`,
        context,
    );

    assert.deepEqual(selected, ["new-agent"]);
    assert.equal(state.hostedAgents.creatingNew, false);
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
