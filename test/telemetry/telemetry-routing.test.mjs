import assert from "node:assert/strict";
import test from "node:test";

import {
    TELEMETRY_ACTION,
    TELEMETRY_ACTIONS,
    TELEMETRY_RESOURCE_KIND,
} from "../../public/telemetry-constants.js";
import { readAllClientSource } from "../../test-support/client-source.mjs";

test("the browser routes every approved primary action through the local endpoint", async () => {
    const source = await readAllClientSource();
    const actions = {
        START_AGENT_CREATION: "start_agent_creation",
        SWITCH_MODEL: "switch_model",
        CONNECT_TOOLBOX: "connect_toolbox",
        ADD_PROJECT_SKILL: "add_project_skill",
        APPLY_GUARDRAIL: "apply_guardrail",
        DEPLOY_TO_FOUNDRY: "deploy_to_foundry",
        INSPECT_LOCALLY: "inspect_locally",
        TEST_IN_FOUNDRY_PORTAL: "test_in_foundry_portal",
        CREATE_AGENT: "create_agent",
        SWITCH_AGENT: "switch_agent",
        SIGN_IN: "sign_in",
        SIGN_OUT: "sign_out",
        SELECT_SUBSCRIPTION: "select_subscription",
        SELECT_PROJECT: "select_project",
        REFRESH_RESOURCES: "refresh_resources",
        OPEN_FOUNDRY_CREATION_LINK: "open_foundry_creation_link",
        REPORT_ISSUE: "report_issue",
    };

    assert.deepEqual(TELEMETRY_ACTION, actions);
    assert.deepEqual(TELEMETRY_ACTIONS, Object.values(actions));
    assert.deepEqual(TELEMETRY_RESOURCE_KIND, {
        AGENT: "agent",
        MODEL: "model",
        TOOLBOX: "toolbox",
        PROJECT_SKILL: "project_skill",
        GUARDRAIL: "guardrail",
        SUBSCRIPTION: "subscription",
        PROJECT: "project",
    });
    assert.match(source, /fetch\("\/api\/telemetry\/action"/);
    for (const name of Object.keys(actions)) {
        assert.match(
            source,
            new RegExp(`recordAction\\(\\s*TELEMETRY_ACTION\\.${name}`),
        );
    }
    assert.doesNotMatch(source, /recordAction\(\s*"[a-z_]+"/);
    assert.doesNotMatch(source, /FOUNDRY_CANVAS_APPINSIGHTS_CONNECTION_STRING/);
    assert.doesNotMatch(source, /machine\.devdeviceid/);
});
