import assert from "node:assert/strict";
import test from "node:test";

import { createCanvasServices } from "../src/api/canvas-services.mjs";
import {
    managedAgentPromptHook,
    markManagedAgentPrompt,
} from "../src/managed-prompt-context.mjs";

function canvasServices(sent) {
    return createCanvasServices({
        ctx: { getEntry: () => null },
        session: {
            async send(message) {
                sent.push(message);
            },
        },
        extensionDir: "",
        waitForFoundrySkill: async () => {},
    });
}

test("managed Create receives hidden PoC routing and remote workflow context", async () => {
    const sent = [];
    const services = canvasServices(sent);
    const prompt = [
        "Triage service incidents. Create a Microsoft Foundry managed agent for this task.",
        "",
        'Use my selected Foundry project "Operations" (endpoint: https://example.test/project).',
    ].join("\n");

    await services.sendPrompt({ body: { prompt, managedAction: "create" } });

    assert.equal(sent.length, 1);
    const output = managedAgentPromptHook(sent[0].prompt);
    assert.ok(output);
    assert.equal(
        output.modifiedPrompt,
        `/microsoft-foundry-managed-poc\n\n${prompt}`,
    );
    assert.match(output.additionalContext, /West US 2 \(westus2\)/);
    assert.match(output.additionalContext, /private-preview azure\.ai\.agents azd extension flow/);
    assert.match(output.additionalContext, /Author declarative instructions and skills/);
    assert.match(output.additionalContext, /deploy the managed agent remotely/);
    assert.match(output.additionalContext, /smoke invoke the deployed agent/);
    assert.match(output.additionalContext, /Do not ask for or perform a local run/);
    assert.doesNotMatch(output.modifiedPrompt, /foundry-canvas-managed-action/);
});

test("managed Deploy receives hidden PoC routing and deployment context", async () => {
    const sent = [];
    const services = canvasServices(sent);
    const prompt = [
        "Deploy my selected managed agent to Microsoft Foundry.",
        "",
        'Apply this request to my selected workspace managed agent "operations-agent".',
    ].join("\n");

    await services.sendPrompt({ body: { prompt, managedAction: "deploy" } });

    const output = managedAgentPromptHook(sent[0].prompt);
    assert.ok(output);
    assert.equal(
        output.modifiedPrompt,
        `/microsoft-foundry-managed-poc\n\n${prompt}`,
    );
    assert.match(output.additionalContext, /West US 2 \(westus2\)/);
    assert.match(output.additionalContext, /private-preview azure\.ai\.agents azd extension flow/);
    assert.match(output.additionalContext, /Preserve the managed agent's declarative instructions and skills/);
    assert.match(output.additionalContext, /deploy it remotely/);
    assert.match(output.additionalContext, /smoke invoke the deployed agent/);
    assert.match(output.additionalContext, /Do not ask for or perform a local run/);
});

test("managed Build keeps PoC skill routing without Create or Deploy directives", () => {
    const prompt = markManagedAgentPrompt(
        'Use "gpt-5" in my Foundry agent',
        "update",
    );

    assert.deepEqual(managedAgentPromptHook(prompt), {
        modifiedPrompt:
            '/microsoft-foundry-managed-poc\n\nUse "gpt-5" in my Foundry agent',
    });
});

test("hosted prompts pass through without hook changes", async () => {
    const sent = [];
    const services = canvasServices(sent);
    const prompt = "deploy it as a Foundry hosted agent";

    await services.sendPrompt({ body: { prompt } });

    assert.deepEqual(sent, [{ prompt }]);
    assert.equal(managedAgentPromptHook(sent[0].prompt), undefined);
});
