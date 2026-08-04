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
    assert.doesNotMatch(html, /Hosted Agents|Deploy &amp; Test/);
});

test("Create defaults to Hosted Agent and offers the Managed Agent preview flow", async () => {
    const [html, app] = await Promise.all([
        readFile(new URL("../public/index.html", import.meta.url), "utf8"),
        readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    ]);

    assert.match(html, /class="agent-type-switch"[^>]*role="radiogroup"/);
    assert.match(html, /id="hostedAgentType"[^>]*aria-checked="true"[\s\S]*?>\s*Hosted Agent/);
    assert.match(html, /id="managedAgentType"[^>]*aria-checked="false"[\s\S]*?>\s*Managed Agent/);
    assert.match(app, /state\.agentType = HOSTED_AGENT_TYPE;/);
    assert.match(app, /Managed Agent private-preview workflow/);
    assert.match(app, /selected existing Foundry project/);
    assert.match(app, /West US 2 \(westus2\)/);
    assert.match(app, /preview azure\.ai\.agents azd extension/);
    assert.match(app, /declarative instructions and skills/);
    assert.match(app, /deploy the agent remotely/);
    assert.match(app, /smoke invoke the deployed agent/);
    assert.match(app, /const MANAGED_POC_SLASH_COMMAND = "\/microsoft-foundry-managed-poc";/);
    assert.match(app, /\$\{MANAGED_POC_SLASH_COMMAND\}\\n\\n\$\{contextualPrompt\}/);
    assert.match(app, /Do not ask for "/);
    assert.match(app, /or perform a local run/);
    assert.match(app, /inspect\.hidden = managed;/);
    assert.match(app, /for \(const id of \["toolboxResource", "guardrailResource"\]\)/);
    assert.match(
        app,
        /if \(e\.target\.closest\("#initStart"\)\) \{[\s\S]*?managedProjectRegionBlocked\(\)/,
    );
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
    assert.match(MICROSOFT_FOUNDRY_CANVAS_HANDOFF_MESSAGE, /\n2\. Expand \*\*Create new agents\*\* if it is collapsed\./);
    assert.match(MICROSOFT_FOUNDRY_CANVAS_HANDOFF_MESSAGE, /\n3\. Choose \*\*Hosted Agent\*\* or \*\*Managed Agent\*\*, then choose or edit a starter prompt\./);
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

test("managed-only hidden controls stay hidden despite authored display rules", async () => {
    const css = await readFile(new URL("../public/app.css", import.meta.url), "utf8");

    assert.match(
        css,
        /\.btn-inspect\[hidden\],[\s\S]*?\.resource-select\[hidden\],[\s\S]*?\.managed-playground-view\[hidden\]\s*\{\s*display:\s*none;/,
    );
});

test("managed agent deploy section opens a dedicated text-only playground view", async () => {
    const [html, app, css] = await Promise.all([
        readFile(new URL("../public/index.html", import.meta.url), "utf8"),
        readFile(new URL("../public/app.js", import.meta.url), "utf8"),
        readFile(new URL("../public/app.css", import.meta.url), "utf8"),
    ]);

    const viewIndex = html.indexOf('id="managedPlaygroundView"');
    const buildTemplateIndex = html.indexOf('id="tpl-build"');
    assert.ok(viewIndex > 0 && viewIndex < buildTemplateIndex);
    assert.match(html, /id="managedPlaygroundView"[^>]*class="managed-playground-view"[^>]*hidden/);
    assert.match(html, /id="managedPlaygroundBack"[^>]*>\s*<svg[\s\S]*?Back/);
    assert.match(html, /id="managedPlaygroundOpen"[^>]*>\s*<span[^>]*codicon-debug-alt[\s\S]*?>Open agent playground</);
    assert.match(html, />Agent playground</);
    assert.match(html, />Private preview</);
    assert.match(html, /id="managedPlaygroundAgentName"/);
    assert.match(html, /id="managedPlaygroundAgentVersion"[^>]*hidden/);
    assert.match(html, /id="managedPlaygroundMessages"[^>]*aria-live="polite"/);
    assert.match(html, /id="managedPlaygroundForm"/);
    assert.match(html, /id="managedPlaygroundReset"[^>]*aria-label="Reset conversation"/);
    assert.doesNotMatch(html, /id="managedPlayground"/);
    assert.match(app, /function openManagedPlayground\(\)[\s\S]*?root\.hidden = true;[\s\S]*?managedPlaygroundView\.hidden = false;/);
    assert.match(app, /function closeManagedPlayground\(\)[\s\S]*?managedPlaygroundView\.hidden = true;[\s\S]*?root\.hidden = false;/);
    assert.match(app, /event\.target\.closest\("#managedPlaygroundBack"\)[\s\S]*?closeManagedPlayground\(\)/);
    assert.match(app, /state\.managedPlayground\.controller\?\.abort\(\)/);
    assert.match(app, /\/api\/managed-agent\/playground\/stream/);
    assert.match(app, /event\.type === "delta"/);
    assert.match(app, /if \(!message\.text && !message\.streaming\) continue;/);
    assert.match(app, /row\.textContent = message\.text/);
    assert.doesNotMatch(app, /innerHTML = message\.text/);
    assert.match(css, /\.managed-playground-view\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?inset:\s*0;/);
    assert.match(css, /\.managed-playground-main\s*\{[\s\S]*?flex:\s*1 1 auto;[\s\S]*?min-height:\s*0;/);
    assert.match(css, /@media \(max-width:\s*430px\)[\s\S]*?\.managed-playground-message\s*\{[\s\S]*?max-width:\s*92%;/);
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

test("project header links to the Microsoft Foundry issue form", async () => {
    const [html, css, packageSource, appSource, routesSource] = await Promise.all([
        readFile(new URL("../public/index.html", import.meta.url), "utf8"),
        readFile(new URL("../public/app.css", import.meta.url), "utf8"),
        readFile(new URL("../scripts/package.mjs", import.meta.url), "utf8"),
        readFile(new URL("../public/app.js", import.meta.url), "utf8"),
        readFile(new URL("../src/routes.mjs", import.meta.url), "utf8"),
    ]);

    assert.match(
        html,
        /id="githubIssueLink"[\s\S]*?href="https:\/\/github\.com\/microsoft\/foundry-toolkit\/issues\/new\?labels=canvas"/,
    );
    assert.match(html, /id="githubIssueLink"[\s\S]*?target="_blank"[\s\S]*?rel="noopener noreferrer"/);
    assert.match(html, /aria-label="Report an issue or ask a question"/);
    assert.match(css, /\.fi-question\s*\{[^}]*question_circle_20_regular\.svg/);
    assert.match(packageSource, /"question_circle_20_regular\.svg"/);
    assert.match(appSource, /buildIssueReportUrl\(\{[\s\S]*?operatingSystem: detectOperatingSystem\(\)[\s\S]*?pluginVersion: state\.pluginVersion/);
    assert.match(routesSource, /path === "\/issue-report\.js"/);
});

test("preview mock exposes region and managed playground states", async () => {
    const mock = await readFile(new URL("../scripts/preview-mock.js", import.meta.url), "utf8");
    const preview = await readFile(new URL("../scripts/preview.mjs", import.meta.url), "utf8");

    assert.match(mock, /checkbox\("regionSupported", "Hosted agents available in region"/);
    assert.match(mock, /checkbox\("managedStreamSlow", "Slow streaming response"/);
    assert.match(mock, /checkbox\("managedStreamError", "Streaming error"/);
    assert.match(mock, /searchParams\.delete\("region"\)/);
    assert.match(preview, /searchParams\.get\("regionSupported"\) !== "false"/);
    assert.match(preview, /searchParams\.get\("managedStreamSlow"\) === "true"/);
    assert.match(preview, /searchParams\.get\("managedStreamError"\) === "true"/);
    assert.match(preview, /Preview managed agent stream failed\./);
    assert.doesNotMatch(preview, /searchParams\.get\("region"\)/);
});
