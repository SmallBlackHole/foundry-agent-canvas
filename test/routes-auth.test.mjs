import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeApiServices } from "../src/routes.mjs";
import { servers } from "../src/state.mjs";

test("clears identity-scoped resource cache after sign-in and sign-out", async () => {
    const instanceId = "auth-cache-test";
    const otherInstanceId = "auth-cache-other-test";
    const cacheClears = [];
    const selectionClears = [];
    const statuses = [
        { ok: true, status: "pending", mode: "interactive" },
        { ok: true, status: "done", identity: { signedIn: true } },
    ];
    servers.set(instanceId, {
        state: {
            selection: {
                subscription: { id: "sub-1", name: "Subscription" },
                project: {
                    endpoint: "https://example.test/api/projects/project",
                    name: "Project",
                    subscriptionId: "sub-1",
                },
            },
        },
    });
    servers.set(otherInstanceId, {
        state: {
            selection: {
                subscription: { id: "sub-2", name: "Other Subscription" },
                project: null,
            },
        },
    });

    const services = createRuntimeApiServices(instanceId, {
        session: { log: async () => {}, send: async () => {} },
        workspaceRootFn: async () => "",
        auth: {
            getIdentity: async () => ({ signedIn: true }),
            signInStart: async () => ({ ok: true, sessionId: "session-1" }),
            signInStatus: async () => statuses.shift(),
            signInCancel: () => ({ ok: true }),
            signOut: async () => ({ ok: true }),
        },
        clearResourceCache: () => cacheClears.push("clear"),
        clearSavedSelection: () => selectionClears.push("clear"),
    });
    const request = {
        url: new URL("http://localhost/api/signin/status?sessionId=session-1"),
    };

    try {
        assert.equal((await services.getSignInStatus(request)).status, "pending");
        assert.deepEqual(cacheClears, []);

        assert.equal((await services.getSignInStatus(request)).status, "done");
        assert.deepEqual(cacheClears, ["clear"]);

        assert.deepEqual(await services.signOut(), { ok: true });
        assert.deepEqual(cacheClears, ["clear", "clear"]);
        assert.deepEqual(selectionClears, ["clear"]);
        assert.deepEqual(servers.get(instanceId).state.selection, {
            subscription: { id: "", name: "" },
            project: null,
        });
        assert.deepEqual(servers.get(otherInstanceId).state.selection, {
            subscription: { id: "", name: "" },
            project: null,
        });
    } finally {
        servers.delete(instanceId);
        servers.delete(otherInstanceId);
    }
});

test("keeps caches and selection when sign-out fails", async () => {
    const instanceId = "auth-signout-failure-test";
    const originalSelection = {
        subscription: { id: "sub-1", name: "Subscription" },
        project: null,
    };
    const entry = { state: { selection: originalSelection } };
    servers.set(instanceId, entry);
    let cacheClears = 0;
    let selectionClears = 0;
    const services = createRuntimeApiServices(instanceId, {
        session: { log: async () => {}, send: async () => {} },
        workspaceRootFn: async () => "",
        auth: {
            signOut: async () => ({ ok: false, reason: "failed" }),
        },
        clearResourceCache: () => {
            cacheClears += 1;
        },
        clearSavedSelection: () => {
            selectionClears += 1;
        },
    });

    try {
        assert.deepEqual(await services.signOut(), { ok: false, reason: "failed" });
        assert.equal(cacheClears, 0);
        assert.equal(selectionClears, 0);
        assert.equal(entry.state.selection, originalSelection);
    } finally {
        servers.delete(instanceId);
    }
});

test("reports unsupported hosted-agent regions to the chat timeline once per project", async () => {
    const instanceId = "region-warning-test";
    const logs = [];
    const entry = {
        state: {
            selection: {
                subscription: { id: "sub-1", name: "Subscription" },
                project: {
                    endpoint: "https://example.test/api/projects/east",
                    name: "East project",
                    location: "eastus",
                    subscriptionId: "sub-1",
                },
            },
        },
    };
    servers.set(instanceId, entry);
    const services = createRuntimeApiServices(instanceId, {
        session: {
            log: async (message, options) => logs.push({ message, options }),
            send: async () => {},
        },
        workspaceRootFn: async () => "",
    });

    try {
        assert.equal((await services.getRegionSupport()).supported, false);
        assert.equal((await services.getRegionSupport()).supported, false);
        assert.deepEqual(logs, [{
            message: "Hosted agents aren't available in this project's region (eastus). "
                + "Select a project in a supported region before deploying.",
            options: { level: "warning" },
        }]);

        entry.state.selection.project = {
            ...entry.state.selection.project,
            endpoint: "https://example.test/api/projects/west",
            name: "West project",
            location: "westus",
        };
        assert.equal((await services.getRegionSupport()).supported, true);
        assert.equal(logs.length, 1);

        entry.state.selection.project = {
            ...entry.state.selection.project,
            endpoint: "https://example.test/api/projects/central",
            name: "Central project",
            location: "centralus",
        };
        assert.equal((await services.getRegionSupport()).supported, false);
        assert.equal(logs.length, 2);
    } finally {
        servers.delete(instanceId);
    }
});
