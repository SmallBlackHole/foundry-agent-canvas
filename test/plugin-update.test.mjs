import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

import * as pluginUpdateModule from "../src/plugin-update.mjs";
import {
    MARKETPLACE_MANIFEST_URL,
    checkPluginUpdate,
    fetchLatestPluginVersion,
    readInstalledPlugin,
    readPluginManifest,
    resetPluginUpdateCache,
} from "../src/plugin-update.mjs";

function pluginRoot(version = "1.0.4", name = "microsoft-foundry") {
    const root = mkdtempSync(join(tmpdir(), "foundry-plugin-"));
    mkdirSync(join(root, ".github", "plugin"), { recursive: true });
    writeFileSync(
        join(root, ".github", "plugin", "plugin.json"),
        JSON.stringify({ name, version }),
        "utf-8",
    );
    const extensionDir = join(root, "extensions", name);
    mkdirSync(extensionDir, { recursive: true });
    return { root, extensionDir };
}

function manifestFetch(version, { status = 200 } = {}) {
    const calls = [];
    const fetchImpl = async (url) => {
        calls.push(url);
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => ({
                name: "awesome-copilot",
                plugins: [
                    { name: "other-plugin", version: "9.9.9" },
                    ...(version ? [{ name: "microsoft-foundry", version }] : []),
                ],
            }),
        };
    };
    fetchImpl.calls = calls;
    return fetchImpl;
}

test.beforeEach(() => resetPluginUpdateCache());

test("reads the plugin manifest that owns the extension directory", () => {
    const { root, extensionDir } = pluginRoot("1.0.4");
    try {
        assert.deepEqual(readPluginManifest(extensionDir), {
            name: "microsoft-foundry",
            version: "1.0.4",
            manifestPath: join(root, ".github", "plugin", "plugin.json"),
        });
        assert.equal(readPluginManifest(tmpdir()), null);
        assert.equal(readPluginManifest(""), null);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("reads installed plugin state from the owning manifest", () => {
    const { root, extensionDir } = pluginRoot("1.0.4");
    try {
        assert.deepEqual(readInstalledPlugin({ extensionDir }), {
            installed: true,
            source: "manifest",
            version: "1.0.4",
            marketplace: "awesome-copilot",
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("reports no install when the canvas runs from a checkout", () => {
    const installed = readInstalledPlugin({ extensionDir: tmpdir() });
    assert.equal(installed.installed, false);
});

test("reads the published version from the marketplace manifest", async () => {
    const fetchImpl = manifestFetch("1.0.5");
    assert.deepEqual(await fetchLatestPluginVersion({ fetchImpl }), { ok: true, version: "1.0.5" });
    assert.deepEqual(fetchImpl.calls, [MARKETPLACE_MANIFEST_URL]);

    assert.deepEqual(await fetchLatestPluginVersion({ fetchImpl: manifestFetch("1.0.5", { status: 404 }) }), {
        ok: false,
        reason: "http_404",
        version: "",
    });
    assert.deepEqual(await fetchLatestPluginVersion({ fetchImpl: manifestFetch("") }), {
        ok: false,
        reason: "plugin_not_listed",
        version: "",
    });
});

test("offers an update when the marketplace publishes a newer version", async () => {
    const { root, extensionDir } = pluginRoot("1.0.4");
    try {
        const result = await checkPluginUpdate({
            extensionDir,
            fetchImpl: manifestFetch("1.0.5"),
        });

        assert.deepEqual(result, {
            ok: true,
            name: "microsoft-foundry",
            marketplace: "awesome-copilot",
            installedVersion: "1.0.4",
            latestVersion: "1.0.5",
            status: "outdated",
            updateAvailable: true,
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("detects an update from the manifest without exposing a live self-update operation", async () => {
    const { root, extensionDir } = pluginRoot("1.0.4");
    try {
        const result = await checkPluginUpdate({
            extensionDir,
            fetchImpl: manifestFetch("1.0.5"),
        });

        assert.equal(result.updateAvailable, true);
        assert.equal(result.installedVersion, "1.0.4");
        assert.equal("applyPluginUpdate" in pluginUpdateModule, false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("stays quiet when the installed version is current, unknown, or unreachable", async () => {
    const { root, extensionDir } = pluginRoot("1.0.5");
    try {
        const current = await checkPluginUpdate({
            extensionDir,
            fetchImpl: manifestFetch("1.0.5"),
        });
        assert.equal(current.status, "latest");
        assert.equal(current.updateAvailable, false);

        resetPluginUpdateCache();
        const offline = await checkPluginUpdate({
            extensionDir,
            fetchImpl: async () => { throw new Error("offline"); },
        });
        assert.equal(offline.ok, false);
        assert.equal(offline.status, "unknown");
        assert.equal(offline.reason, "fetch_failed");
        assert.equal(offline.updateAvailable, false);

        resetPluginUpdateCache();
        const notInstalled = await checkPluginUpdate({
            extensionDir: tmpdir(),
            fetchImpl: manifestFetch("1.0.5"),
        });
        assert.equal(notInstalled.status, "not_installed");
        assert.equal(notInstalled.updateAvailable, false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("caches a successful check until the ttl expires or a refresh is forced", async () => {
    const { root, extensionDir } = pluginRoot("1.0.4");
    const fetchImpl = manifestFetch("1.0.5");
    try {
        await checkPluginUpdate({ extensionDir, fetchImpl });
        await checkPluginUpdate({ extensionDir, fetchImpl });
        assert.equal(fetchImpl.calls.length, 1);

        await checkPluginUpdate({ extensionDir, fetchImpl, force: true });
        assert.equal(fetchImpl.calls.length, 2);

        let clock = 0;
        resetPluginUpdateCache();
        const now = () => clock;
        await checkPluginUpdate({ extensionDir, fetchImpl, now });
        clock = 5 * 60_000;
        await checkPluginUpdate({ extensionDir, fetchImpl, now });
        assert.equal(fetchImpl.calls.length, 4);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

// ------------------------------------------------------------------ client UI
async function clientSource() {
    return await readFile(
        new URL("../public/app/plugin-update.js", import.meta.url),
        "utf8",
    );
}

function clientFunction(source, name) {
    const pattern = new RegExp(`(async )?function ${name}\\([\\s\\S]*?\\n\\}`);
    const extracted = source.match(pattern)?.[0];
    assert.ok(extracted, `expected ${name} in public/app/plugin-update.js`);
    return extracted;
}

test("the bar concisely directs users to the safe host-managed update flow", async () => {
    const source = clientFunction(await clientSource(), "pluginUpdateMessage");
    const message = (pluginUpdate) => {
        const context = { state: { pluginUpdate } };
        vm.runInNewContext(`${source}\nresult = pluginUpdateMessage();`, context);
        return context.result;
    };

    assert.equal(
        message({ status: "available", installedVersion: "1.0.4", latestVersion: "1.0.5" }),
        "Microsoft Foundry 1.0.5 is available.",
    );
    assert.equal(
        message({ status: "available", installedVersion: "", latestVersion: "1.0.5" }),
        "Microsoft Foundry 1.0.5 is available.",
    );
    assert.equal(
        message({ status: "available", installedVersion: "", latestVersion: "" }),
        "A Microsoft Foundry update is available.",
    );
});

test("the update notice is informational and has no live update control", async () => {
    const source = clientFunction(await clientSource(), "renderPluginUpdate");
    const render = (pluginUpdate) => {
        const bar = { hidden: false };
        const text = { textContent: "" };
        const nodes = { updateBar: bar, updateBarText: text };
        const context = {
            state: { pluginUpdate },
            document: { getElementById: (id) => nodes[id] || null },
            pluginUpdateMessage: () => "message",
        };
        vm.runInNewContext(`${source}\nrenderPluginUpdate();`, context);
        return { bar, text };
    };

    assert.equal(render({ status: "idle" }).bar.hidden, true);
    assert.equal(render({ status: "available", dismissed: true }).bar.hidden, true);

    const available = render({ status: "available" });
    assert.equal(available.bar.hidden, false);
    assert.equal(available.text.textContent, "message");
    assert.doesNotMatch(source, /updateBtn|applyPluginUpdate|postJSON/);
});

test("dismissing hides the bar without touching the pending update", async () => {
    const source = clientFunction(await clientSource(), "dismissPluginUpdate");
    const context = {
        state: {
            pluginUpdate: {
                status: "available",
                installedVersion: "1.0.4",
                latestVersion: "1.0.5",
                dismissed: false,
            },
        },
        renderPluginUpdate() {},
    };

    vm.runInNewContext(`${source}\ndismissPluginUpdate();`, context);

    assert.deepEqual({ ...context.state.pluginUpdate }, {
        status: "available",
        installedVersion: "1.0.4",
        latestVersion: "1.0.5",
        dismissed: true,
    });
});

test("a failed check never surfaces the bar", async () => {
    const source = clientFunction(await clientSource(), "loadPluginUpdate");
    const run = async (getJSON) => {
        const context = {
            state: { pluginUpdate: { status: "idle", installedVersion: "", latestVersion: "" } },
            getJSON,
            renderPluginUpdate() {},
        };
        vm.createContext(context);
        await vm.runInContext(`${source}\nloadPluginUpdate();`, context);
        return { ...context.state.pluginUpdate };
    };

    assert.equal((await run(async () => { throw new Error("offline"); })).status, "idle");
    assert.equal((await run(async () => ({ ok: true, updateAvailable: false }))).status, "idle");
    assert.deepEqual(
        await run(async () => ({ ok: true, updateAvailable: true, installedVersion: "1.0.4", latestVersion: "1.0.5" })),
        { status: "available", installedVersion: "1.0.4", latestVersion: "1.0.5", dismissed: false },
    );
});
