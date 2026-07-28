import assert from "node:assert/strict";
import test from "node:test";

import { createApiRouter } from "../src/api-router.mjs";
import { createRuntimeApiServices } from "../src/routes.mjs";

function servicesWith(pluginUpdate, session = { log: async () => {} }) {
    return createRuntimeApiServices("plugin-update-test", {
        session,
        inspectorUiDir: "inspector-ui",
        extensionDir: "C:\\plugins\\microsoft-foundry\\extensions\\microsoft-foundry",
        workspaceRootFn: async () => "C:\\workspace",
        pluginUpdate,
    });
}

test("passes the extension directory and refresh flag to the update check", async () => {
    const calls = [];
    const services = servicesWith({
        check: async (args) => {
            calls.push(args);
            return { ok: true, updateAvailable: true, latestVersion: "1.0.5" };
        },
    });

    const result = await services.getPluginUpdate({
        url: new URL("http://127.0.0.1/api/plugin-update?refresh=1"),
    });

    assert.deepEqual(result, { ok: true, updateAvailable: true, latestVersion: "1.0.5" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].force, true);
    assert.equal(
        calls[0].extensionDir,
        "C:\\plugins\\microsoft-foundry\\extensions\\microsoft-foundry",
    );
    assert.equal("session" in calls[0], false);

    await services.getPluginUpdate({ url: new URL("http://127.0.0.1/api/plugin-update") });
    assert.equal(calls[1].force, false);
});

test("does not expose a runtime plugin update service", () => {
    const services = servicesWith({
        check: async () => ({ ok: true, updateAvailable: false }),
    });

    assert.equal(services.applyPluginUpdate, undefined);
});

test("routes only the read-only plugin update endpoint", async () => {
    const router = createApiRouter({
        services: {
            getPluginUpdate: () => ({ ok: true, updateAvailable: true }),
        },
    });
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => router(req, res));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
        const check = await fetch(`${base}/api/plugin-update`);
        assert.deepEqual(await check.json(), { ok: true, updateAvailable: true });

        const apply = await fetch(`${base}/api/plugin-update`, { method: "POST" });
        assert.equal(apply.status, 404);
        assert.equal(await apply.text(), "Not found");
    } finally {
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
});
