import assert from "node:assert/strict";
import test from "node:test";

import {
    createFoundryAuth,
    FOUNDRY_SCOPE,
    MANAGEMENT_SCOPE,
} from "../src/foundry-auth.mjs";

function jwt(payload) {
    return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

test("prefers DefaultAzureCredential and caches its token by scope", async () => {
    let credentialCalls = 0;
    const cliCalls = [];
    class DefaultAzureCredential {
        async getToken(scope) {
            credentialCalls += 1;
            assert.equal(scope, FOUNDRY_SCOPE);
            return { token: "identity-token", expiresOnTimestamp: 10_000_000 };
        }
    }
    const auth = createFoundryAuth({
        loadIdentity: async () => ({ DefaultAzureCredential }),
        runCli: (...args) => {
            cliCalls.push(args);
            return { status: 1, stdout: "" };
        },
        now: () => 1_000,
    });

    assert.equal(await auth.getToken(), "identity-token");
    assert.equal(await auth.getToken(), "identity-token");
    assert.equal(credentialCalls, 1);
    assert.deepEqual(cliCalls, []);
});

test("falls back from Azure identity to az before azd and caches the CLI token", async () => {
    const cliCalls = [];
    class DefaultAzureCredential {
        async getToken() {
            return null;
        }
    }
    const auth = createFoundryAuth({
        loadIdentity: async () => ({ DefaultAzureCredential }),
        runCli: (bin) => {
            cliCalls.push(bin);
            if (bin === "az") {
                return {
                    status: 0,
                    stdout: JSON.stringify({
                        accessToken: "az-token",
                        expires_on: 10_000,
                    }),
                };
            }
            return { status: 1, stdout: "" };
        },
        now: () => 1_000,
    });

    assert.equal(await auth.getToken(MANAGEMENT_SCOPE), "az-token");
    assert.equal(await auth.getToken(MANAGEMENT_SCOPE), "az-token");
    assert.deepEqual(cliCalls, ["az"]);
});

test("tracks interactive sign-in completion, cancellation, and sign-out", async () => {
    const pending = [];
    let nextSession = 0;
    class DefaultAzureCredential {
        async getToken() {
            return null;
        }
    }
    class InteractiveBrowserCredential {
        constructor(options) {
            assert.deepEqual(options, { redirectUri: "http://localhost" });
            this.calls = 0;
        }

        getToken(scope, options = {}) {
            this.calls += 1;
            assert.equal(scope, MANAGEMENT_SCOPE);
            if (this.calls > 1) {
                return Promise.resolve({
                    token: jwt({ preferred_username: "person@example.com", tid: "tenant-1" }),
                });
            }
            return new Promise((resolve, reject) => {
                options.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")));
                pending.push({ resolve });
            });
        }
    }
    const auth = createFoundryAuth({
        loadIdentity: async () => ({
            DefaultAzureCredential,
            InteractiveBrowserCredential,
        }),
        runCli: () => ({ status: 1, stdout: "" }),
        createSessionId: () => `session-${++nextSession}`,
        launchWaitMs: 0,
    });

    assert.deepEqual(await auth.signInStart(), {
        ok: true,
        sessionId: "session-1",
        mode: "interactive",
    });
    assert.deepEqual(await auth.signInStatus("session-1"), {
        ok: true,
        status: "pending",
        mode: "interactive",
    });
    pending[0].resolve({ token: "signed-in" });
    await Promise.resolve();
    assert.deepEqual(await auth.signInStatus("session-1"), {
        ok: true,
        status: "done",
        identity: {
            signedIn: true,
            account: "person@example.com",
            tenantId: "tenant-1",
        },
    });

    await auth.signInStart();
    assert.deepEqual(auth.signInCancel("session-2"), { ok: true });
    assert.deepEqual(await auth.signInStatus("session-2"), {
        ok: false,
        status: "unknown",
    });

    await auth.signInStart();
    assert.deepEqual(await auth.signOut(), { ok: true });
    assert.deepEqual(await auth.signInStatus("session-3"), {
        ok: false,
        status: "unknown",
    });
});

test("releases a sign-in session after an immediate browser launch failure", async () => {
    let clock = 0;
    class InteractiveBrowserCredential {
        getToken() {
            return Promise.reject(new Error("browser unavailable"));
        }
    }
    const auth = createFoundryAuth({
        loadIdentity: async () => ({ InteractiveBrowserCredential }),
        runCli: () => ({ status: 1, stdout: "" }),
        createSessionId: () => "failed-session",
        now: () => clock++,
        sleep: async () => {},
        launchWaitMs: 10,
    });

    assert.deepEqual(await auth.signInStart(), {
        ok: false,
        sessionId: "failed-session",
        reason: "login_failed",
        error: "browser unavailable",
    });
    assert.deepEqual(await auth.signInStatus("failed-session"), {
        ok: false,
        status: "unknown",
    });
});

test("sign-out drops cached credentials and tokens", async () => {
    let credentials = 0;
    class DefaultAzureCredential {
        constructor() {
            this.id = ++credentials;
        }

        async getToken() {
            return {
                token: `token-${this.id}`,
                expiresOnTimestamp: 10_000_000,
            };
        }
    }
    const auth = createFoundryAuth({
        loadIdentity: async () => ({ DefaultAzureCredential }),
        runCli: () => ({ status: 1, stdout: "" }),
        now: () => 1_000,
    });

    assert.equal(await auth.getToken(), "token-1");
    const beforeSignOut = auth.getGeneration();
    await auth.signOut();
    assert.equal(auth.getGeneration(), beforeSignOut + 1);
    assert.equal(await auth.getToken(), "token-2");
});

test("an in-flight token request cannot restore the cache after sign-out", async () => {
    let resolveFirst;
    let credentials = 0;
    class DefaultAzureCredential {
        constructor() {
            this.id = ++credentials;
        }

        getToken() {
            if (this.id === 1) {
                return new Promise((resolve) => {
                    resolveFirst = resolve;
                });
            }
            return Promise.resolve({
                token: "new-token",
                expiresOnTimestamp: 10_000_000,
            });
        }
    }
    const auth = createFoundryAuth({
        loadIdentity: async () => ({ DefaultAzureCredential }),
        runCli: () => ({ status: 1, stdout: "" }),
        now: () => 1_000,
    });

    const staleRequest = auth.getToken();
    await Promise.resolve();
    await auth.signOut();
    resolveFirst({
        token: "stale-token",
        expiresOnTimestamp: 10_000_000,
    });
    await assert.rejects(staleRequest, /auth_changed/);
    assert.equal(await auth.getToken(), "new-token");
    assert.equal(credentials, 2);
});

test("a delayed identity load cannot restore the credential after sign-out", async () => {
    let resolveIdentity;
    let credentials = 0;
    class DefaultAzureCredential {
        constructor() {
            this.id = ++credentials;
        }

        async getToken() {
            return {
                token: `token-${this.id}`,
                expiresOnTimestamp: 10_000_000,
            };
        }
    }
    const identityModule = { DefaultAzureCredential };
    let firstLoad = true;
    const auth = createFoundryAuth({
        loadIdentity: () => {
            if (!firstLoad) return Promise.resolve(identityModule);
            firstLoad = false;
            return new Promise((resolve) => {
                resolveIdentity = () => resolve(identityModule);
            });
        },
        runCli: () => ({ status: 1, stdout: "" }),
        now: () => 1_000,
    });

    const staleRequest = auth.getToken();
    await Promise.resolve();
    await auth.signOut();
    resolveIdentity();
    await assert.rejects(staleRequest, /auth_changed/);
    assert.equal(await auth.getToken(), "token-1");
    assert.equal(credentials, 1);
});
