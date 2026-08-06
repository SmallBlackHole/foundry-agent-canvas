import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the browser routes every approved primary action through the local endpoint", async () => {
    const source = await readFile(new URL("../public/app.js", import.meta.url), "utf-8");
    const actions = [
        "start_agent_creation",
        "switch_model",
        "connect_toolbox",
        "add_project_skill",
        "apply_guardrail",
        "deploy_to_foundry",
        "inspect_locally",
        "test_in_foundry_portal",
        "create_agent",
        "switch_agent",
        "sign_in",
        "sign_out",
        "select_subscription",
        "select_project",
        "refresh_resources",
        "open_foundry_creation_link",
        "report_issue",
    ];

    assert.match(source, /fetch\("\/api\/telemetry\/action"/);
    for (const action of actions) {
        assert.match(source, new RegExp(`recordAction\\("${action}"`));
    }
    for (const excluded of ["accordion", "dropdown", "search", "dismiss", "back"]) {
        assert.doesNotMatch(source, new RegExp(`recordAction\\("${excluded}`));
    }
    assert.doesNotMatch(source, /FOUNDRY_CANVAS_APPINSIGHTS_CONNECTION_STRING/);
    assert.doesNotMatch(source, /machine\.devdeviceid/);
});
