import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import test from "node:test";

import { createApiRouter } from "../src/api-router.mjs";

async function withRouter(services, run, options = {}) {
    const errors = [];
    const router = createApiRouter({
        services,
        bodyLimit: options.bodyLimit,
        reportError: async (error, request) => errors.push({ error, request }),
    });
    const server = createServer((req, res) => router(req, res));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    try {
        await run(`http://127.0.0.1:${port}`, errors);
    } finally {
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
}

async function json(response) {
    return {
        status: response.status,
        body: await response.json(),
    };
}

test("dispatches a known route and returns text 404 for an unknown API route", async () => {
    await withRouter({
        getState: ({ url }) => ({
            ok: true,
            refresh: url.searchParams.get("refresh"),
        }),
    }, async (base) => {
        assert.deepEqual(await json(await fetch(`${base}/api/state?refresh=1`)), {
            status: 200,
            body: { ok: true, refresh: "1" },
        });

        const missing = await fetch(`${base}/api/not-real`);
        assert.equal(missing.status, 404);
        assert.equal(await missing.text(), "Not found");
    });
});

test("uses one malformed and oversized JSON error path", async () => {
    let calls = 0;
    await withRouter({
        selectSubscription: () => {
            calls += 1;
            return { ok: true };
        },
    }, async (base, errors) => {
        assert.deepEqual(await json(await fetch(`${base}/api/select-subscription`, {
            method: "POST",
            body: "{",
        })), {
            status: 400,
            body: { ok: false, error: "Malformed JSON" },
        });

        assert.deepEqual(await json(await fetch(`${base}/api/select-subscription`, {
            method: "POST",
            body: JSON.stringify({ subscriptionId: "too-long" }),
        })), {
            status: 413,
            body: { ok: false, error: "Body too large" },
        });

        await new Promise((resolve, reject) => {
            const req = request(`${base}/api/select-subscription`, {
                method: "POST",
                headers: {
                    Connection: "close",
                    "Transfer-Encoding": "chunked",
                },
            }, (response) => {
                assert.equal(response.statusCode, 413);
                response.resume();
                response.on("end", resolve);
                req.end();
            });
            req.on("error", reject);
            req.write("123456789");
        });
        assert.equal(calls, 0);
        assert.deepEqual(errors, []);
    }, { bodyLimit: 8 });
});

test("validates and dispatches canonical selection writes", async () => {
    const received = [];
    await withRouter({
        selectSubscription: ({ body }) => {
            received.push(["subscription", body]);
            return {
                ok: true,
                selection: {
                    subscription: { id: body.subscriptionId, name: body.subscriptionName },
                    project: null,
                },
            };
        },
        selectProject: ({ body }) => {
            received.push(["project", body]);
            return {
                ok: true,
                selection: {
                    subscription: { id: body.subscriptionId, name: "" },
                    project: {
                        subscriptionId: body.subscriptionId,
                        endpoint: body.endpoint,
                    },
                },
            };
        },
    }, async (base) => {
        const subscription = await json(await fetch(`${base}/api/select-subscription`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                subscriptionId: " sub-1 ",
                subscriptionName: "Subscription",
            }),
        }));
        assert.equal(subscription.body.selection.subscription.id, "sub-1");

        const project = await json(await fetch(`${base}/api/select-project`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                subscriptionId: "sub-1",
                endpoint: " https://example.test/api/projects/one ",
            }),
        }));
        assert.equal(project.body.selection.project.endpoint, "https://example.test/api/projects/one");

        assert.deepEqual(await json(await fetch(`${base}/api/select-project`, {
            method: "POST",
            body: "{}",
        })), {
            status: 400,
            body: { ok: false, error: "Missing endpoint" },
        });
        assert.deepEqual(received.map(([kind, body]) => [kind, body.subscriptionId, body.endpoint]), [
            ["subscription", "sub-1", undefined],
            ["project", "sub-1", "https://example.test/api/projects/one"],
        ]);
    });
});

test("passes resource query parameters through the shared route", async () => {
    await withRouter({
        listToolboxTools: ({ url }) => ({
            ok: true,
            items: [{
                name: url.searchParams.get("name"),
                version: url.searchParams.get("version"),
            }],
        }),
    }, async (base) => {
        assert.deepEqual(await json(await fetch(
            `${base}/api/toolbox/tools?name=Research&version=2`,
        )), {
            status: 200,
            body: {
                ok: true,
                items: [{ name: "Research", version: "2" }],
            },
        });
    });
});

test("validates prompt handoff and preserves pending refresh metadata", async () => {
    const sent = [];
    await withRouter({
        sendPrompt: ({ body }) => {
            sent.push(body);
            return { preview: true };
        },
    }, async (base) => {
        assert.deepEqual(await json(await fetch(`${base}/api/send`, {
            method: "POST",
            body: JSON.stringify({ prompt: "  deploy it  ", refresh: "deployment" }),
        })), {
            status: 200,
            body: { ok: true, preview: true },
        });
        assert.deepEqual(sent, [{ prompt: "deploy it", refresh: "deployment" }]);

        assert.deepEqual(await json(await fetch(`${base}/api/send`, {
            method: "POST",
            body: JSON.stringify({ prompt: " " }),
        })), {
            status: 400,
            body: { ok: false, error: "Missing prompt" },
        });
    });
});

test("serves region state and deployment playground redirects", async () => {
    await withRouter({
        getRegionSupport: () => ({
            ok: true,
            location: "eastus2",
            supported: true,
            regions: ["eastus2"],
            docsUrl: "https://example.test/regions",
        }),
        getHostedAgentDeployment: () => ({
            ok: true,
            deployed: true,
            available: true,
            portalUrl: "https://ai.azure.com/agent",
        }),
        getHostedAgentPlayground: () => ({
            ok: true,
            available: true,
            portalUrl: "/__preview-playground?agent=one",
        }),
    }, async (base) => {
        const region = await json(await fetch(`${base}/api/region-support`));
        assert.equal(region.body.location, "eastus2");
        assert.equal(region.body.supported, true);

        const deployment = await json(await fetch(`${base}/api/hosted-agent-deployment`));
        assert.equal(deployment.body.deployed, true);

        const playground = await fetch(`${base}/api/hosted-agent-playground`, {
            redirect: "manual",
        });
        assert.equal(playground.status, 302);
        assert.equal(playground.headers.get("location"), "/__preview-playground?agent=one");
    });
});

test("preserves auth status payloads and inspector responses", async () => {
    const calls = [];
    await withRouter({
        signIn: () => ({ ok: true, sessionId: "signin-1" }),
        getSignInStatus: ({ url }) => ({
            ok: true,
            status: "done",
            sessionId: url.searchParams.get("sessionId"),
        }),
        cancelSignIn: ({ body }) => {
            calls.push(body.sessionId);
            return { ok: true };
        },
        signOut: () => ({ ok: true }),
        getInspectorReady: () => ({ ready: false }),
        startInspector: () => ({ ok: false, error: "Preview only" }),
    }, async (base) => {
        assert.equal((await json(await fetch(`${base}/api/signin`, { method: "POST" }))).body.sessionId, "signin-1");
        assert.deepEqual(await json(await fetch(`${base}/api/signin/status?sessionId=signin-1`)), {
            status: 200,
            body: { ok: true, status: "done", sessionId: "signin-1" },
        });
        await fetch(`${base}/api/signin/cancel`, {
            method: "POST",
            body: JSON.stringify({ sessionId: "signin-1" }),
        });
        assert.deepEqual(calls, ["signin-1"]);
        assert.deepEqual((await json(await fetch(`${base}/api/inspect/ready`))).body, { ready: false });
        assert.deepEqual((await json(await fetch(`${base}/api/inspect/start`))).body, {
            ok: false,
            error: "Preview only",
        });
        assert.deepEqual((await json(await fetch(`${base}/api/signout`, { method: "POST" }))).body, { ok: true });
    });
});

test("reports service failures once and returns the shared 500 response", async () => {
    await withRouter({
        startInspector: () => {
            throw new Error("inspector exploded");
        },
    }, async (base, errors) => {
        assert.deepEqual(await json(await fetch(`${base}/api/inspect/start`)), {
            status: 500,
            body: { ok: false, error: "inspector exploded" },
        });
        assert.equal(errors.length, 1);
        assert.deepEqual(errors[0].request, {
            method: "GET",
            path: "/api/inspect/start",
        });
    });
});
