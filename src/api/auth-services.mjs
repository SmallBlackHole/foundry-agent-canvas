import { emptySelection } from "../../public/selection-state.js";
import { clearFoundryCache } from "../foundry/foundry.mjs";
import {
    getIdentity,
    signInCancel,
    signInStart,
    signInStatus,
    signOut,
} from "../foundry/foundry-auth.mjs";
import { clearSelection, servers } from "../state.mjs";
import { normalizeFailureCode } from "../telemetry/schema.mjs";
import { runTelemetryOperation } from "../telemetry/operations.mjs";

export function createAuthServices({
    auth = {
        getIdentity,
        signInStart,
        signInStatus,
        signInCancel,
        signOut,
    },
    clearResourceCache = clearFoundryCache,
    clearSavedSelection = clearSelection,
    telemetry,
    now = Date.now,
} = {}) {
    const signInOperations = new Map();

    function finishSignIn(sessionId, outcome, failureCode) {
        const startedAt = signInOperations.get(sessionId);
        if (startedAt === undefined) return;
        signInOperations.delete(sessionId);
        telemetry?.recordOperation?.({
            operation: "sign_in",
            outcome,
            ...(failureCode ? { failureCode } : {}),
            durationMs: Math.max(0, now() - startedAt),
            source: "ui",
        });
    }

    return {
        async getIdentity() {
            return { ok: true, ...(await auth.getIdentity()) };
        },
        async signIn() {
            const startedAt = now();
            try {
                const result = await auth.signInStart();
                if (result?.ok && result?.sessionId) {
                    signInOperations.set(result.sessionId, startedAt);
                } else {
                    telemetry?.recordOperation?.({
                        operation: "sign_in",
                        outcome: "failed",
                        failureCode: normalizeFailureCode(result?.reason),
                        durationMs: Math.max(0, now() - startedAt),
                        source: "ui",
                    });
                }
                return result;
            } catch (error) {
                telemetry?.recordOperation?.({
                    operation: "sign_in",
                    outcome: "failed",
                    failureCode: normalizeFailureCode(error),
                    durationMs: Math.max(0, now() - startedAt),
                    source: "ui",
                });
                throw error;
            }
        },
        async getSignInStatus({ url }) {
            const sessionId = url.searchParams.get("sessionId") || "";
            const result = await auth.signInStatus(sessionId);
            if (result.ok && result.status === "done") clearResourceCache();
            if (result.status === "done") finishSignIn(sessionId, "succeeded");
            else if (result.status === "cancelled") finishSignIn(sessionId, "cancelled", "cancelled");
            else if (result.status === "error") {
                finishSignIn(sessionId, "failed", normalizeFailureCode(result?.reason));
            } else if (result.status === "unknown") {
                finishSignIn(sessionId, "unknown", "unknown");
            }
            return result;
        },
        cancelSignIn({ body }) {
            const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
            const result = auth.signInCancel(sessionId);
            finishSignIn(sessionId, "cancelled", "cancelled");
            return result;
        },
        // Signing out is global, not per-instance: every open canvas has to drop
        // the signed-in selection, not just the one that issued the request.
        async signOut() {
            return runTelemetryOperation(telemetry, {
                operation: "sign_out",
                source: "ui",
                now,
                classify: (result) => result?.ok
                    ? { outcome: "succeeded" }
                    : {
                        outcome: "failed",
                        failureCode: normalizeFailureCode(result?.reason),
                    },
            }, async () => {
                const result = await auth.signOut();
                if (result.ok) {
                    clearResourceCache();
                    clearSavedSelection();
                    for (const entry of servers.values()) {
                        if (entry?.state) entry.state.selection = emptySelection();
                    }
                }
                return result;
            });
        },
    };
}
