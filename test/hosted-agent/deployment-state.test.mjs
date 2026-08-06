import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { DEPLOY_PROMPT } from "../../src/foundry/catalog.mjs";
import { refreshDeploymentState } from "../../src/hosted-agent/deployment-state.mjs";
import {
    hostedAgentDeploymentDescription,
    hostedAgentDeploymentFromResult,
} from "../../public/app/hosted-agents.js";
import { readAllClientSource } from "../../test-support/client-source.mjs";

test("deployment refresh action emits the verified live result", async () => {
    const frames = [];
    const entry = { sseClients: new Set() };
    let inspections = 0;
    const deployment = {
        ok: true,
        deployed: true,
        available: true,
        portalUrl: "https://ai.azure.com/example",
        agentName: "example-agent",
        version: "4",
        reason: "",
    };

    const result = await refreshDeploymentState(entry, async () => {
        inspections += 1;
        return deployment;
    }, {
        push(_entry, frame) {
            frames.push(frame);
        },
    });

    assert.equal(inspections, 1);
    assert.equal(result, deployment);
    assert.deepEqual(frames, [{ type: "deploymentState", deployment }]);
});

test("deploy prompt no longer asks Copilot to invoke a canvas action", async () => {
    const extensionSource = await readFile(new URL("../../extension.mjs", import.meta.url), "utf8");
    const appSource = await readFile(new URL("../../public/app.js", import.meta.url), "utf8");

    assert.equal(DEPLOY_PROMPT, "deploy it as a Foundry hosted agent");
    assert.doesNotMatch(DEPLOY_PROMPT, /After deployment succeeds/);
    assert.doesNotMatch(DEPLOY_PROMPT, /refreshDeploymentState/);
    // The client tags the deploy prompt so the extension can auto-refresh.
    assert.match(
        appSource,
        /sendToChat\(\s*withActionContext\(state\.deployPrompt\),\s*"deployment",\s*"agent",?\s*\)/,
    );
    // The action is retained as a manual/recovery path alongside the idle-driven
    // manager (which also uses the same refresh function).
    assert.match(extensionSource, /name: "refreshDeploymentState"/);
    assert.match(
        extensionSource,
        /description: "Refresh the canvas deployment state after the hosted agent is deployed\."/,
    );
    assert.match(extensionSource, /refreshDeployment: refreshDeploymentState/);
});

test("SPA no longer polls deployment state on window focus or a TTL", async () => {
    const source = await readAllClientSource();
    assert.doesNotMatch(source, /HOSTED_AGENT_REFRESH_TTL_MS/);
    assert.doesNotMatch(source, /hostedAgentDeploymentCheckedAt/);
    assert.doesNotMatch(source, /addEventListener\(\s*["']focus["']/);
    // The preserve-previous / "refreshing" branch only existed to keep a known-good
    // link across background focus/TTL refreshes; with polling gone it is dead code.
    const loader = source.match(/async function loadHostedAgentDeployment\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(loader);
    assert.doesNotMatch(loader, /preservePrevious/);
    assert.doesNotMatch(loader, /refreshing/);
});

test("SPA checks deployment only on open, project change, and bootstrap paths", async () => {
    const source = await readAllClientSource();
    // Initial canvas load (init) resolves region support before the deployment check.
    assert.match(source, /await loadRegionSupport\(\);[\s\S]*?await loadHostedAgentDeployment\(\);/);
    // Selecting a project re-runs the one-shot check.
    assert.match(source, /loadRegionSupport\(\);\s*loadHostedAgentDeployment\(\);/);
    // Bootstrap after sign-in refreshes region support before the one-shot check.
    assert.match(
        source,
        /await loadProjects\(true\);[\s\S]*?await loadRegionSupport\(\);\s*await loadHostedAgentDeployment\(\);/,
    );
});

test("deploy click resets the deployment state so the playground link is hidden", async () => {
    const [appSource, hostedSource] = await Promise.all([
        readFile(new URL("../../public/app.js", import.meta.url), "utf8"),
        readFile(
            new URL("../../public/app/hosted-agents.js", import.meta.url),
            "utf8",
        ),
    ]);
    const handler = appSource.match(
        /if \(event\.target\.closest\("#deployBtn"\)\) \{[\s\S]*?\n    \}/,
    )?.[0];
    assert.ok(handler);
    assert.match(handler, /resetHostedAgentDeployment\(\);/);
    // resetHostedAgentDeployment clears state and re-renders (hiding the link).
    const reset = hostedSource.match(
        /function resetHostedAgentDeployment\(\) \{[\s\S]*?\n\}/,
    )?.[0];
    assert.ok(reset);
    assert.match(reset, /emptyHostedAgentDeployment\(\)/);
    assert.match(reset, /renderHostedAgentDeployment\(\)/);
});

test("SPA maps deployment frames to the Foundry Portal state", async () => {
    const appSource = await readFile(
        new URL("../../public/app.js", import.meta.url),
        "utf8",
    );
    assert.match(
        appSource,
        /message\.type === "deploymentState"[\s\S]*?applyHostedAgentDeploymentFrame\(message\.deployment\)/,
    );
    const deployment = {
        ok: true,
        deployed: true,
        available: true,
        portalUrl: "https://ai.azure.com/example",
        agentName: "example-agent",
        version: "4",
    };

    const result = hostedAgentDeploymentFromResult(deployment);
    assert.deepEqual(result, {
        status: "ready",
        deployed: true,
        available: true,
        portalUrl: "https://ai.azure.com/example",
        agentName: "example-agent",
        version: "4",
        reason: "",
    });
    assert.equal(
        hostedAgentDeploymentDescription(result),
        "Deployed as example-agent, version 4.",
    );

    const missing = hostedAgentDeploymentFromResult({
        ok: false,
        deployed: false,
        available: false,
        reason: "not_deployed",
    });
    assert.equal(missing.available, false);
    assert.equal(missing.portalUrl, "");
    assert.equal(hostedAgentDeploymentDescription(missing), "");
});

test("deployment description follows the rendered Deploy fold state", async () => {
    const source = await readFile(
        new URL("../../public/app/layout.js", import.meta.url),
        "utf8",
    );
    const functionSource = source.match(
        /function syncDeployDescriptionVisibility\(open = state\.folds\.deploy\) \{[\s\S]*?\n\}/,
    )?.[0];
    assert.ok(functionSource);
    assert.match(source, /if \(blockId === "deployBlock"\) syncDeployDescriptionVisibility\(open\);/);

    const description = {
        textContent: "Deployed as example-agent, version 4.",
        hidden: false,
    };
    const context = {
        description,
        document: {
            getElementById(id) {
                return id === "deployDescription" ? description : null;
            },
        },
    };
    vm.createContext(context);

    vm.runInContext(`${functionSource}\nsyncDeployDescriptionVisibility(false);`, context);
    assert.equal(description.hidden, true);

    vm.runInContext("syncDeployDescriptionVisibility(true);", context);
    assert.equal(description.hidden, false);

    description.textContent = "";
    vm.runInContext("syncDeployDescriptionVisibility(true);", context);
    assert.equal(description.hidden, true);
});

test("New Agent mode suppresses the previous deployment description and portal link", async () => {
    const source = await readFile(
        new URL("../../public/app/hosted-agents.js", import.meta.url),
        "utf8",
    );
    const functionSource = source.match(
        /function renderHostedAgentDeployment\(\) \{[\s\S]*?\n\}/,
    )?.[0];
    assert.ok(functionSource);

    const description = { textContent: "", hidden: false };
    const row = {
        hasPlayground: true,
        classList: {
            toggle(_name, value) {
                row.hasPlayground = value;
            },
        },
    };
    const link = {
        hidden: false,
        href: "https://ai.azure.com/old",
        title: "Old deployment",
        closest() {
            return row;
        },
        removeAttribute(name) {
            delete this[name];
        },
    };
    const context = {
        state: {
            folds: { deploy: true },
            hostedAgents: { creatingNew: true },
            hostedAgentDeployment: {
                deployed: true,
                available: true,
                portalUrl: "https://ai.azure.com/example",
                agentName: "example-agent",
                version: "4",
            },
        },
        document: {
            getElementById(id) {
                if (id === "testPlaygroundLink") return link;
                if (id === "deployDescription") return description;
                return null;
            },
        },
        hasAvailableHostedAgentDeployment(deployment) {
            return !!(deployment.deployed && deployment.available && deployment.portalUrl);
        },
        hostedAgentDeploymentDescription(deployment) {
            return deployment.deployed
                ? "Deployed as example-agent, version 4."
                : "";
        },
        emptyHostedAgentDeployment() {
            return {
                deployed: false,
                available: false,
                portalUrl: "",
                agentName: "",
                version: "",
            };
        },
        syncDeployDescriptionVisibility() {
            description.hidden =
                !context.state.folds.deploy || !description.textContent.trim();
        },
    };
    vm.createContext(context);

    vm.runInContext(`${functionSource}\nrenderHostedAgentDeployment();`, context);

    assert.equal(description.textContent, "");
    assert.equal(description.hidden, true);
    assert.equal(link.hidden, true);
    assert.equal(link.href, undefined);
    assert.equal(link.title, "");
    assert.equal(row.hasPlayground, false);

    context.state.hostedAgents.creatingNew = false;
    vm.runInContext("renderHostedAgentDeployment();", context);

    assert.equal(description.textContent, "Deployed as example-agent, version 4.");
    assert.equal(description.hidden, false);
    assert.equal(link.hidden, false);
    assert.equal(link.href, "https://ai.azure.com/example");
    assert.equal(link.title, "Test example-agent version 4 in Microsoft Foundry Portal");
    assert.equal(row.hasPlayground, true);
});

test("a failed agent-list refresh keeps the picker instead of collapsing it", async () => {
    const source = await readFile(
        new URL("../../public/app/hosted-agents.js", import.meta.url),
        "utf8",
    );
    const loadSource = source.match(/async function loadHostedAgents\(force\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(loadSource);
    // Opening the menu must reuse the cached list; only explicit refreshes refetch.
    assert.match(source, /if \(willOpen\) loadHostedAgents\(false\);/);

    const renders = [];
    const context = {
        state: {
            hostedAgents: {
                status: "ready",
                items: [{ agentName: "alpha" }, { agentName: "beta" }],
                selected: "alpha",
            },
        },
        getJSON() {
            throw new Error("canvas server restarting");
        },
        renderHostedAgentPicker() {
            renders.push(context.state.hostedAgents.items.length);
        },
    };
    vm.createContext(context);

    // Cached: an unforced load while ready must not even hit the network.
    await vm.runInContext(`${loadSource}\nloadHostedAgents(false);`, context);
    assert.deepEqual(renders, []);

    await vm.runInContext("loadHostedAgents(true);", context);

    assert.equal(context.state.hostedAgents.status, "error");
    assert.deepEqual(
        context.state.hostedAgents.items.map((a) => a.agentName),
        ["alpha", "beta"],
        "a failed refresh must keep the known agents so the picker stays visible",
    );
    assert.equal(context.state.hostedAgents.selected, "alpha");
    assert.deepEqual(renders, [2]);
});

test("startup reuses project-init agents before identity and region loading", async () => {
    const source = await readFile(new URL("../../public/app.js", import.meta.url), "utf8");

    assert.match(
        source,
        /if \(Array\.isArray\(projectInit\.agents\)\) \{[\s\S]*?state\.hostedAgents\.status = "ready";/,
    );
    const initSource = source.slice(source.indexOf("async function init()"));
    const fallbackIndex = initSource.indexOf("const hostedAgentsPromise = loadHostedAgents();");
    const bootstrapIndex = initSource.indexOf('getJSON("/api/bootstrap")');
    assert.ok(fallbackIndex > 0);
    assert.ok(fallbackIndex < bootstrapIndex);
    assert.match(source, /await hostedAgentsPromise;\s*await loadHostedAgentDeployment\(\);/);
});
