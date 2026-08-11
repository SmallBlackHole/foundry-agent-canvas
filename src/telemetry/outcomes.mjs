import {
    TELEMETRY_FAILURE_CODE,
    TELEMETRY_OPERATION,
    TELEMETRY_OUTCOME,
    TELEMETRY_SKILL_ACTION,
    TELEMETRY_SKILL_STATUS,
    TELEMETRY_SKILL_STATUSES,
    TELEMETRY_SOURCE,
} from "../../public/telemetry-constants.js";
import { normalizeFailureCode } from "./schema.mjs";

export function foundrySkillOperation(result) {
    const skillAction = [
        TELEMETRY_SKILL_ACTION.INSTALL,
        TELEMETRY_SKILL_ACTION.UPDATE,
    ].includes(result?.action)
        ? result.action
        : result?.changed && result?.reloaded
            ? TELEMETRY_SKILL_ACTION.RELOAD
            : result?.action === TELEMETRY_SKILL_ACTION.NONE
                ? TELEMETRY_SKILL_ACTION.NONE
                : TELEMETRY_SKILL_ACTION.CHECK;
    const previousStatus = TELEMETRY_SKILL_STATUSES.includes(result?.previousStatus)
        ? result.previousStatus
        : TELEMETRY_SKILL_STATUSES.includes(result?.status)
            ? result.status
            : TELEMETRY_SKILL_STATUS.UNKNOWN;
    const ready = result?.ready === true;
    const succeeded = ready
        && (
            skillAction === TELEMETRY_SKILL_ACTION.NONE
            || skillAction === TELEMETRY_SKILL_ACTION.CHECK
            || result?.ok === true
        );
    let failureCode;
    if (!succeeded) {
        if (result?.changed && !result?.reloaded) {
            failureCode = String(result?.error || "").includes("does not support")
                ? TELEMETRY_FAILURE_CODE.RUNTIME_UNSUPPORTED
                : TELEMETRY_FAILURE_CODE.RELOAD_FAILED;
        } else if (
            skillAction === TELEMETRY_SKILL_ACTION.INSTALL
            || skillAction === TELEMETRY_SKILL_ACTION.UPDATE
        ) {
            failureCode = TELEMETRY_FAILURE_CODE.INSTALL_FAILED;
        } else {
            failureCode = normalizeFailureCode(result?.reason);
        }
    }
    return {
        operation: TELEMETRY_OPERATION.FOUNDRY_SKILL_SYNC,
        outcome: succeeded
            ? TELEMETRY_OUTCOME.SUCCEEDED
            : TELEMETRY_OUTCOME.FAILED,
        ...(failureCode ? { failureCode } : {}),
        source: TELEMETRY_SOURCE.AUTOMATIC,
        skillAction,
        previousStatus,
        changed: result?.changed === true,
        ready,
        reloaded: result?.reloaded === true,
    };
}

export function deploymentVerificationOutcome(result) {
    if (result?.ok && result?.deployed && String(result?.version || "").trim()) {
        return { outcome: TELEMETRY_OUTCOME.SUCCEEDED };
    }
    if (result?.reason === "creating" || result?.reason === "not_deployed") {
        return { outcome: TELEMETRY_OUTCOME.UNKNOWN };
    }
    return {
        outcome: TELEMETRY_OUTCOME.FAILED,
        failureCode: normalizeFailureCode(result?.reason),
    };
}

export function pendingDeploymentOutcome(terminal) {
    if (
        terminal?.outcome === TELEMETRY_OUTCOME.SUCCEEDED
        && terminal.result
    ) {
        return deploymentVerificationOutcome(terminal.result);
    }
    return {
        outcome: terminal?.outcome || TELEMETRY_OUTCOME.UNKNOWN,
        ...(terminal?.failureCode
            ? { failureCode: normalizeFailureCode(terminal.failureCode) }
            : {}),
    };
}
