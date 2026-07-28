import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolvePluginVersion } from "../src/plugin-update.mjs";

test("prefers marketplace plugin metadata over the extension package version", async () => {
    const root = await mkdtemp(join(tmpdir(), "foundry-plugin-version-"));
    const extensionDir = join(root, "extensions", "microsoft-foundry");
    const manifestDir = join(root, ".github", "plugin");
    try {
        await mkdir(extensionDir, { recursive: true });
        await mkdir(manifestDir, { recursive: true });
        await writeFile(join(extensionDir, "package.json"), JSON.stringify({ version: "1.0.0" }));
        await writeFile(
            join(manifestDir, "plugin.json"),
            JSON.stringify({ name: "microsoft-foundry", version: "1.2.3" }),
        );

        assert.equal(resolvePluginVersion(extensionDir), "1.2.3");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("falls back to the standalone extension package version", async () => {
    const extensionDir = await mkdtemp(join(tmpdir(), "foundry-extension-version-"));
    try {
        await writeFile(join(extensionDir, "package.json"), JSON.stringify({ version: "2.0.0" }));
        assert.equal(resolvePluginVersion(extensionDir), "2.0.0");
    } finally {
        await rm(extensionDir, { recursive: true, force: true });
    }
});
