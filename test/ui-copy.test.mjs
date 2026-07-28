import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    GITHUB_COPILOT_APP_AGENT,
    MICROSOFT_FOUNDRY_CANVAS_HANDOFF_MESSAGE,
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

test("canvas tab is marked as preview", async () => {
    const extensionSource = await readFile(new URL("../extension.mjs", import.meta.url), "utf8");

    assert.match(extensionSource, /displayName: "Microsoft Foundry \(Preview\)"/);
    assert.match(extensionSource, /return \{ title: "Microsoft Foundry \(Preview\)", url: entry\.url, status: "Build" \}/);
});

test("toolbox and skill links use the Foundry tools tabs", async () => {
    const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

    assert.match(app, /openPortalPage\("build\/tools\?tab=toolboxes"\)/);
    assert.match(app, /openPortalPage\("build\/tools\?tab=skills"\)/);
    assert.doesNotMatch(app, /openPortalPage\("build\/toolboxes"\)/);
});

test("workflow headings use sentence case and hosted agent remains lowercase", async () => {
    const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

    assert.match(html, />Create new hosted agents</);
    assert.match(html, />Build current hosted agent</);
    assert.match(html, />Deploy &amp; test</);
    assert.doesNotMatch(html, /Hosted Agents|Hosted Agent|Deploy &amp; Test/);
});

test("canvas registration and session activity are app-only while routing trusts capability over profile", async () => {
    const extensionSource = await readFile(new URL("../extension.mjs", import.meta.url), "utf8");
    const gatedRegistration = extensionSource.match(
        /\.\.\.\(isGitHubCopilotApp\s*\?\s*\{[\s\S]*?\}\s*:\s*\{\}\),/,
    )?.[0];
    const gatedSessionActivity = extensionSource.match(
        /if \(isGitHubCopilotApp\) \{[\s\S]*?\} else \{\s*\/\/ The extension is canvas-only\.[\s\S]*?markWorkspaceRootReady\(\);\s*\}/,
    )?.[0];

    assert.equal(isGitHubCopilotAppEnvironment({ AI_AGENT: GITHUB_COPILOT_APP_AGENT }), true);
    assert.equal(isGitHubCopilotAppEnvironment({ AI_AGENT: "github_copilot_cli" }), false);
    assert.equal(isGitHubCopilotAppEnvironment({}), false);
    assert.ok(gatedRegistration);
    assert.match(gatedRegistration, /systemMessage:/);
    assert.match(gatedRegistration, /hooks:/);
    assert.match(gatedRegistration, /onSessionStart:/);
    assert.match(gatedRegistration, /onUserPromptSubmitted:/);
    assert.match(extensionSource, /const isGitHubCopilotApp = isGitHubCopilotAppEnvironment\(\);/);
    assert.match(extensionSource, /canvases: isGitHubCopilotApp \? \[/);
    assert.ok(gatedSessionActivity);
    assert.match(gatedSessionActivity, /session\.on\("session\.idle"/);
    assert.match(gatedSessionActivity, /initializeWorkspaceRoot\(session, workspaceRoot\)/);
    assert.match(gatedSessionActivity, /setInspectorSession\(session\)/);
    assert.match(MICROSOFT_FOUNDRY_CANVAS_SYSTEM_MESSAGE, /Apply the rest of this routing only when canvas "agent-builder" is registered and open_canvas is available/);
    assert.match(MICROSOFT_FOUNDRY_CANVAS_SYSTEM_MESSAGE, /a GitHub Copilot CLI profile must not by itself prevent this routing/);
    assert.match(MICROSOFT_FOUNDRY_CANVAS_SYSTEM_MESSAGE, /If either capability is unavailable, ignore the rest of this routing and follow the normal workflow/);
    assert.match(MICROSOFT_FOUNDRY_CANVAS_SYSTEM_MESSAGE, /explicit canvas opt-outs such as "skip the canvas" or "use the CLI"/);
    assert.doesNotMatch(MICROSOFT_FOUNDRY_CANVAS_SYSTEM_MESSAGE, /Never open or invoke this canvas from GitHub Copilot CLI/);
});

test("canvas handoff guide is formatted as a readable Markdown checklist", () => {
    assert.match(MICROSOFT_FOUNDRY_CANVAS_HANDOFF_MESSAGE, /^\*\*The Microsoft Foundry canvas is ready\.\*\*/);
    assert.match(MICROSOFT_FOUNDRY_CANVAS_HANDOFF_MESSAGE, /\n\n1\. Sign in and select a subscription and Foundry project\./);
    assert.match(MICROSOFT_FOUNDRY_CANVAS_HANDOFF_MESSAGE, /\n2\. Expand \*\*Create new hosted agents\*\* if it is collapsed\./);
    assert.match(MICROSOFT_FOUNDRY_CANVAS_HANDOFF_MESSAGE, /\n3\. Choose or edit a starter prompt\./);
    assert.match(MICROSOFT_FOUNDRY_CANVAS_HANDOFF_MESSAGE, /\n4\. Click \*\*Start\*\* to continue\.$/);
    assert.match(MICROSOFT_FOUNDRY_CANVAS_SYSTEM_MESSAGE, /respond with the following Markdown exactly/);
    assert.match(MICROSOFT_FOUNDRY_CANVAS_SYSTEM_MESSAGE, /Click \*\*Start\*\* to continue/);
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

test("the plugin update bar is informational and directs updates outside the live provider", async () => {
    const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
    const css = await readFile(new URL("../public/app.css", import.meta.url), "utf8");
    const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
    const packageScript = await readFile(new URL("../scripts/package.mjs", import.meta.url), "utf8");

    assert.match(html, /<div class="update-bar" id="updateBar" role="status" hidden>/);
    assert.doesNotMatch(html, /id="updateBtn"/);
    assert.match(html, /id="updateBar"[\s\S]*?<header class="project-bar">/);
    assert.match(css, /\.update-bar\[hidden\] \{ display: none; \}/);
    assert.match(html, /<span class="update-bar-text">[\s\S]*?<span id="updateBarText"><\/span>[\s\S]*?<span>Update it in Settings → Plugins\.<\/span>/);
    assert.match(css, /\.update-bar-text \{[\s\S]*?column-gap: 8px;/);
    assert.match(app, /Microsoft Foundry \$\{update\.latestVersion\} is available/);
    assert.doesNotMatch(app, /copilot plugin update|gh copilot/);
    assert.doesNotMatch(app, /applyPluginUpdate|Updating Microsoft Foundry|Updated\. Reopen the Canvas/);

    // The status glyph must not read as a control: no shared clickable icon
    // class and no pointer events.
    assert.match(html, /<span class="fi update-bar-ico" aria-hidden="true"><\/span>/);
    assert.doesNotMatch(html, /fi-refresh update-bar-ico/);
    assert.match(css, /\.update-bar-ico \{[\s\S]*?arrow_circle_up_16_regular\.svg[\s\S]*?pointer-events: none;/);
    assert.doesNotMatch(css, /update-bar-btn|update-spin|update-bar-ico\.is-busy/);

    assert.match(html, /id="updateDismissBtn"[^>]*aria-label="Dismiss update notice"/);
    assert.match(css, /\.update-bar-dismiss \{[\s\S]*?cursor: pointer;/);
    assert.match(packageScript, /"arrow_circle_up_16_regular\.svg",/);
    assert.match(packageScript, /"dismiss_16_regular\.svg",/);
});

test("preview mock exposes region availability instead of a hidden region override", async () => {
    const mock = await readFile(new URL("../scripts/preview-mock.js", import.meta.url), "utf8");
    const preview = await readFile(new URL("../scripts/preview.mjs", import.meta.url), "utf8");

    assert.match(mock, /checkbox\("regionSupported", "Hosted agents available in region"/);
    assert.match(mock, /searchParams\.delete\("region"\)/);
    assert.match(preview, /searchParams\.get\("regionSupported"\) !== "false"/);
    assert.doesNotMatch(preview, /searchParams\.get\("region"\)/);
});
