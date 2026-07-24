import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    GITHUB_COPILOT_APP_AGENT,
    MICROSOFT_FOUNDRY_CANVAS_SYSTEM_MESSAGE,
    isGitHubCopilotAppEnvironment,
} from "../src/agent-canvas-system-message.mjs";

test("extension branding uses Microsoft Foundry", async () => {
    const files = await Promise.all([
        readFile(new URL("../extension.mjs", import.meta.url), "utf8"),
        readFile(new URL("../src/agent-canvas-system-message.mjs", import.meta.url), "utf8"),
        readFile(new URL("../public/index.html", import.meta.url), "utf8"),
        readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    ]);
    const copy = files.join("\n");

    assert.match(copy, /Microsoft Foundry/);
    assert.doesNotMatch(copy, /Foundry Agent Canvas/);
    assert.doesNotMatch(copy, /FOUNDRY_AGENT_CANVAS/);
});

test("workflow headings use sentence case and hosted agent remains lowercase", async () => {
    const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

    assert.match(html, />Create new hosted agents</);
    assert.match(html, />Build current hosted agent</);
    assert.match(html, />Deploy &amp; test</);
    assert.doesNotMatch(html, /Hosted Agents|Hosted Agent|Deploy &amp; Test/);
});

test("canvas routing and registration are limited to the GitHub Copilot App", async () => {
    const extensionSource = await readFile(new URL("../extension.mjs", import.meta.url), "utf8");

    assert.equal(isGitHubCopilotAppEnvironment({ AI_AGENT: GITHUB_COPILOT_APP_AGENT }), true);
    assert.equal(isGitHubCopilotAppEnvironment({ AI_AGENT: "github_copilot_cli" }), false);
    assert.equal(isGitHubCopilotAppEnvironment({}), false);
    assert.match(extensionSource, /const isGitHubCopilotApp = isGitHubCopilotAppEnvironment\(\);/);
    assert.match(extensionSource, /canvases: isGitHubCopilotApp \? \[/);
    assert.match(extensionSource, /\.\.\.\(isGitHubCopilotApp[\s\S]*?systemMessage:/);
    assert.match(MICROSOFT_FOUNDRY_CANVAS_SYSTEM_MESSAGE, /only in the GitHub Copilot App/);
    assert.match(MICROSOFT_FOUNDRY_CANVAS_SYSTEM_MESSAGE, /Never open or invoke this canvas from GitHub Copilot CLI/);
});

test("canvas handoff guide names the visible section and Start action", () => {
    assert.match(MICROSOFT_FOUNDRY_CANVAS_SYSTEM_MESSAGE, /Expand 'Create new hosted agents' if it is collapsed/);
    assert.match(MICROSOFT_FOUNDRY_CANVAS_SYSTEM_MESSAGE, /click Start to continue/);
    assert.doesNotMatch(MICROSOFT_FOUNDRY_CANVAS_SYSTEM_MESSAGE, /click Send/);
});

test("deployment section identifies the remote portal and has a live description", async () => {
    const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

    assert.match(html, /id="deployDescription" hidden/);
    assert.match(html, />Test in Foundry Portal</);
    assert.doesNotMatch(html, />Test in Playground</);
});

test("starter options can wrap without clipping their labels", async () => {
    const css = await readFile(new URL("../public/app.css", import.meta.url), "utf8");

    assert.match(css, /\.start-options\s*\{[\s\S]*?flex-wrap:\s*wrap;/);
    assert.match(css, /\.start-option\s*\{[\s\S]*?flex:\s*1 1 120px;/);
    assert.match(css, /\.option-title\s*\{[\s\S]*?white-space:\s*normal;/);
});

test("preview mock exposes region availability instead of a hidden region override", async () => {
    const mock = await readFile(new URL("../scripts/preview-mock.js", import.meta.url), "utf8");
    const preview = await readFile(new URL("../scripts/preview.mjs", import.meta.url), "utf8");

    assert.match(mock, /checkbox\("regionSupported", "Hosted agents available in region"/);
    assert.match(mock, /searchParams\.delete\("region"\)/);
    assert.match(preview, /searchParams\.get\("regionSupported"\) !== "false"/);
    assert.doesNotMatch(preview, /searchParams\.get\("region"\)/);
});
