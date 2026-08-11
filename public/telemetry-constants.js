const values = (value) => Object.freeze(Object.values(value));

export const TELEMETRY_SERVICE_NAME = "foundry-toolkit-canvas";
export const TELEMETRY_CONNECTION_STRING_ENV =
    "FOUNDRY_CANVAS_APPINSIGHTS_CONNECTION_STRING";

export const TELEMETRY_EVENT = Object.freeze({
    ACTIVE: `${TELEMETRY_SERVICE_NAME}/active`,
    ACTION: `${TELEMETRY_SERVICE_NAME}/action`,
    OPERATION: `${TELEMETRY_SERVICE_NAME}/operation`,
});
export const TELEMETRY_EVENTS = Object.freeze({
    active: TELEMETRY_EVENT.ACTIVE,
    action: TELEMETRY_EVENT.ACTION,
    operation: TELEMETRY_EVENT.OPERATION,
});

export const TELEMETRY_ATTRIBUTE = Object.freeze({
    ACTION: "ftk.canvas.action",
    ARCHITECTURE: "ftk.canvas.arch",
    CHANGED: "ftk.canvas.changed",
    DEVICE_ID: "ftk.canvas.devDeviceId",
    DURATION_MS: "ftk.canvas.durationMs",
    FAILURE_CODE: "ftk.canvas.failureCode",
    OPERATION: "ftk.canvas.operation",
    OS: "ftk.canvas.os",
    OUTCOME: "ftk.canvas.outcome",
    PREVIOUS_STATUS: "ftk.canvas.previousStatus",
    PRODUCT_VERSION: "ftk.canvas.productVersion",
    READY: "ftk.canvas.ready",
    RELOADED: "ftk.canvas.reloaded",
    RESOURCE_KIND: "ftk.canvas.resourceKind",
    SKILL_ACTION: "ftk.canvas.skillAction",
    SOURCE: "ftk.canvas.source",
});

export const TELEMETRY_ACTION = Object.freeze({
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
});
export const TELEMETRY_ACTIONS = values(TELEMETRY_ACTION);

export const TELEMETRY_RESOURCE_KIND = Object.freeze({
    AGENT: "agent",
    MODEL: "model",
    TOOLBOX: "toolbox",
    PROJECT_SKILL: "project_skill",
    GUARDRAIL: "guardrail",
    SUBSCRIPTION: "subscription",
    PROJECT: "project",
});
export const TELEMETRY_RESOURCE_KINDS = values(TELEMETRY_RESOURCE_KIND);

export const TELEMETRY_ACTION_RESOURCE_KINDS = Object.freeze({
    [TELEMETRY_ACTION.START_AGENT_CREATION]: Object.freeze([
        TELEMETRY_RESOURCE_KIND.AGENT,
    ]),
    [TELEMETRY_ACTION.SWITCH_MODEL]: Object.freeze([
        TELEMETRY_RESOURCE_KIND.MODEL,
    ]),
    [TELEMETRY_ACTION.CONNECT_TOOLBOX]: Object.freeze([
        TELEMETRY_RESOURCE_KIND.TOOLBOX,
    ]),
    [TELEMETRY_ACTION.ADD_PROJECT_SKILL]: Object.freeze([
        TELEMETRY_RESOURCE_KIND.PROJECT_SKILL,
    ]),
    [TELEMETRY_ACTION.APPLY_GUARDRAIL]: Object.freeze([
        TELEMETRY_RESOURCE_KIND.GUARDRAIL,
    ]),
    [TELEMETRY_ACTION.DEPLOY_TO_FOUNDRY]: Object.freeze([
        TELEMETRY_RESOURCE_KIND.AGENT,
    ]),
    [TELEMETRY_ACTION.INSPECT_LOCALLY]: Object.freeze([
        TELEMETRY_RESOURCE_KIND.AGENT,
    ]),
    [TELEMETRY_ACTION.TEST_IN_FOUNDRY_PORTAL]: Object.freeze([
        TELEMETRY_RESOURCE_KIND.AGENT,
    ]),
    [TELEMETRY_ACTION.CREATE_AGENT]: Object.freeze([
        TELEMETRY_RESOURCE_KIND.AGENT,
    ]),
    [TELEMETRY_ACTION.SWITCH_AGENT]: Object.freeze([
        TELEMETRY_RESOURCE_KIND.AGENT,
    ]),
    [TELEMETRY_ACTION.SIGN_IN]: null,
    [TELEMETRY_ACTION.SIGN_OUT]: null,
    [TELEMETRY_ACTION.SELECT_SUBSCRIPTION]: Object.freeze([
        TELEMETRY_RESOURCE_KIND.SUBSCRIPTION,
    ]),
    [TELEMETRY_ACTION.SELECT_PROJECT]: Object.freeze([
        TELEMETRY_RESOURCE_KIND.PROJECT,
    ]),
    [TELEMETRY_ACTION.REFRESH_RESOURCES]: Object.freeze([
        TELEMETRY_RESOURCE_KIND.MODEL,
        TELEMETRY_RESOURCE_KIND.TOOLBOX,
        TELEMETRY_RESOURCE_KIND.PROJECT_SKILL,
        TELEMETRY_RESOURCE_KIND.GUARDRAIL,
        TELEMETRY_RESOURCE_KIND.SUBSCRIPTION,
        TELEMETRY_RESOURCE_KIND.PROJECT,
    ]),
    [TELEMETRY_ACTION.OPEN_FOUNDRY_CREATION_LINK]: Object.freeze([
        TELEMETRY_RESOURCE_KIND.MODEL,
        TELEMETRY_RESOURCE_KIND.TOOLBOX,
        TELEMETRY_RESOURCE_KIND.PROJECT_SKILL,
        TELEMETRY_RESOURCE_KIND.GUARDRAIL,
        TELEMETRY_RESOURCE_KIND.PROJECT,
    ]),
    [TELEMETRY_ACTION.REPORT_ISSUE]: null,
});

export const TELEMETRY_OPERATION = Object.freeze({
    FOUNDRY_SKILL_SYNC: "foundry_skill_sync",
    SIGN_IN: "sign_in",
    SIGN_OUT: "sign_out",
    SELECT_SUBSCRIPTION: "select_subscription",
    SELECT_PROJECT: "select_project",
    LOAD_RESOURCES: "load_resources",
    PROMPT_DELIVERY: "prompt_delivery",
    CREATE_AGENT: "create_agent",
    DEPLOYMENT_VERIFICATION: "deployment_verification",
    INSPECTOR_STARTUP: "inspector_startup",
    INSPECTOR_READINESS: "inspector_readiness",
});
export const TELEMETRY_OPERATIONS = values(TELEMETRY_OPERATION);

export const TELEMETRY_OUTCOME = Object.freeze({
    SUCCEEDED: "succeeded",
    FAILED: "failed",
    CANCELLED: "cancelled",
    TIMED_OUT: "timed_out",
    ACCEPTED: "accepted",
    UNKNOWN: "unknown",
});
export const TELEMETRY_OUTCOMES = values(TELEMETRY_OUTCOME);
export const TELEMETRY_SUCCESS_OUTCOMES = Object.freeze([
    TELEMETRY_OUTCOME.SUCCEEDED,
    TELEMETRY_OUTCOME.ACCEPTED,
]);

export const TELEMETRY_SOURCE = Object.freeze({
    UI: "ui",
    AUTOMATIC: "automatic",
    CANVAS_ACTION: "canvas_action",
    SESSION_IDLE: "session_idle",
});
export const TELEMETRY_SOURCES = values(TELEMETRY_SOURCE);

export const TELEMETRY_FAILURE_CODE = Object.freeze({
    AUTH_CHANGED: "auth_changed",
    CANCELLED: "cancelled",
    FETCH_FAILED: "fetch_failed",
    IDENTITY_MISSING: "identity_missing",
    INSTALL_FAILED: "install_failed",
    LOGIN_FAILED: "login_failed",
    NO_AGENT: "no_agent",
    NO_PROJECT: "no_project",
    NO_SUBSCRIPTION: "no_subscription",
    NOT_FOUND: "not_found",
    NOT_READY: "not_ready",
    NOT_SIGNED_IN: "not_signed_in",
    PERSISTENCE_FAILED: "persistence_failed",
    PROMPT_NOT_ACCEPTED: "prompt_not_accepted",
    RELOAD_FAILED: "reload_failed",
    RUNTIME_UNSUPPORTED: "runtime_unsupported",
    TIMEOUT: "timeout",
    UNAUTHORIZED: "unauthorized",
    UNAVAILABLE: "unavailable",
    UNKNOWN: "unknown",
});
export const TELEMETRY_FAILURE_CODES = values(TELEMETRY_FAILURE_CODE);

export const TELEMETRY_SKILL_ACTION = Object.freeze({
    CHECK: "check",
    INSTALL: "install",
    UPDATE: "update",
    RELOAD: "reload",
    NONE: "none",
});
export const TELEMETRY_SKILL_ACTIONS = values(TELEMETRY_SKILL_ACTION);

export const TELEMETRY_SKILL_STATUS = Object.freeze({
    MISSING: "missing",
    OUTDATED: "outdated",
    LATEST: "latest",
    UNKNOWN: "unknown",
});
export const TELEMETRY_SKILL_STATUSES = values(TELEMETRY_SKILL_STATUS);

export const TELEMETRY_OUTCOME_FAILURE_DEFAULTS = Object.freeze({
    [TELEMETRY_OUTCOME.FAILED]: TELEMETRY_FAILURE_CODE.UNKNOWN,
    [TELEMETRY_OUTCOME.CANCELLED]: TELEMETRY_FAILURE_CODE.CANCELLED,
    [TELEMETRY_OUTCOME.TIMED_OUT]: TELEMETRY_FAILURE_CODE.TIMEOUT,
    [TELEMETRY_OUTCOME.UNKNOWN]: TELEMETRY_FAILURE_CODE.UNKNOWN,
});

export const TELEMETRY_EXPORTER_ENV = Object.freeze({
    APPLICATION_INSIGHTS_NO_STATSBEAT: "1",
    APPLICATIONINSIGHTS_OPENTELEMETRY_RESOURCE_METRIC_DISABLED: "true",
});
