import { normalizeFailureCode } from "./schema.mjs";

export function foundrySkillOperation(result) {
    const skillAction = ["install", "update"].includes(result?.action)
        ? result.action
        : result?.changed && result?.reloaded
            ? "reload"
            : result?.action === "none"
                ? "none"
                : "check";
    const previousStatus = ["missing", "outdated", "latest", "unknown"].includes(
        result?.previousStatus,
    )
        ? result.previousStatus
        : ["missing", "outdated", "latest", "unknown"].includes(result?.status)
            ? result.status
            : "unknown";
    const ready = result?.ready === true;
    const succeeded = ready
        && (skillAction === "none" || skillAction === "check" || result?.ok === true);
    let failureCode;
    if (!succeeded) {
        if (result?.changed && !result?.reloaded) {
            failureCode = String(result?.error || "").includes("does not support")
                ? "runtime_unsupported"
                : "reload_failed";
        } else if (skillAction === "install" || skillAction === "update") {
            failureCode = "install_failed";
        } else {
            failureCode = normalizeFailureCode(result?.reason);
        }
    }
    return {
        operation: "foundry_skill_sync",
        outcome: succeeded ? "succeeded" : "failed",
        ...(failureCode ? { failureCode } : {}),
        source: "automatic",
        skillAction,
        previousStatus,
        changed: result?.changed === true,
        ready,
        reloaded: result?.reloaded === true,
    };
}

export function deploymentVerificationOutcome(result) {
    if (result?.ok && result?.deployed && String(result?.version || "").trim()) {
        return { outcome: "succeeded" };
    }
    if (result?.reason === "creating" || result?.reason === "not_deployed") {
        return { outcome: "unknown" };
    }
    return {
        outcome: "failed",
        failureCode: normalizeFailureCode(result?.reason),
    };
}

export function pendingDeploymentOutcome(terminal) {
    if (terminal?.outcome === "succeeded" && terminal.result) {
        return deploymentVerificationOutcome(terminal.result);
    }
    return {
        outcome: terminal?.outcome || "unknown",
        ...(terminal?.failureCode
            ? { failureCode: normalizeFailureCode(terminal.failureCode) }
            : {}),
    };
}
