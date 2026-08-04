import { AIProjectClient } from "@azure/ai-projects";

import { FOUNDRY_SCOPE, getToken as getCanvasToken } from "../foundry-auth.mjs";

const TOKEN_LIFETIME_MS = 5 * 60_000;

function abortError() {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    return error;
}

function firstScope(scopes) {
    const values = Array.isArray(scopes) ? scopes : [scopes];
    return values.find((scope) => typeof scope === "string" && scope) || FOUNDRY_SCOPE;
}

export function createCanvasTokenCredential({
    getAccessToken = getCanvasToken,
    now = Date.now,
} = {}) {
    return {
        async getToken(scopes, options = {}) {
            if (options.abortSignal?.aborted) throw abortError();
            const token = await getAccessToken(firstScope(scopes));
            if (options.abortSignal?.aborted) throw abortError();
            return {
                token,
                expiresOnTimestamp: now() + TOKEN_LIFETIME_MS,
            };
        },
    };
}

export function createFoundryProjectClient(endpoint, credential) {
    return new AIProjectClient(endpoint, credential);
}
