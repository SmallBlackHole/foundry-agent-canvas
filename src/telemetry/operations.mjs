import {
    TELEMETRY_FAILURE_CODE,
    TELEMETRY_OUTCOME,
} from "../../public/telemetry-constants.js";
import { normalizeFailureCode } from "./schema.mjs";

export async function runTelemetryOperation(
    telemetry,
    {
        operation,
        source,
        resourceKind,
        classify = (result) => ({
            outcome: result?.ok === false
                ? TELEMETRY_OUTCOME.FAILED
                : TELEMETRY_OUTCOME.SUCCEEDED,
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
        const terminal = classify(result) || {
            outcome: TELEMETRY_OUTCOME.UNKNOWN,
        };
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
            outcome: TELEMETRY_OUTCOME.FAILED,
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
        if (pending.has(key)) {
            finish(
                key,
                TELEMETRY_OUTCOME.CANCELLED,
                TELEMETRY_FAILURE_CODE.CANCELLED,
            );
        }
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
            return finish(
                key,
                TELEMETRY_OUTCOME.TIMED_OUT,
                TELEMETRY_FAILURE_CODE.TIMEOUT,
            );
        }
        return false;
    }

    function clear(key) {
        return finish(
            key,
            TELEMETRY_OUTCOME.CANCELLED,
            TELEMETRY_FAILURE_CODE.CANCELLED,
        );
    }

    return {
        start,
        finish,
        tick,
        clear,
        has: (key) => pending.has(key),
    };
}
