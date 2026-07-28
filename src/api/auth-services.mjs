import { emptySelection } from "../../public/selection-state.js";
import { clearFoundryCache } from "../foundry.mjs";
import {
    getIdentity,
    signInCancel,
    signInStart,
    signInStatus,
    signOut,
} from "../foundry-auth.mjs";
import { clearSelection, servers } from "../state.mjs";

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
} = {}) {
    return {
        async getIdentity() {
            return { ok: true, ...(await auth.getIdentity()) };
        },
        signIn() {
            return auth.signInStart();
        },
        async getSignInStatus({ url }) {
            const result = await auth.signInStatus(url.searchParams.get("sessionId") || "");
            if (result.ok && result.status === "done") clearResourceCache();
            return result;
        },
        cancelSignIn({ body }) {
            return auth.signInCancel(typeof body.sessionId === "string" ? body.sessionId : "");
        },
        // Signing out is global, not per-instance: every open canvas has to drop
        // the signed-in selection, not just the one that issued the request.
        async signOut() {
            const result = await auth.signOut();
            if (result.ok) {
                clearResourceCache();
                clearSavedSelection();
                for (const entry of servers.values()) {
                    if (entry?.state) entry.state.selection = emptySelection();
                }
            }
            return result;
        },
    };
}
