// Tracks refresh work that a canvas-originated create/deploy request expects to
// happen once the agent finishes. Instead of asking the model to invoke a canvas
// action, the client marks a pending refresh when it sends the prompt; on every
// `session.idle` we verify the real workspace/deployment state and drive the
// existing refresh functions directly for the relevant open canvas instance.

export const WORKSPACE_REFRESH = "workspace";
export const DEPLOYMENT_REFRESH = "deployment";

const REFRESH_KINDS = new Set([WORKSPACE_REFRESH, DEPLOYMENT_REFRESH]);

// Upper bound on how many idle cycles we keep re-checking a single pending op
// before giving up. Keeps live Azure/workspace polling bounded when the agent
// never reaches the expected state (e.g. the user abandons the deploy).
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
    workspaceRootFn,
    refreshWorkspace,
    inspectDeployment,
    refreshDeployment,
    log = async () => {},
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

    async function runWorkspace(instanceId, entry, op) {
        const result = await refreshWorkspace(entry, workspaceRootFn);
        if (result && result.hasAgent) {
            clear(instanceId, WORKSPACE_REFRESH);
            return;
        }
        if (op.attempts >= maxAttempts) {
            clear(instanceId, WORKSPACE_REFRESH);
            await safeLog(
                `Automatic workspace refresh for canvas ${instanceId} gave up after ${op.attempts} idle checks; hosted-agent code was not detected.`,
                { level: "warn" },
            );
        }
    }

    async function runDeployment(instanceId, entry, op) {
        const deployment = await inspectDeployment(entry);
        if (isDeploymentComplete(deployment)) {
            // Reuse the verified result so refreshDeployment does not query the
            // live deployment a second time.
            await refreshDeployment(entry, async () => deployment);
            clear(instanceId, DEPLOYMENT_REFRESH);
            return;
        }
        if (isDeploymentDefinitiveFailure(deployment)) {
            clear(instanceId, DEPLOYMENT_REFRESH);
            await safeLog(
                `Automatic deployment refresh for canvas ${instanceId} stopped: deployment reported "${deployment.reason}".`,
                { level: "info" },
            );
            return;
        }
        if (op.attempts >= maxAttempts) {
            clear(instanceId, DEPLOYMENT_REFRESH);
            await safeLog(
                `Automatic deployment refresh for canvas ${instanceId} gave up after ${op.attempts} idle checks; deployment did not complete.`,
                { level: "warn" },
            );
        }
    }

    async function runOp(instanceId, entry, kind, op) {
        op.running = true;
        op.attempts += 1;
        try {
            if (kind === WORKSPACE_REFRESH) {
                await runWorkspace(instanceId, entry, op);
            } else if (kind === DEPLOYMENT_REFRESH) {
                await runDeployment(instanceId, entry, op);
            }
        } catch (err) {
            await safeLog(
                `Automatic ${kind} refresh failed for canvas ${instanceId}: ${err?.message ?? err}`,
                { level: "error" },
            );
            // A transient failure still counts against the budget so a broken
            // dependency can't keep us polling forever.
            if (op.attempts >= maxAttempts) clear(instanceId, kind);
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
