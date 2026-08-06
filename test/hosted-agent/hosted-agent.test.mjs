import test from "node:test";
import assert from "node:assert/strict";

import { resolveHostedAgentPortalAction } from "../../src/hosted-agent/hosted-agent.mjs";

const metadata = {
    endpoint: "https://example.services.ai.azure.com/api/projects/example-project",
    agentName: "example-agent",
    subscriptionId: "00000000-0000-0000-0000-000000000000",
    resourceGroup: "example-rg",
    accountName: "example",
    projectName: "example-project",
};

function response(status, body = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
            return body;
        },
    };
}

test("exposes the exact hosted agent version when the live resource is deployed", async () => {
    const calls = [];
    const result = await resolveHostedAgentPortalAction(metadata, {
        getToken: async () => "token",
        fetchImpl: async (url, init) => {
            calls.push({ url, init });
            return response(200, {
                name: "example-agent",
                versions: {
                    latest: {
                        version: "7",
                        definition: { kind: "hosted" },
                    },
                },
            });
        },
    });

    assert.equal(result.ok, true);
    assert.equal(result.deployed, true);
    assert.equal(result.available, true);
    assert.equal(
        result.portalUrl,
        "https://ai.azure.com/nextgen/r/AAAAAAAAAAAAAAAAAAAAAA,example-rg,,example,example-project/build/agents/example-agent/build?version=7",
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/agents\/example-agent\?api-version=v1$/);
    assert.equal(calls[0].init.headers["Foundry-Features"], "HostedAgents=V1Preview");
});

test("keeps the portal action hidden when the agent has not been deployed", async () => {
    const result = await resolveHostedAgentPortalAction(metadata, {
        getToken: async () => "token",
        fetchImpl: async () => response(404),
    });

    assert.equal(result.ok, true);
    assert.equal(result.deployed, false);
    assert.equal(result.available, false);
    assert.equal(result.portalUrl, "");
    assert.equal(result.reason, "not_found");
});

test("keeps a deployed agent hidden when reliable portal metadata is missing", async () => {
    const result = await resolveHostedAgentPortalAction(
        { ...metadata, resourceGroup: "" },
        {
            getToken: async () => "token",
            fetchImpl: async () =>
                response(200, {
                    name: "example-agent",
                    versions: { latest: { version: "3", definition: { kind: "hosted" } } },
                }),
        },
    );

    assert.equal(result.deployed, true);
    assert.equal(result.available, false);
    assert.equal(result.portalUrl, "");
});

test("does not reuse a previous deployed result after a later lookup error", async () => {
    let lookup = 0;
    const deps = {
        getToken: async () => "token",
        fetchImpl: async () => {
            lookup += 1;
            if (lookup === 1) {
                return response(200, {
                    name: "example-agent",
                    versions: { latest: { version: "9", definition: { kind: "hosted" } } },
                });
            }
            return response(500);
        },
    };

    const deployed = await resolveHostedAgentPortalAction(metadata, deps);
    const errored = await resolveHostedAgentPortalAction(metadata, deps);

    assert.equal(deployed.available, true);
    assert.equal(errored.ok, false);
    assert.equal(errored.deployed, false);
    assert.equal(errored.available, false);
    assert.equal(errored.portalUrl, "");
    assert.equal(lookup, 2);
});
