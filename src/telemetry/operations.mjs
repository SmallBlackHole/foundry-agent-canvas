import { normalizeFailureCode } from "./schema.mjs";

export async function runTelemetryOperation(
    telemetry,
    {
        operation,
        source,
        resourceKind,
        classify = (result) => ({
            outcome: result?.ok === false ? "failed" : "succeeded",
            failureCode: result?.ok === false
                ? normalizeFailureCode(result?.reason)
                : undefined,
        }),
        now = Date.now,
    },
    run,
) {
    const startedAt = now();
    try {
        const result = await run();
        const terminal = classify(result) || { outcome: "unknown" };
        telemetry?.recordOperation?.({
            operation,
            source,
            resourceKind,
            durationMs: Math.max(0, now() - startedAt),
            ...terminal,
        });
        return result;
    } catch (error) {
        telemetry?.recordOperation?.({
            operation,
            source,
            resourceKind,
            outcome: "failed",
            failureCode: normalizeFailureCode(error),
            durationMs: Math.max(0, now() - startedAt),
        });
        throw error;
    }
}

export function createPendingOperationTracker({
    telemetry,
    operation,
    source,
    resourceKind,
    maxIdleAttempts = 12,
    now = Date.now,
} = {}) {
    const pending = new Map();

    function start(key) {
        if (!key) return false;
        pending.set(key, { startedAt: now(), idleAttempts: 0 });
        return true;
    }

    function finish(key, outcome, failureCode) {
        const entry = pending.get(key);
        if (!entry) return false;
        pending.delete(key);
        telemetry?.recordOperation?.({
            operation,
            source,
            resourceKind,
            outcome,
            ...(failureCode ? { failureCode } : {}),
            durationMs: Math.max(0, now() - entry.startedAt),
        });
        return true;
    }

    function tick(key) {
        const entry = pending.get(key);
        if (!entry) return false;
        entry.idleAttempts += 1;
        if (entry.idleAttempts >= maxIdleAttempts) {
            return finish(key, "timed_out", "timeout");
        }
        return false;
    }

    function clear(key) {
        return pending.delete(key);
    }

    return {
        start,
        finish,
        tick,
        clear,
        has: (key) => pending.has(key),
    };
}
