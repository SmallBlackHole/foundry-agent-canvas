// foundry.mjs — read-only live backend for the Foundry Agent Canvas canvas.
//
// Pulls the *selected project's* real model deployments and tool connections
// from the Microsoft Foundry data-plane REST API. Auth is in-process via
// @azure/identity (no Azure CLI required): sign-in uses DeviceCodeCredential and
// the resulting credential mints tokens. If az/azd happen to be present and
// already signed in, they're used as a best-effort fallback only.
//
// Everything here is READ-only. Mutations (deploy / add model / connect tool)
// stay in the prompt-to-chat flow so the chat agent + microsoft-foundry skill
// handle them properly.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const API_VERSION = "2025-05-01";
const TOKEN_SCOPE = "https://ai.azure.com/.default";
const MGMT_SCOPE = "https://management.azure.com/.default";
const MGMT_BASE = "https://management.azure.com";
const TTL_MS = 30_000;
const IS_WINDOWS = process.platform === "win32";

// ─── PATH-robust CLI locator ──────────────────────────────────────────────────
// GUI-launched hosts can have a reduced PATH that omits az/azd, so probe the
// well-known install locations before giving up.
function probeKnownPaths(bin) {
    if (!IS_WINDOWS) return undefined;
    const PF = process.env["ProgramFiles"] || "C:\\Program Files";
    const LAD = process.env["LOCALAPPDATA"];
    const candidates = [];
    if (bin === "az") {
        candidates.push(join(PF, "Microsoft SDKs", "Azure", "CLI2", "wbin", "az.cmd"));
    } else if (bin === "azd") {
        candidates.push(join(PF, "Azure Dev CLI", "azd.exe"));
        if (LAD) candidates.push(join(LAD, "Programs", "Azure Dev CLI", "azd.exe"));
    }
    return candidates.find((c) => existsSync(c));
}

const _binCache = new Map();
function which(bin) {
    if (_binCache.has(bin)) return _binCache.get(bin);
    let resolved;
    try {
        const r = spawnSync(IS_WINDOWS ? "where" : "which", [bin], { encoding: "utf-8", shell: IS_WINDOWS });
        if (r.status === 0 && r.stdout) {
            const lines = r.stdout.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
            // On Windows, `where az` lists the extensionless shim first (which
            // fails when spawned) followed by az.cmd — prefer an executable.
            if (IS_WINDOWS) {
                resolved = lines.find((l) => /\.(cmd|bat|exe)$/i.test(l)) || lines[0];
            } else {
                resolved = lines[0];
            }
        }
    } catch {
        /* fall through to known-path probe */
    }
    resolved = resolved || probeKnownPaths(bin) || (IS_WINDOWS ? `${bin}.cmd` : bin);
    _binCache.set(bin, resolved);
    return resolved;
}

// On Windows with shell:true, a path containing spaces must be quoted or cmd.exe
// splits it at the first space ("'C:\Program' is not recognized").
function quoteExe(exe) {
    return IS_WINDOWS && /\s/.test(exe) && !exe.startsWith('"') ? `"${exe}"` : exe;
}

function runCli(bin, args) {
    try {
        const r = spawnSync(quoteExe(which(bin)), args, { encoding: "utf-8", shell: IS_WINDOWS, windowsHide: true });
        return { status: r.status ?? -1, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
    } catch (err) {
        return { status: -1, stdout: "", stderr: String(err?.message || err) };
    }
}

// ─── Token acquisition (cached per scope until ~expiry) ───────────────────────
let _cred;
const _tokenCache = new Map(); // scope -> { token, expEpochMs }

async function tokenFromIdentity(scope) {
    try {
        const idm = await import("@azure/identity");
        _cred = _cred || new idm.DefaultAzureCredential();
        const t = await _cred.getToken(scope);
        if (t?.token) return { token: t.token, expEpochMs: t.expiresOnTimestamp || Date.now() + 5 * 60_000 };
    } catch {
        /* package missing or no credential available — fall through to CLI */
    }
    return null;
}

function tokenFromAz(scope) {
    const r = runCli("az", ["account", "get-access-token", "--scope", scope, "-o", "json"]);
    if (r.status === 0 && r.stdout) {
        try {
            const j = JSON.parse(r.stdout);
            if (j.accessToken) {
                const exp = j.expires_on ? Number(j.expires_on) * 1000 : Date.now() + 5 * 60_000;
                return { token: j.accessToken, expEpochMs: exp };
            }
        } catch {
            /* ignore parse error */
        }
    }
    return null;
}

function tokenFromAzd(scope) {
    const r = runCli("azd", ["auth", "token", "--scope", scope, "--output", "json"]);
    if (r.status === 0 && r.stdout) {
        try {
            const j = JSON.parse(r.stdout);
            if (j.token) {
                const exp = j.expiresOn ? Date.parse(j.expiresOn) : Date.now() + 5 * 60_000;
                return { token: j.token, expEpochMs: Number.isFinite(exp) ? exp : Date.now() + 5 * 60_000 };
            }
        } catch {
            /* ignore parse error */
        }
    }
    return null;
}

export async function getToken(scope = TOKEN_SCOPE) {
    const hit = _tokenCache.get(scope);
    if (hit && Date.now() < hit.expEpochMs - 60_000) return hit.token;
    const result = (await tokenFromIdentity(scope)) || tokenFromAz(scope) || tokenFromAzd(scope);
    if (!result) throw new Error("not_signed_in");
    _tokenCache.set(scope, result);
    return result.token;
}

// Drop cached credentials/tokens (e.g. after sign-in/out so identity refreshes).
function resetAuthCaches() {
    _cred = undefined;
    _tokenCache.clear();
    _cache.clear();
}

// ─── REST helper ──────────────────────────────────────────────────────────────
function normalizeEndpoint(endpoint) {
    return String(endpoint || "").replace(/\/+$/, "");
}

async function apiGet(endpoint, resource) {
    const token = await getToken();
    const url = `${normalizeEndpoint(endpoint)}/${resource}?api-version=${API_VERSION}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        err.body = body;
        throw err;
    }
    return res.json();
}

// ─── Management-plane (ARM) REST helpers ──────────────────────────────────────
async function armFetch(path, { method = "GET", body } = {}) {
    const token = await getToken(MGMT_SCOPE);
    const url = path.startsWith("http") ? path : `${MGMT_BASE}${path}`;
    const res = await fetch(url, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        err.body = text;
        throw err;
    }
    return res.json();
}
const _cache = new Map(); // key -> { exp, value }
async function cached(key, producer) {
    const hit = _cache.get(key);
    if (hit && Date.now() < hit.exp) return hit.value;
    const value = await producer();
    _cache.set(key, { exp: Date.now() + TTL_MS, value });
    return value;
}

function reasonFor(err) {
    if (err?.message === "not_signed_in") return "not_signed_in";
    if (err?.status === 401 || err?.status === 403) return "unauthorized";
    if (err?.status === 404) return "not_found";
    return "fetch_failed";
}

// ─── Connection → tool classification ─────────────────────────────────────────
// Show real *tool* connections; hide infrastructure connections (App Insights,
// storage, the project's own AOAI, etc.).
const INFRA_TYPES = new Set([
    "appinsights",
    "applicationinsights",
    "azureopenai",
    "azureblob",
    "azureblobstorage",
    "azurestorageaccount",
    "cosmosdb",
    "azurecosmosdb",
]);

function isToolConnection(c) {
    const type = String(c.type || "").toLowerCase();
    const metaType = String(c?.metadata?.type || "").toLowerCase();
    if (type === "remotetool") return true;
    if (/mcp|tool|catalog_/.test(metaType)) return true;
    if (/cognitivesearch|aisearch/.test(type)) return true; // Azure AI Search grounding
    if (INFRA_TYPES.has(type)) return false;
    return false;
}

// ─── Public read API ──────────────────────────────────────────────────────────

// Returns { ok:true, data:[{ name, modelName, version, provider, sku }] }
// or { ok:false, reason }.
export async function listDeployments(endpoint) {
    try {
        const json = await cached(`dep:${endpoint}`, () => apiGet(endpoint, "deployments"));
        const data = (json?.value || [])
            .filter((d) => (d.type ? d.type === "ModelDeployment" : true))
            .map((d) => ({
                name: d.name,
                modelName: d.modelName || d.name,
                version: d.modelVersion || "",
                provider: d.modelPublisher || "",
                sku: d.sku?.name || "",
            }));
        return { ok: true, data };
    } catch (err) {
        return { ok: false, reason: reasonFor(err) };
    }
}

// Returns { ok:true, data:[{ name, type, toolEntityId, target }] } (tool conns
// only) or { ok:false, reason }.
export async function listConnections(endpoint) {
    try {
        const json = await cached(`conn:${endpoint}`, () => apiGet(endpoint, "connections"));
        const data = (json?.value || [])
            .filter(isToolConnection)
            .map((c) => ({
                name: c.name,
                type: c.type || "",
                toolEntityId: c?.metadata?.toolEntityId || "",
                metaType: c?.metadata?.type || "",
                target: c.target || "",
            }));
        return { ok: true, data };
    } catch (err) {
        return { ok: false, reason: reasonFor(err) };
    }
}

// Returns { ok:true, data:[{ name, defaultVersion }] } or { ok:false, reason }.
// Foundry Toolboxes are a distinct data-plane resource from tool connections:
// each toolbox bundles one or more tools behind a single MCP endpoint. The
// toolboxes API uses its own api-version (v1) and preview feature header.
export async function listToolboxes(endpoint) {
    try {
        const json = await cached(`tbx:${endpoint}`, async () => {
            const token = await getToken();
            const url = `${normalizeEndpoint(endpoint)}/toolboxes?api-version=v1`;
            const res = await fetch(url, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/json",
                    "Foundry-Features": "Toolboxes=V1Preview",
                },
            });
            if (!res.ok) {
                const err = new Error(`HTTP ${res.status}`);
                err.status = res.status;
                throw err;
            }
            return res.json();
        });
        const data = (json?.data || []).map((t) => ({
            name: t.name,
            defaultVersion: t.default_version || "",
        }));
        return { ok: true, data };
    } catch (err) {
        return { ok: false, reason: reasonFor(err) };
    }
}

// Tools configured in a single toolbox's default (or given) version. Read from
// the toolbox version detail (no MCP/consent needed). Cached. Returns
// { ok:true, data:[{ name, type }] } or { ok:false, reason }. Lazy — called when
// a toolbox row is expanded, so opening the menu only does the cheap list call.
export async function listToolboxTools(endpoint, name, version = "") {
    if (!name) return { ok: false, reason: "no_toolbox" };
    try {
        const ver = version || "default";
        const data = await cached(`tbxtools:${endpoint}:${name}:${ver}`, async () => {
            const token = await getToken();
            const base = `${normalizeEndpoint(endpoint)}/toolboxes/${encodeURIComponent(name)}`;
            const url = version
                ? `${base}/versions/${encodeURIComponent(version)}?api-version=v1`
                : `${base}?api-version=v1`;
            const res = await fetch(url, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/json",
                    "Foundry-Features": "Toolboxes=V1Preview",
                },
            });
            if (!res.ok) {
                const err = new Error(`HTTP ${res.status}`);
                err.status = res.status;
                throw err;
            }
            const j = await res.json();
            const tools = j?.tools || j?.version?.tools || [];
            return tools.map((t) => ({ name: t.name || t.server_label || t.type, type: t.type || "" }));
        });
        return { ok: true, data };
    } catch (err) {
        return { ok: false, reason: reasonFor(err) };
    }
}

// Derive project identity from the endpoint URL (cheap, no network).
// e.g. https://<resource>.services.ai.azure.com/api/projects/<project>
export function getProject(endpoint) {
    const ep = normalizeEndpoint(endpoint);
    let projectName = "";
    let resourceName = "";
    try {
        const u = new URL(ep);
        const m = u.pathname.match(/\/projects\/([^/?#]+)/i);
        if (m) projectName = decodeURIComponent(m[1]);
        resourceName = u.hostname.split(".")[0] || "";
    } catch {
        /* leave blanks */
    }
    return { endpoint: ep, projectName, resourceName };
}

// ─── Management-plane: identity / subscriptions / projects ────────────────────

// Decode a JWT payload without verification (best-effort identity fallback).
function decodeJwt(token) {
    try {
        const part = String(token).split(".")[1];
        const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
        return JSON.parse(json);
    } catch {
        return null;
    }
}

// Signed-in identity. Derived from the cached credential's token (works without
// the Azure CLI). Returns { signedIn, account, tenantId, subscriptionId,
// subscriptionName }. Falls back to az/azd only if those happen to be present.
export async function getIdentity() {
    // Primary path: decode a token from the cached/default credential.
    const tok = (await tokenFromIdentity(MGMT_SCOPE))?.token;
    if (tok) {
        const p = decodeJwt(tok);
        if (p) {
            return {
                signedIn: true,
                account: p.upn || p.preferred_username || p.unique_name || p.email || "",
                tenantId: p.tid || "",
                subscriptionId: "",
                subscriptionName: "",
            };
        }
    }
    // Best-effort fallback: an existing az session (no requirement on az).
    const r = runCli("az", ["account", "show", "-o", "json"]);
    if (r.status === 0 && r.stdout) {
        try {
            const a = JSON.parse(r.stdout);
            return {
                signedIn: true,
                account: a?.user?.name || "",
                tenantId: a?.tenantId || "",
                subscriptionId: a?.id || "",
                subscriptionName: a?.name || "",
            };
        } catch {
            /* fall through */
        }
    }
    return { signedIn: false, account: "", tenantId: "", subscriptionId: "", subscriptionName: "" };
}

// Default subscription id: first enabled subscription from ARM (no az needed).
export function getDefaultSubscriptionId() {
    const r = runCli("az", ["account", "show", "--query", "id", "-o", "tsv"]);
    if (r.status === 0 && r.stdout) return r.stdout.trim();
    return "";
}

// All enabled subscriptions (ARM). Marks the az default. { ok, data | reason }.
export async function listSubscriptions() {
    try {
        const defaultId = getDefaultSubscriptionId();
        const data = await cached("subs", async () => {
            const out = [];
            let url = "/subscriptions?api-version=2022-12-01";
            for (let i = 0; i < 20 && url; i++) {
                const json = await armFetch(url);
                for (const s of json?.value || []) {
                    if (s.state && s.state !== "Enabled") continue;
                    out.push({ id: s.subscriptionId, name: s.displayName || s.subscriptionId });
                }
                url = json?.nextLink || "";
            }
            return out;
        });
        return {
            ok: true,
            data: data.map((s) => ({ ...s, isDefault: s.id === defaultId })),
        };
    } catch (err) {
        return { ok: false, reason: reasonFor(err) };
    }
}

const PROJECTS_QUERY =
    "resources " +
    "| where type =~ 'microsoft.cognitiveservices/accounts/projects' " +
    "| project name, id, endpoint=tostring(properties.endpoints['AI Foundry API']), " +
    "rg=resourceGroup, location, subscriptionId " +
    "| order by name asc";

// Foundry projects in a subscription via Azure Resource Graph (one paged call).
// Returns { ok, data:[{ account, project, name, endpoint, rg, location, id }] }.
export async function listProjects(subscriptionId) {
    if (!subscriptionId) return { ok: false, reason: "no_subscription" };
    try {
        const data = await cached(`proj:${subscriptionId}`, async () => {
            const out = [];
            let skipToken;
            for (let i = 0; i < 50; i++) {
                const body = {
                    subscriptions: [subscriptionId],
                    query: PROJECTS_QUERY,
                    options: { $top: 1000, resultFormat: "objectArray", ...(skipToken ? { $skipToken: skipToken } : {}) },
                };
                const json = await armFetch(
                    "/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01",
                    { method: "POST", body },
                );
                for (const row of json?.data || []) {
                    // ARG `name` is "account/project"; split for display.
                    const full = String(row.name || "");
                    const parts = full.split("/");
                    const project = parts.length > 1 ? parts[parts.length - 1] : full;
                    const account = parts.length > 1 ? parts[0] : "";
                    if (!row.endpoint) continue; // only projects with a usable Foundry endpoint
                    out.push({
                        account,
                        project,
                        name: project,
                        endpoint: row.endpoint,
                        rg: row.rg || "",
                        location: row.location || "",
                        id: row.id || "",
                    });
                }
                skipToken = json?.$skipToken;
                if (!skipToken) break;
            }
            return out;
        });
        return { ok: true, data };
    } catch (err) {
        return { ok: false, reason: reasonFor(err) };
    }
}

// ─── Sign in / out (in-process interactive browser; no Azure CLI required) ────
// Uses @azure/identity InteractiveBrowserCredential: opens the system browser
// with a localhost redirect so the extension never shells out to `az login` and
// never uses device code (blocked by many Conditional Access policies). Once the
// user finishes in the browser, the credential is cached and mints tokens for
// all data reads.
const _signins = new Map(); // sessionId -> { cred, status, error, mode }

// Start interactive-browser sign-in. Returns { ok, sessionId, mode:"interactive" };
// the OS browser opens and sign-in completes in the background (poll status).
export async function signInStart() {
    const sessionId = randomUUID();
    let InteractiveBrowserCredential;
    try {
        ({ InteractiveBrowserCredential } = await import("@azure/identity"));
    } catch (err) {
        return { ok: false, reason: "identity_missing", error: String(err?.message || err) };
    }

    const rec = { cred: null, status: "pending", error: "", mode: "interactive" };
    _signins.set(sessionId, rec);

    const cred = new InteractiveBrowserCredential({
        // Localhost redirect on an ephemeral port; opens the org-approved browser
        // login (supports SSO / Conditional Access), no device code.
        redirectUri: "http://localhost",
    });
    rec.cred = cred;

    cred.getToken(MGMT_SCOPE)
        .then(() => {
            rec.status = "done";
            _cred = cred; // promote to the primary credential for all reads
            _tokenCache.clear();
            _cache.clear();
        })
        .catch((err) => {
            if (rec.status !== "done") {
                rec.status = rec.cancelled ? "cancelled" : "error";
                rec.error = String(err?.message || err).slice(0, 400);
            }
        });

    // Brief wait to catch an immediate launch failure.
    const deadline = Date.now() + 2_500;
    while (Date.now() < deadline && rec.status === "pending") {
        await new Promise((r) => setTimeout(r, 150));
    }
    if (rec.status === "error") {
        return { ok: false, sessionId, reason: "login_failed", error: rec.error };
    }
    return { ok: true, sessionId, mode: "interactive" };
}

// Poll the status of an in-flight login.
export async function signInStatus(sessionId) {
    const rec = _signins.get(sessionId);
    if (!rec) return { ok: false, status: "unknown" };
    if (rec.status === "done") {
        const identity = await getIdentity();
        _signins.delete(sessionId);
        return { ok: true, status: "done", identity };
    }
    if (rec.status === "error" || rec.status === "cancelled") {
        const status = rec.status;
        const error = rec.error;
        _signins.delete(sessionId);
        return { ok: status !== "error", status, error };
    }
    return { ok: true, status: "pending", mode: rec.mode, code: rec.code, url: rec.url };
}

// Cancel an in-flight device-code login.
export function signInCancel(sessionId) {
    const rec = _signins.get(sessionId);
    if (rec) rec.cancelled = true;
    _signins.delete(sessionId);
    return { ok: true };
}

// Sign out: drop the cached credential/tokens so identity is forgotten.
export async function signOut() {
    resetAuthCaches();
    return { ok: true };
}
