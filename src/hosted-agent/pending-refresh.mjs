// Tracks deployment refresh work that a canvas-originated request expects to
// happen once the agent finishes. On every `session.idle` we verify the live
// deployment state and update the relevant open canvas instance.

export const DEPLOYMENT_REFRESH = "deployment";

const REFRESH_KINDS = new Set([DEPLOYMENT_REFRESH]);

// Upper bound on how many idle cycles we keep re-checking a single pending op
// before giving up. Keeps live Azure polling bounded when the agent never
// reaches the expected state (e.g. the user abandons the deploy).
const DEFAULT_MAX_ATTEMPTS = 12;

// Deployment result reasons that will not resolve by waiting longer, so we stop
// polling instead of burning the whole attempt budget on a doomed deploy.
const DEFINITIVE_DEPLOY_FAILURES = new Set([
    "failed",
    "canceled",
    "cancelled",
    "deleted",
    "not_hosted",
    "unknown_kind",
    "no_project",
    "no_agent",
    "unauthorized",
    "not_signed_in",
    "unavailable",
]);

function isEntryAlive(entry) {
    if (!entry) return false;
    // A retained-but-closed loopback server is stale; treat a missing server
    // object (tests, early lifecycle) as alive.
    if (entry.server && entry.server.listening === false) return false;
    return true;
}

function isDeploymentComplete(deployment) {
    return !!(deployment && deployment.ok && deployment.deployed);
}

function isDeploymentDefinitiveFailure(deployment) {
    if (!deployment) return false;
    return DEFINITIVE_DEPLOY_FAILURES.has(deployment.reason);
}

export function createPendingRefreshManager({
    servers,
    inspectDeployment,
    refreshDeployment,
    log = async () => {},
    onTerminal = async () => {},
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
} = {}) {
    // instanceId -> Map<kind, { attempts, running }>
    const pending = new Map();

    async function safeLog(message, options) {
        try {
            await log(message, options);
        } catch {
            /* logging must never surface an unhandled rejection */
        }
    }

    function mark(instanceId, kind) {
        if (!instanceId || !REFRESH_KINDS.has(kind)) return false;
        let ops = pending.get(instanceId);
        if (!ops) {
            ops = new Map();
            pending.set(instanceId, ops);
        }
        // Re-marking resets the attempt budget but preserves an in-flight run so
        // we never lose the `running` guard against a concurrent refresh.
        const existing = ops.get(kind);
        ops.set(kind, { attempts: 0, running: existing ? existing.running : false });
        return true;
    }

    function clear(instanceId, kind) {
        const ops = pending.get(instanceId);
        if (!ops) return;
        if (kind) ops.delete(kind);
        else ops.clear();
        if (ops.size === 0) pending.delete(instanceId);
    }

    function hasPending() {
        for (const ops of pending.values()) {
            if (ops.size) return true;
        }
        return false;
    }

    async function runDeployment(instanceId, entry, op) {
        const deployment = await inspectDeployment(entry);
        if (isDeploymentComplete(deployment)) {
            // Reuse the verified result so refreshDeployment does not query the
            // live deployment a second time.
            await refreshDeployment(entry, async () => deployment);
            clear(instanceId, DEPLOYMENT_REFRESH);
            await onTerminal(instanceId, DEPLOYMENT_REFRESH, {
                outcome: "succeeded",
                result: deployment,
            });
            return;
        }
        if (isDeploymentDefinitiveFailure(deployment)) {
            clear(instanceId, DEPLOYMENT_REFRESH);
            await onTerminal(instanceId, DEPLOYMENT_REFRESH, {
                outcome: "failed",
                failureCode: deployment.reason,
                result: deployment,
            });
            await safeLog(
                `Automatic deployment refresh for canvas ${instanceId} stopped: deployment reported "${deployment.reason}".`,
                { level: "info" },
            );
            return;
        }
        if (op.attempts >= maxAttempts) {
            clear(instanceId, DEPLOYMENT_REFRESH);
            await onTerminal(instanceId, DEPLOYMENT_REFRESH, {
                outcome: "timed_out",
                failureCode: "timeout",
                result: deployment,
            });
            await safeLog(
                `Automatic deployment refresh for canvas ${instanceId} gave up after ${op.attempts} idle checks; deployment did not complete.`,
                { level: "warning" },
            );
        }
    }

    async function runOp(instanceId, entry, kind, op) {
        op.running = true;
        op.attempts += 1;
        try {
            await runDeployment(instanceId, entry, op);
        } catch (err) {
            await safeLog(
                `Automatic ${kind} refresh failed for canvas ${instanceId}: ${err?.message ?? err}`,
                { level: "error" },
            );
            // A transient failure still counts against the budget so a broken
            // dependency can't keep us polling forever.
            if (op.attempts >= maxAttempts) clear(instanceId, kind);
            if (op.attempts >= maxAttempts) {
                await onTerminal(instanceId, kind, {
                    outcome: "timed_out",
                    failureCode: "timeout",
                });
            }
        } finally {
            op.running = false;
        }
    }

    async function handleSessionIdle() {
        if (!pending.size) return;
        const tasks = [];
        // Snapshot so clearing entries mid-iteration is safe.
        for (const [instanceId, ops] of [...pending]) {
            const entry = servers?.get(instanceId);
            if (!isEntryAlive(entry)) {
                clear(instanceId);
                continue;
            }
            for (const [kind, op] of [...ops]) {
                if (op.running) continue; // avoid concurrent duplicate refreshes
                tasks.push(runOp(instanceId, entry, kind, op));
            }
        }
        await Promise.allSettled(tasks);
    }

    return { mark, clear, hasPending, handleSessionIdle };
}
