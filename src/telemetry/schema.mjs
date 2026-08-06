export const TELEMETRY_SERVICE_NAME = "foundry-toolkit-canvas";
export const TELEMETRY_CONNECTION_STRING_ENV =
    "FOUNDRY_CANVAS_APPINSIGHTS_CONNECTION_STRING";

export const TELEMETRY_EVENTS = Object.freeze({
    active: `${TELEMETRY_SERVICE_NAME}/active`,
    action: `${TELEMETRY_SERVICE_NAME}/action`,
    operation: `${TELEMETRY_SERVICE_NAME}/operation`,
});

const ACTION_RESOURCE_KINDS = new Map([
    ["start_agent_creation", new Set(["agent"])],
    ["switch_model", new Set(["model"])],
    ["connect_toolbox", new Set(["toolbox"])],
    ["add_project_skill", new Set(["project_skill"])],
    ["apply_guardrail", new Set(["guardrail"])],
    ["deploy_to_foundry", new Set(["agent"])],
    ["inspect_locally", new Set(["agent"])],
    ["test_in_foundry_portal", new Set(["agent"])],
    ["create_agent", new Set(["agent"])],
    ["switch_agent", new Set(["agent"])],
    ["sign_in", null],
    ["sign_out", null],
    ["select_subscription", new Set(["subscription"])],
    ["select_project", new Set(["project"])],
    ["refresh_resources", new Set([
        "model",
        "toolbox",
        "project_skill",
        "guardrail",
        "subscription",
        "project",
    ])],
    ["open_foundry_creation_link", new Set([
        "model",
        "toolbox",
        "project_skill",
        "guardrail",
        "project",
    ])],
    ["report_issue", null],
]);

export const TELEMETRY_ACTIONS = Object.freeze([...ACTION_RESOURCE_KINDS.keys()]);
export const TELEMETRY_RESOURCE_KINDS = Object.freeze([
    "agent",
    "model",
    "toolbox",
    "project_skill",
    "guardrail",
    "subscription",
    "project",
]);
export const TELEMETRY_OPERATIONS = Object.freeze([
    "foundry_skill_sync",
    "sign_in",
    "sign_out",
    "select_subscription",
    "select_project",
    "load_resources",
    "prompt_delivery",
    "create_agent",
    "deployment_verification",
    "inspector_startup",
    "inspector_readiness",
]);
export const TELEMETRY_OUTCOMES = Object.freeze([
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "accepted",
    "unknown",
]);
export const TELEMETRY_SOURCES = Object.freeze([
    "ui",
    "automatic",
    "canvas_action",
    "session_idle",
]);
export const TELEMETRY_FAILURE_CODES = Object.freeze([
    "auth_changed",
    "cancelled",
    "fetch_failed",
    "identity_missing",
    "install_failed",
    "login_failed",
    "no_agent",
    "no_project",
    "no_subscription",
    "not_found",
    "not_ready",
    "not_signed_in",
    "persistence_failed",
    "prompt_not_accepted",
    "reload_failed",
    "runtime_unsupported",
    "timeout",
    "unauthorized",
    "unavailable",
    "unknown",
]);

const OPERATION_SET = new Set(TELEMETRY_OPERATIONS);
const OUTCOME_SET = new Set(TELEMETRY_OUTCOMES);
const SOURCE_SET = new Set(TELEMETRY_SOURCES);
const RESOURCE_SET = new Set(TELEMETRY_RESOURCE_KINDS);
const FAILURE_SET = new Set(TELEMETRY_FAILURE_CODES);
const SKILL_ACTIONS = new Set(["check", "install", "update", "reload", "none"]);
const SKILL_STATUSES = new Set(["missing", "outdated", "latest", "unknown"]);

function hasOnlyKeys(value, allowed) {
    return !!value
        && typeof value === "object"
        && !Array.isArray(value)
        && Object.keys(value).every((key) => allowed.has(key));
}

export function validateActionPayload(payload) {
    if (!hasOnlyKeys(payload, new Set(["action", "resourceKind"]))) return null;
    const action = typeof payload.action === "string" ? payload.action : "";
    const allowedResources = ACTION_RESOURCE_KINDS.get(action);
    if (allowedResources === undefined) return null;

    const resourceKind =
        typeof payload.resourceKind === "string" ? payload.resourceKind : "";
    if (allowedResources === null) {
        if (resourceKind) return null;
        return { action };
    }
    if (!allowedResources.has(resourceKind)) return null;
    return { action, resourceKind };
}

export function isTelemetryResourceKind(value) {
    return RESOURCE_SET.has(value);
}

export function validateOperationPayload(payload) {
    const allowedKeys = new Set([
        "operation",
        "outcome",
        "failureCode",
        "durationMs",
        "source",
        "resourceKind",
        "skillAction",
        "previousStatus",
        "changed",
        "ready",
        "reloaded",
    ]);
    if (!hasOnlyKeys(payload, allowedKeys)) return null;
    if (!OPERATION_SET.has(payload.operation)) return null;
    if (!OUTCOME_SET.has(payload.outcome)) return null;
    if (!SOURCE_SET.has(payload.source)) return null;
    if (
        payload.resourceKind !== undefined
        && !RESOURCE_SET.has(payload.resourceKind)
    ) {
        return null;
    }
    if (
        payload.failureCode !== undefined
        && !FAILURE_SET.has(payload.failureCode)
    ) {
        return null;
    }
    if (
        typeof payload.durationMs !== "number"
        || !Number.isFinite(payload.durationMs)
        || payload.durationMs < 0
    ) {
        return null;
    }

    const skillKeys = ["skillAction", "previousStatus", "changed", "ready", "reloaded"];
    const hasSkillFields = skillKeys.some((key) => payload[key] !== undefined);
    if (hasSkillFields && payload.operation !== "foundry_skill_sync") return null;
    if (
        payload.operation === "foundry_skill_sync"
        && (
            !SKILL_ACTIONS.has(payload.skillAction)
            || !SKILL_STATUSES.has(payload.previousStatus)
            || typeof payload.changed !== "boolean"
            || typeof payload.ready !== "boolean"
            || typeof payload.reloaded !== "boolean"
        )
    ) {
        return null;
    }

    return {
        operation: payload.operation,
        outcome: payload.outcome,
        durationMs: Math.round(payload.durationMs),
        source: payload.source,
        ...(payload.failureCode ? { failureCode: payload.failureCode } : {}),
        ...(payload.resourceKind ? { resourceKind: payload.resourceKind } : {}),
        ...(hasSkillFields
            ? {
                skillAction: payload.skillAction,
                previousStatus: payload.previousStatus,
                changed: payload.changed,
                ready: payload.ready,
                reloaded: payload.reloaded,
            }
            : {}),
    };
}

export function normalizeFailureCode(value) {
    const source = String(value?.code || value?.reason || value?.name || value || "")
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, "_");
    if (FAILURE_SET.has(source)) return source;
    if (source === "aborterror" || source.includes("timed_out") || source.includes("timeout")) {
        return "timeout";
    }
    if (source === "canceled") return "cancelled";
    if (source === "http_401" || source === "http_403") return "unauthorized";
    if (source === "http_404") return "not_found";
    if (source.includes("reload") && source.includes("support")) return "runtime_unsupported";
    if (source.includes("reload")) return "reload_failed";
    if (source.includes("install") || source.includes("update")) return "install_failed";
    return "unknown";
}
