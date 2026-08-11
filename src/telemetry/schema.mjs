import {
    TELEMETRY_ACTION_RESOURCE_KINDS,
    TELEMETRY_FAILURE_CODE,
    TELEMETRY_FAILURE_CODES,
    TELEMETRY_OPERATION,
    TELEMETRY_OPERATIONS,
    TELEMETRY_OUTCOME_FAILURE_DEFAULTS,
    TELEMETRY_OUTCOMES,
    TELEMETRY_RESOURCE_KINDS,
    TELEMETRY_SKILL_ACTIONS,
    TELEMETRY_SKILL_STATUSES,
    TELEMETRY_SOURCES,
} from "../../public/telemetry-constants.js";

export * from "../../public/telemetry-constants.js";

const ACTION_RESOURCE_KINDS = new Map(
    Object.entries(TELEMETRY_ACTION_RESOURCE_KINDS).map(
        ([action, resourceKinds]) => [
            action,
            resourceKinds ? new Set(resourceKinds) : null,
        ],
    ),
);

const OPERATION_SET = new Set(TELEMETRY_OPERATIONS);
const OUTCOME_SET = new Set(TELEMETRY_OUTCOMES);
const SOURCE_SET = new Set(TELEMETRY_SOURCES);
const RESOURCE_SET = new Set(TELEMETRY_RESOURCE_KINDS);
const FAILURE_SET = new Set(TELEMETRY_FAILURE_CODES);
const SKILL_ACTIONS = new Set(TELEMETRY_SKILL_ACTIONS);
const SKILL_STATUSES = new Set(TELEMETRY_SKILL_STATUSES);

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
    const defaultFailureCode =
        TELEMETRY_OUTCOME_FAILURE_DEFAULTS[payload.outcome];
    if (!defaultFailureCode && payload.failureCode !== undefined) return null;
    const failureCode = payload.failureCode || defaultFailureCode;
    if (
        typeof payload.durationMs !== "number"
        || !Number.isFinite(payload.durationMs)
        || payload.durationMs < 0
    ) {
        return null;
    }

    const skillKeys = ["skillAction", "previousStatus", "changed", "ready", "reloaded"];
    const hasSkillFields = skillKeys.some((key) => payload[key] !== undefined);
    if (
        hasSkillFields
        && payload.operation !== TELEMETRY_OPERATION.FOUNDRY_SKILL_SYNC
    ) {
        return null;
    }
    if (
        payload.operation === TELEMETRY_OPERATION.FOUNDRY_SKILL_SYNC
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
        ...(failureCode ? { failureCode } : {}),
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
        return TELEMETRY_FAILURE_CODE.TIMEOUT;
    }
    if (source === "canceled") return TELEMETRY_FAILURE_CODE.CANCELLED;
    if (source === "http_401" || source === "http_403") {
        return TELEMETRY_FAILURE_CODE.UNAUTHORIZED;
    }
    if (source === "http_404") return TELEMETRY_FAILURE_CODE.NOT_FOUND;
    if (source.includes("reload") && source.includes("support")) {
        return TELEMETRY_FAILURE_CODE.RUNTIME_UNSUPPORTED;
    }
    if (source.includes("reload")) return TELEMETRY_FAILURE_CODE.RELOAD_FAILED;
    if (source.includes("install") || source.includes("update")) {
        return TELEMETRY_FAILURE_CODE.INSTALL_FAILED;
    }
    return TELEMETRY_FAILURE_CODE.UNKNOWN;
}
