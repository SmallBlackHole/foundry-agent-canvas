import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { DEPLOY_PROMPT } from "../src/catalog.mjs";
import { refreshDeploymentState } from "../src/deployment-state.mjs";

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
    const extensionSource = await readFile(new URL("../extension.mjs", import.meta.url), "utf8");
    const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

    assert.equal(DEPLOY_PROMPT, "deploy it as a Foundry hosted agent");
    assert.doesNotMatch(DEPLOY_PROMPT, /After deployment succeeds/);
    assert.doesNotMatch(DEPLOY_PROMPT, /refreshDeploymentState/);
    // The client tags the deploy prompt so the extension can auto-refresh.
    assert.match(appSource, /sendToChat\(withProjectContext\(state\.deployPrompt\), "deployment"\)/);
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
    const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
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
    const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
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
    const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
    const handler = source.match(/if \(e\.target\.closest\("#deployBtn"\)\) \{[\s\S]*?\n    \}/)?.[0];
    assert.ok(handler);
    assert.match(handler, /resetHostedAgentDeployment\(\);/);
    // resetHostedAgentDeployment clears state and re-renders (hiding the link).
    const reset = source.match(/function resetHostedAgentDeployment\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(reset);
    assert.match(reset, /emptyHostedAgentDeployment\(\)/);
    assert.match(reset, /renderHostedAgentDeployment\(\)/);
});

test("SPA maps deployment frames to the Foundry Portal state", async () => {
    const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
    const functionSource = source.match(/function hostedAgentDeploymentFromResult\(result\) \{[\s\S]*?\n\}/)?.[0];
    const descriptionSource = source.match(/function hostedAgentDeploymentDescription\(deployment\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(functionSource);
    assert.ok(descriptionSource);
    assert.match(source, /msg\.type === "deploymentState" && msg\.deployment/);
    const context = {
        deployment: {
            ok: true,
            deployed: true,
            available: true,
            portalUrl: "https://ai.azure.com/example",
            agentName: "example-agent",
            version: "4",
        },
    };

    vm.runInNewContext(`${functionSource}\nresult = hostedAgentDeploymentFromResult(deployment);`, context);

    assert.deepEqual(JSON.parse(JSON.stringify(context.result)), {
        status: "ready",
        deployed: true,
        available: true,
        portalUrl: "https://ai.azure.com/example",
        agentName: "example-agent",
        version: "4",
        reason: "",
    });
    vm.runInNewContext(`${descriptionSource}\ndescription = hostedAgentDeploymentDescription(result);`, context);
    assert.equal(context.description, "Deployed as example-agent, version 4.");

    context.deployment = {
        ok: false,
        deployed: false,
        available: false,
        reason: "not_deployed",
    };
    vm.runInNewContext("result = hostedAgentDeploymentFromResult(deployment);", context);
    assert.equal(context.result.available, false);
    assert.equal(context.result.portalUrl, "");
    vm.runInNewContext("description = hostedAgentDeploymentDescription(result);", context);
    assert.equal(context.description, "");
});

test("deployment description follows the rendered Deploy fold state", async () => {
    const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
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

test("a failed agent-list refresh keeps the picker instead of collapsing it", async () => {
    const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
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
    const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

    assert.match(
        source,
        /if \(Array\.isArray\(pi\.agents\)\) \{[\s\S]*?state\.hostedAgents\.status = "ready";/,
    );
    const initSource = source.slice(source.indexOf("async function init()"));
    const fallbackIndex = initSource.indexOf("const hostedAgentsPromise = loadHostedAgents();");
    const bootstrapIndex = initSource.indexOf('getJSON("/api/bootstrap")');
    assert.ok(fallbackIndex > 0);
    assert.ok(fallbackIndex < bootstrapIndex);
    assert.match(source, /await hostedAgentsPromise;\s*await loadHostedAgentDeployment\(\);/);
});
