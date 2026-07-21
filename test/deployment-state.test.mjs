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
    // Bootstrap after sign-in also runs the one-shot check.
    assert.match(source, /await loadProjects\(true\);\s*await loadHostedAgentDeployment\(\);/);
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

test("SPA maps deployment frames to the Test in Playground state", async () => {
    const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
    const functionSource = source.match(/function hostedAgentDeploymentFromResult\(result\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(functionSource);
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

    context.deployment = {
        ok: false,
        deployed: false,
        available: false,
        reason: "not_deployed",
    };
    vm.runInNewContext("result = hostedAgentDeploymentFromResult(deployment);", context);
    assert.equal(context.result.available, false);
    assert.equal(context.result.portalUrl, "");
});
