import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const WINDOWS_KEY = "HKCU\\SOFTWARE\\Microsoft\\DeveloperTools";
const WINDOWS_VALUE = "deviceid";

function generateDeviceId(createId = randomUUID) {
    return createId().toLowerCase();
}

async function runRegistry(args) {
    return new Promise((resolve, reject) => {
        const child = spawn("reg.exe", args, {
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        child.unref();
        child.stdout.unref?.();
        child.stderr.unref?.();

        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf-8");
        child.stderr.setEncoding("utf-8");
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (code) => {
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error(`reg.exe exited with code ${code}`));
        });
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error("reg.exe timed out"));
        }, 2_000);
        timer.unref?.();
        child.once("close", () => clearTimeout(timer));
    });
}

function parseRegistryValue(output) {
    const line = String(output || "")
        .split(/\r?\n/)
        .find((value) => /^\s*deviceid\s+REG_\w+\s+/i.test(value));
    const match = line?.match(/^\s*deviceid\s+REG_\w+\s+(.*)$/i);
    return match?.[1] ?? "";
}

export async function getOrCreateWindowsDeviceId({
    run = runRegistry,
    createId = randomUUID,
    keyPath = WINDOWS_KEY,
    valueName = WINDOWS_VALUE,
} = {}) {
    try {
        try {
            const result = await run(["query", keyPath, "/v", valueName]);
            const existing = parseRegistryValue(result?.stdout);
            if (existing !== "") return existing;
        } catch {
            /* a missing key/value is created below */
        }

        const id = generateDeviceId(createId);
        await run([
            "add",
            keyPath,
            "/v",
            valueName,
            "/t",
            "REG_SZ",
            "/d",
            id,
            "/f",
        ]);
        return id;
    } catch {
        return null;
    }
}

export function resolveUnixDeviceIdRoot({
    platform = process.platform,
    env = process.env,
    home = homedir(),
} = {}) {
    if (platform === "darwin") {
        return join(home, "Library", "Application Support");
    }
    return env.XDG_CONFIG_HOME || join(home, ".config");
}

export async function getOrCreateUnixDeviceId({
    platform = process.platform,
    env = process.env,
    home = homedir(),
    storageRoot,
    createId = randomUUID,
    read = readFile,
    makeDirectory = mkdir,
    write = writeFile,
} = {}) {
    try {
        const root = storageRoot || resolveUnixDeviceIdRoot({ platform, env, home });
        const directory = join(root, "Microsoft", "DeveloperTools");
        const path = join(directory, "deviceid");
        try {
            const existing = (await read(path, "utf-8")).trim();
            if (existing) return existing;
        } catch (error) {
            if (error?.code !== "ENOENT") return null;
        }

        await makeDirectory(directory, { recursive: true });
        const id = generateDeviceId(createId);
        await write(path, id, { encoding: "utf-8", mode: 0o600 });
        return id;
    } catch {
        return null;
    }
}

export function getOrCreateDeviceId(options = {}) {
    const platform = options.platform || process.platform;
    return platform === "win32"
        ? getOrCreateWindowsDeviceId(options)
        : getOrCreateUnixDeviceId({ ...options, platform });
}
