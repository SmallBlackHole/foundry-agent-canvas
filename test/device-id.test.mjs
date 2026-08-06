import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    getOrCreateUnixDeviceId,
    getOrCreateWindowsDeviceId,
    resolveUnixDeviceIdRoot,
} from "../src/telemetry/device-id.mjs";

async function testDirectory(t) {
    const root = await mkdtemp(join(tmpdir(), "foundry-canvas-device-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}

test("Unix device ID uses Skylight config paths and persists a lowercase UUID", async (t) => {
    const root = await testDirectory(t);
    const expected = "abcdefab-cdef-abcd-efab-cdefabcdefab";
    const first = await getOrCreateUnixDeviceId({
        storageRoot: root,
        createId: () => expected.toUpperCase(),
    });
    const path = join(root, "Microsoft", "DeveloperTools", "deviceid");

    assert.equal(first, expected);
    assert.equal(await readFile(path, "utf-8"), expected);
    assert.equal(
        await getOrCreateUnixDeviceId({
            storageRoot: root,
            createId: () => assert.fail("must preserve the existing value"),
        }),
        expected,
    );
    assert.equal(
        resolveUnixDeviceIdRoot({
            platform: "darwin",
            home: "/Users/example",
            env: {},
        }),
        join("/Users/example", "Library", "Application Support"),
    );
    assert.equal(
        resolveUnixDeviceIdRoot({
            platform: "linux",
            home: "/home/example",
            env: { XDG_CONFIG_HOME: "/config" },
        }),
        "/config",
    );
});

test("Unix device ID preserves any existing non-empty value and fails closed", async (t) => {
    const root = await testDirectory(t);
    const directory = join(root, "Microsoft", "DeveloperTools");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "deviceid"), "existing-device\n", "utf-8");

    assert.equal(await getOrCreateUnixDeviceId({ storageRoot: root }), "existing-device");

    const blockingFile = join(root, "not-a-directory");
    await writeFile(blockingFile, "x", "utf-8");
    assert.equal(
        await getOrCreateUnixDeviceId({ storageRoot: blockingFile }),
        null,
    );
});

test("Unix device ID does not overwrite a value that cannot be read", async () => {
    let writes = 0;
    const error = Object.assign(new Error("access denied"), { code: "EACCES" });
    const id = await getOrCreateUnixDeviceId({
        storageRoot: "/config",
        read: async () => {
            throw error;
        },
        makeDirectory: async () => {
            writes += 1;
        },
        write: async () => {
            writes += 1;
        },
    });

    assert.equal(id, null);
    assert.equal(writes, 0);
});

test("Windows device ID preserves the registry value and creates only when missing", async () => {
    const existingCalls = [];
    const existing = await getOrCreateWindowsDeviceId({
        run: async (args) => {
            existingCalls.push(args);
            return {
                stdout: "    deviceid    REG_SZ    Existing-Device  \r\n",
            };
        },
    });
    assert.equal(existing, "Existing-Device  ");
    assert.equal(existingCalls.length, 1);

    const createCalls = [];
    const created = await getOrCreateWindowsDeviceId({
        createId: () => "ABCDEFAB-CDEF-ABCD-EFAB-CDEFABCDEFAB",
        run: async (args) => {
            createCalls.push(args);
            if (args[0] === "query") throw new Error("missing");
            return { stdout: "The operation completed successfully." };
        },
    });
    assert.equal(created, "abcdefab-cdef-abcd-efab-cdefabcdefab");
    assert.equal(createCalls[1][0], "add");
    assert.ok(createCalls[1].includes("abcdefab-cdef-abcd-efab-cdefabcdefab"));

    assert.equal(
        await getOrCreateWindowsDeviceId({
            run: async () => {
                throw new Error("registry unavailable");
            },
        }),
        null,
    );
});

test("Windows native registry persistence uses the shared contract", {
    skip: process.platform !== "win32" || process.env.CI !== "true",
}, async (t) => {
    const keyPath =
        `HKCU\\SOFTWARE\\Microsoft\\DeveloperTools\\foundry-canvas-tests\\${randomUUID()}`;
    const providerHandle = setInterval(() => {}, 1_000);
    t.after(() => {
        clearInterval(providerHandle);
        spawnSync("reg.exe", ["delete", keyPath, "/f"], {
            windowsHide: true,
            stdio: "ignore",
        });
    });

    const first = await getOrCreateWindowsDeviceId({ keyPath });
    const second = await getOrCreateWindowsDeviceId({ keyPath });

    assert.match(
        first,
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
    );
    assert.equal(second, first);
});
