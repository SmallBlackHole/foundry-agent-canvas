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
