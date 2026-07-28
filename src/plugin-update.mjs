// Marketplace update check for the Microsoft Foundry plugin.
//
// The canvas ships as the `microsoft-foundry` plugin on the `awesome-copilot`
// marketplace. When a newer version is published the canvas points users to
// the host-managed plugin settings. It never mutates its own installation.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { compareVersions } from "./version-compare.mjs";

export const PLUGIN_NAME = "microsoft-foundry";
export const PLUGIN_MARKETPLACE = "awesome-copilot";
export const MARKETPLACE_MANIFEST_URL =
    "https://raw.githubusercontent.com/github/awesome-copilot/main/.github/plugin/marketplace.json";

const MANIFEST_FETCH_TIMEOUT_MS = 10_000;
const CHECK_TTL_MS = 5 * 60_000;
// extensions/<extension>/ sits two levels below the plugin root that carries
// .github/plugin/plugin.json; allow a little slack for future layouts.
const PLUGIN_MANIFEST_SEARCH_DEPTH = 4;

let cachedCheck = null;
let cachedCheckAt = 0;

export function resetPluginUpdateCache() {
    cachedCheck = null;
    cachedCheckAt = 0;
}

// Reads the plugin manifest that owns the running extension directory, e.g.
// <cache>/awesome-copilot/microsoft-foundry/.github/plugin/plugin.json. Returns
// null when the extension runs from a checkout instead of a plugin install.
export function readPluginManifest(extensionDir) {
    let dir = extensionDir ? String(extensionDir) : "";
    for (let depth = 0; dir && depth <= PLUGIN_MANIFEST_SEARCH_DEPTH; depth++) {
        const manifestPath = join(dir, ".github", "plugin", "plugin.json");
        if (existsSync(manifestPath)) {
            try {
                const data = JSON.parse(readFileSync(manifestPath, "utf-8"));
                if (data && typeof data === "object" && typeof data.name === "string") {
                    return {
                        name: data.name,
                        version: typeof data.version === "string" ? data.version : "",
                        manifestPath,
                    };
                }
            } catch {
                /* a corrupt manifest is treated as "not a plugin install" */
            }
            return null;
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

export function readInstalledPlugin({ extensionDir } = {}) {
    const manifest = readPluginManifest(extensionDir);
    if (manifest?.name === PLUGIN_NAME) {
        return {
            installed: true,
            source: "manifest",
            version: manifest.version,
            marketplace: PLUGIN_MARKETPLACE,
        };
    }
    return {
        installed: false,
        source: "unavailable",
        version: "",
        marketplace: "",
    };
}

export async function fetchLatestPluginVersion({ fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== "function") {
        return { ok: false, reason: "fetch_unavailable", version: "" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MANIFEST_FETCH_TIMEOUT_MS);
    try {
        const response = await fetchImpl(MARKETPLACE_MANIFEST_URL, {
            signal: controller.signal,
            headers: { Accept: "application/json" },
        });
        if (!response.ok) return { ok: false, reason: `http_${response.status}`, version: "" };
        const manifest = await response.json();
        const plugins = Array.isArray(manifest?.plugins) ? manifest.plugins : [];
        const entry = plugins.find((item) => item?.name === PLUGIN_NAME);
        if (!entry) return { ok: false, reason: "plugin_not_listed", version: "" };
        const version = typeof entry.version === "string" ? entry.version.trim() : "";
        if (!version) return { ok: false, reason: "version_missing", version: "" };
        return { ok: true, version };
    } catch (error) {
        return {
            ok: false,
            reason: error?.name === "AbortError" ? "timeout" : "fetch_failed",
            version: "",
        };
    } finally {
        clearTimeout(timer);
    }
}

export async function checkPluginUpdate({
    extensionDir,
    force = false,
    fetchImpl,
    now = () => Date.now(),
} = {}) {
    const age = now() - cachedCheckAt;
    if (!force && cachedCheck && age >= 0 && age < CHECK_TTL_MS) return cachedCheck;

    const installed = readInstalledPlugin({ extensionDir });
    const base = {
        ok: true,
        name: PLUGIN_NAME,
        marketplace: installed.marketplace || PLUGIN_MARKETPLACE,
        installedVersion: installed.version,
        latestVersion: "",
        updateAvailable: false,
    };

    if (!installed.installed) {
        // Running from a checkout or a non-marketplace install: nothing to offer.
        return cache({ ...base, status: "not_installed" }, now);
    }

    const latest = await fetchLatestPluginVersion({ fetchImpl });
    if (!latest.ok) {
        // Never cache a failed lookup — the next canvas open should retry.
        return { ...base, ok: false, status: "unknown", reason: latest.reason };
    }

    const outdated = !!installed.version
        && compareVersions(installed.version, latest.version) < 0;
    return cache({
        ...base,
        latestVersion: latest.version,
        status: outdated ? "outdated" : "latest",
        updateAvailable: outdated,
    }, now);
}

function cache(result, now) {
    cachedCheck = result;
    cachedCheckAt = now();
    return result;
}
