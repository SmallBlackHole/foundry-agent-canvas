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
            const authHeaders = {
                Authorization: `Bearer ${token}`,
                Accept: "application/json",
                "Foundry-Features": "Toolboxes=V1Preview",
            };
            const base = `${normalizeEndpoint(endpoint)}/toolboxes/${encodeURIComponent(name)}`;
            // The toolbox metadata resource does NOT carry the tools array — tools
            // live on the version resource. Resolve the default version first when
            // no explicit version was requested.
            let resolved = version;
            if (!resolved) {
                const metaRes = await fetch(`${base}?api-version=v1`, { headers: authHeaders });
                if (!metaRes.ok) {
                    const err = new Error(`HTTP ${metaRes.status}`);
                    err.status = metaRes.status;
                    throw err;
                }
                const meta = await metaRes.json();
                resolved = String(meta?.default_version ?? "");
            }
            if (!resolved) return [];
            const res = await fetch(`${base}/versions/${encodeURIComponent(resolved)}?api-version=v1`, {
                headers: authHeaders,
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

// ─── Toolbox write API (create version + promote) ─────────────────────────────
// Foundry toolbox versions are IMMUTABLE: to "add a tool" we read the current
// default version's full tool list, append the new entry, POST a NEW version with
// the merged list, then PATCH default_version to promote it. Toolboxes are created
// implicitly by POST /versions, so the same path also makes a brand-new toolbox.
// The `Foundry-Features: Toolboxes=V1Preview` header + `?api-version=v1` are required.
const tbxHeaders = (token) => ({
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "Foundry-Features": "Toolboxes=V1Preview",
});

function invalidateToolboxCache(endpoint, name = "") {
    for (const key of _cache.keys()) {
        if (key === `tbx:${endpoint}`) _cache.delete(key);
        else if (name && key.startsWith(`tbxtools:${endpoint}:${name}:`)) _cache.delete(key);
    }
}

// Raw default-version tools for a toolbox (full entries, not the simplified
// {name,type} projection that listToolboxTools returns). Returns
// { version, tools, missing? }.
async function getToolboxVersionRaw(endpoint, name) {
    const token = await getToken();
    const base = `${normalizeEndpoint(endpoint)}/toolboxes/${encodeURIComponent(name)}`;
    const res = await fetch(`${base}?api-version=v1`, { headers: tbxHeaders(token) });
    if (res.status === 404) return { version: "", tools: [], missing: true };
    if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
    const detail = await res.json();
    const ver = detail.default_version || "";
    if (!ver) return { version: "", tools: [] };
    const vres = await fetch(`${base}/versions/${encodeURIComponent(ver)}?api-version=v1`, {
        headers: tbxHeaders(token),
    });
    if (!vres.ok) { const e = new Error(`HTTP ${vres.status}`); e.status = vres.status; throw e; }
    const vjson = await vres.json();
    return { version: ver, tools: Array.isArray(vjson.tools) ? vjson.tools : [] };
}

// POST a new version with the given tool list. Returns the new version string.
async function createToolboxVersion(endpoint, name, tools) {
    const token = await getToken();
    const url = `${normalizeEndpoint(endpoint)}/toolboxes/${encodeURIComponent(name)}/versions?api-version=v1`;
    const res = await fetch(url, { method: "POST", headers: tbxHeaders(token), body: JSON.stringify({ tools }) });
    if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; e.body = await res.text().catch(() => ""); throw e; }
    const json = await res.json();
    return String(json.version ?? "");
}

// Promote a version to default. default_version MUST be a JSON string, not a number.
async function setDefaultVersion(endpoint, name, version) {
    const token = await getToken();
    const url = `${normalizeEndpoint(endpoint)}/toolboxes/${encodeURIComponent(name)}?api-version=v1`;
    const res = await fetch(url, {
        method: "PATCH",
        headers: tbxHeaders(token),
        body: JSON.stringify({ default_version: String(version) }),
    });
    if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; e.body = await res.text().catch(() => ""); throw e; }
    return true;
}

// All connections (unfiltered) for matching — listConnections() hides non-tool
// types we still want to reuse here (e.g. RemoteA2A for Work IQ).
async function listConnectionsRaw(endpoint) {
    try {
        const json = await cached(`connraw:${endpoint}`, () => apiGet(endpoint, "connections"));
        return (json?.value || []).map((c) => ({
            name: c.name,
            type: c.type || "",
            toolEntityId: c?.metadata?.toolEntityId || "",
            metaType: c?.metadata?.type || "",
            target: c.target || "",
        }));
    } catch {
        return [];
    }
}

// Catalog tool id → how it maps into a toolbox version entry.
//   kind:"free"     → no connection needed (just { type })
//   kind:"mcp"      → reuse an existing project connection (server_label + id)
//   kind:"work_iq"  → reuse an existing Work IQ connection
// Tools needing config we can't infer (azure-ai-search index, file-search vector
// store, fabric-iq / browser OAuth) are omitted → caller falls back to the prompt.
const TOOLBOX_TOOL_MAP = {
    "web-search": { kind: "free", type: "web_search" },
    "code-interpreter": { kind: "free", type: "code_interpreter" },
    workiq: { kind: "work_iq", match: ["workiq", "work_iq", "work-iq", "m365", "a2a"] },
    "databricks-genie": { kind: "mcp", match: ["databricks", "genie"] },
    elasticsearch: { kind: "mcp", match: ["elasticsearch", "elastic"] },
    github: { kind: "mcp", match: ["github"] },
    "infobip-whatsapp": { kind: "mcp", match: ["infobip", "whatsapp"] },
    intercom: { kind: "mcp", match: ["intercom"] },
    lovable: { kind: "mcp", match: ["lovable"] },
    lseg: { kind: "mcp", match: ["lseg"] },
    marketnode: { kind: "mcp", match: ["marketnode"] },
    "merge-agent-handler": { kind: "mcp", match: ["merge"] },
};

function sanitizeLabel(s) {
    return String(s || "tool").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 40) || "tool";
}

function findConnection(connections, keywords) {
    const ks = (keywords || []).map((k) => k.toLowerCase());
    for (const c of connections || []) {
        const hay = `${c.name} ${c.toolEntityId} ${c.metaType} ${c.target}`.toLowerCase();
        if (ks.some((k) => hay.includes(k))) return c;
    }
    return null;
}

// Build the toolbox tool entry for a catalog tool id. Returns
// { ok:true, entry } | { ok:false, reason:'needs_connection'|'unknown_tool' }.
function buildToolboxEntry(toolId, toolName, connections, existingTools) {
    const def = TOOLBOX_TOOL_MAP[toolId];
    if (!def) return { ok: false, reason: "needs_connection" };
    if (def.kind === "free") return { ok: true, entry: { type: def.type } };
    if (def.kind === "work_iq") {
        const conn = findConnection(connections, def.match);
        if (!conn) return { ok: false, reason: "needs_connection" };
        return { ok: true, entry: { type: "work_iq_preview", project_connection_id: conn.name } };
    }
    if (def.kind === "mcp") {
        const conn = findConnection(connections, def.match);
        if (!conn) return { ok: false, reason: "needs_connection" };
        const used = new Set((existingTools || []).map((t) => String(t.server_label || "").toLowerCase()));
        const baseLabel = sanitizeLabel(toolName);
        let label = baseLabel;
        let n = 1;
        while (used.has(label.toLowerCase())) label = `${baseLabel}${++n}`;
        return { ok: true, entry: { type: "mcp", server_label: label, project_connection_id: conn.name } };
    }
    return { ok: false, reason: "needs_connection" };
}

// Is `entry` already present in `tools`? Dedupe by type for unnamed types, by
// server_label / connection for mcp & work_iq.
function toolboxHasEntry(tools, entry) {
    return (tools || []).some((t) => {
        if (t.type !== entry.type) return false;
        if (entry.type === "mcp") {
            return (
                (entry.server_label && t.server_label === entry.server_label) ||
                (entry.project_connection_id && t.project_connection_id === entry.project_connection_id)
            );
        }
        if (entry.project_connection_id) return t.project_connection_id === entry.project_connection_id;
        return true; // unnamed type already present
    });
}

// The toolbox API allows AT MOST ONE tool without an identifier (`name` for
// non-mcp types, `server_label` for mcp) across the whole version — not one per
// type. Assign a `name` (defaulting to the tool type, which is also its default
// runtime name, so behavior is unchanged) to every identifier-less tool beyond
// the first so the merged list validates.
function ensureIdentifiers(tools) {
    const used = new Set();
    for (const t of tools) {
        const id = t.type === "mcp" ? t.server_label : t.name;
        if (id) used.add(String(id).toLowerCase());
    }
    let allowNaked = true;
    return tools.map((t) => {
        const id = t.type === "mcp" ? t.server_label : t.name;
        if (id || t.type === "mcp") return t; // mcp must carry its own server_label
        if (allowNaked) { allowNaked = false; return t; }
        const base = t.type || "tool";
        let nm = base;
        let i = 1;
        while (used.has(nm.toLowerCase())) nm = `${base}_${++i}`;
        used.add(nm.toLowerCase());
        return { ...t, name: nm };
    });
}

// Add a catalog tool into an EXISTING toolbox. Reads current default version,
// dedupes, merges, creates a new version, promotes it. Returns one of:
//   { ok:true, version, toolbox }            — added
//   { ok:true, already:true, toolbox }       — already present, no change
//   { ok:false, reason:'needs_connection' }  — caller should fall back to prompt
//   { ok:false, reason, detail }             — hard failure
export async function addToolToToolbox(endpoint, toolboxName, toolId, toolName = "") {
    if (!toolboxName || !toolId) return { ok: false, reason: "bad_request" };
    try {
        const connections = await listConnectionsRaw(endpoint);
        const current = await getToolboxVersionRaw(endpoint, toolboxName);
        const built = buildToolboxEntry(toolId, toolName, connections, current.tools);
        if (!built.ok) return built;
        if (toolboxHasEntry(current.tools, built.entry)) return { ok: true, already: true, toolbox: toolboxName };
        const merged = ensureIdentifiers([...current.tools, built.entry]);
        const version = await createToolboxVersion(endpoint, toolboxName, merged);
        await setDefaultVersion(endpoint, toolboxName, version);
        invalidateToolboxCache(endpoint, toolboxName);
        return { ok: true, version, toolbox: toolboxName };
    } catch (err) {
        return { ok: false, reason: reasonFor(err), detail: err?.body || err?.message || "" };
    }
}

// Create a NEW toolbox containing just the catalog tool (name chosen by caller).
export async function createToolboxWithTool(endpoint, toolboxName, toolId, toolName = "") {
    if (!toolboxName || !toolId) return { ok: false, reason: "bad_request" };
    try {
        const connections = await listConnectionsRaw(endpoint);
        const built = buildToolboxEntry(toolId, toolName, connections, []);
        if (!built.ok) return built;
        const version = await createToolboxVersion(endpoint, toolboxName, ensureIdentifiers([built.entry]));
        await setDefaultVersion(endpoint, toolboxName, version);
        invalidateToolboxCache(endpoint, toolboxName);
        return { ok: true, version, toolbox: toolboxName, created: true };
    } catch (err) {
        return { ok: false, reason: reasonFor(err), detail: err?.body || err?.message || "" };
    }
}

// ─── Work IQ sub-tools (catalog-driven MCP variants) ──────────────────────────
// Clicking Work IQ in the catalog lets the developer pick from the Microsoft 365
// "Work IQ" MCP servers (Teams, Mail, Word, ...). Each selected variant needs a
// project connection; unlike other connection-backed tools these use an OBO
// (UserEntraToken) auth with NO secret, so the extension can CREATE the
// connection itself via an ARM control-plane PUT and then add an `mcp` entry to
// the chosen toolbox. "Work IQ Chat" (A2A) and "Work IQ MCP" are intentionally
// excluded.
const WORKIQ_TAG = "workiq";
const WORKIQ_CATALOG_REGION = "eastus";
const WORKIQ_REGISTRY = "registry-prod-bl";
const WORKIQ_AUDIENCE = "ea9ffc3e-8a23-4a7d-836d-234d7c7565c1";
const CONN_API_VERSION = "2025-04-01-preview";
// Catalog objectIds to hide from the picker (A2A chat variant + raw MCP proxy).
const WORKIQ_EXCLUDE = new Set(["microsoft-work-iq-mcp-frontier"]);
// Preferred display order (matches the portal's "Add the Work IQ Tool" dialog).
const WORKIQ_ORDER = [
    "microsoft-copilot-chat-frontier",
    "microsoft-teams-mcp-frontier",
    "microsoft-word-mcp-frontier",
    "microsoft-outlook-calendar-mcp-frontier",
    "microsoft-outlook-mail-mcp-frontier",
    "microsoft-365-user-profile-mcp-frontier",
    "microsoft-sharepoint-mcp-frontier",
    "microsoft-onedrive-mcp-frontier",
];

// Hardcoded fallback used if the live catalog probe fails. Mirrors the 8 MCP
// variants (verified against the Foundry tool catalog).
const WORKIQ_VARIANTS = [
    { entityId: "microsoft-copilot-chat-frontier", title: "Work IQ Copilot", serverUrl: "https://agent365.svc.cloud.microsoft/agents/servers/mcp_M365Copilot", audience: WORKIQ_AUDIENCE, version: "1" },
    { entityId: "microsoft-teams-mcp-frontier", title: "Work IQ Teams", serverUrl: "https://agent365.svc.cloud.microsoft/agents/servers/mcp_TeamsServer", audience: WORKIQ_AUDIENCE, version: "1" },
    { entityId: "microsoft-word-mcp-frontier", title: "Work IQ Word", serverUrl: "https://agent365.svc.cloud.microsoft/agents/servers/mcp_WordServer", audience: WORKIQ_AUDIENCE, version: "1" },
    { entityId: "microsoft-outlook-calendar-mcp-frontier", title: "Work IQ Calendar", serverUrl: "https://agent365.svc.cloud.microsoft/agents/servers/mcp_CalendarTools", audience: WORKIQ_AUDIENCE, version: "1" },
    { entityId: "microsoft-outlook-mail-mcp-frontier", title: "Work IQ Mail", serverUrl: "https://agent365.svc.cloud.microsoft/agents/servers/mcp_MailTools", audience: WORKIQ_AUDIENCE, version: "1" },
    { entityId: "microsoft-365-user-profile-mcp-frontier", title: "Work IQ User", serverUrl: "https://agent365.svc.cloud.microsoft/agents/servers/mcp_MeServer", audience: WORKIQ_AUDIENCE, version: "1" },
    { entityId: "microsoft-sharepoint-mcp-frontier", title: "Work IQ SharePoint", serverUrl: "https://agent365.svc.cloud.microsoft/agents/servers/mcp_SharePointRemoteServer", audience: WORKIQ_AUDIENCE, version: "1" },
    { entityId: "microsoft-onedrive-mcp-frontier", title: "Work IQ OneDrive", serverUrl: "https://agent365.svc.cloud.microsoft/agents/servers/mcp_OneDriveRemoteServer", audience: WORKIQ_AUDIENCE, version: "1" },
];

function sortWorkIQVariants(list) {
    const idx = (id) => {
        const i = WORKIQ_ORDER.indexOf(id);
        return i === -1 ? WORKIQ_ORDER.length : i;
    };
    return [...list].sort((a, b) => idx(a.entityId) - idx(b.entityId) || a.title.localeCompare(b.title));
}

// Live-fetch the Work IQ MCP variants from the Foundry tool catalog. Filters to
// the `workiq` tag, drops the excluded objectIds, keeps only `mcp` entries with a
// server URL. Throws on transport failure so the caller can fall back.
async function fetchWorkIQCatalog() {
    let token = "";
    try { token = await getToken(); } catch { /* best-effort anonymous */ }
    const url = `https://ai.azure.com/api/${WORKIQ_CATALOG_REGION}/ux/v1.0/entities/crossRegion`;
    const body = {
        resourceIds: [{ resourceId: WORKIQ_REGISTRY, entityContainerType: "ApiCenter", region: WORKIQ_CATALOG_REGION }],
        indexEntitiesRequest: {
            filters: [
                { field: "type", operator: "eq", values: ["tools"] },
                { field: "kind", operator: "eq", values: ["Versioned"] },
                { field: "labels", operator: "eq", values: ["latest"] },
            ],
            freeTextSearch: "work iq",
            pageSize: 50,
            includeTotalResultCount: true,
            searchBuilder: "AppendPrefix",
        },
    };
    const headers = { "Content-Type": "application/json", "x-ms-user-agent": "AzureMachineLearningWorkspacePortal/12.0" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const entries = j?.indexEntitiesResponse?.value || [];
    const out = [];
    for (const e of entries) {
        const a = e.annotations || {};
        const p = e.properties || {};
        const tags = a.tags || {};
        if (!Object.prototype.hasOwnProperty.call(tags, WORKIQ_TAG)) continue;
        const entityId = a.name || "";
        if (!entityId || WORKIQ_EXCLUDE.has(entityId)) continue;
        if (String(p.kind || "").toLowerCase() !== "mcp") continue;
        const serverUrl = p.remotes?.[0]?.url || "";
        if (!serverUrl) continue;
        out.push({
            entityId,
            title: p.title || entityId,
            serverUrl,
            audience: p["x-ms-audience"] || WORKIQ_AUDIENCE,
            version: String(e.version || p?.versionDetail?.version || "1"),
        });
    }
    return sortWorkIQVariants(out);
}

// The Work IQ sub-tools to show in the picker. Live catalog with a hardcoded
// fallback so the feature keeps working if the catalog probe fails.
export async function listWorkIQVariants(endpoint) {
    try {
        const data = await cached(`wiqvariants:${WORKIQ_CATALOG_REGION}`, async () => {
            const variants = await fetchWorkIQCatalog();
            return variants.length ? variants : WORKIQ_VARIANTS;
        });
        return { ok: true, data };
    } catch {
        return { ok: true, data: WORKIQ_VARIANTS };
    }
}

// Resolve a project's ARM resource id from its data-plane endpoint (needed to
// PUT connections on the control plane). Matches by endpoint within the selected
// subscription's projects. Cached per endpoint.
const _projArm = new Map(); // endpoint -> armId
async function resolveProjectArmId(endpoint, subscriptionId) {
    const ep = normalizeEndpoint(endpoint);
    if (_projArm.has(ep)) return _projArm.get(ep);
    if (!subscriptionId) return "";
    const r = await listProjects(subscriptionId);
    if (!r.ok) return "";
    const match = (r.data || []).find((p) => normalizeEndpoint(p.endpoint) === ep);
    const armId = match?.id || "";
    if (armId) _projArm.set(ep, armId);
    return armId;
}

// Existing connections on the project's control plane (reliable `target`), used
// to reuse a matching Work IQ connection and to avoid name collisions.
async function getArmConnections(projectArmId) {
    const path = `${projectArmId}/connections?api-version=${CONN_API_VERSION}`;
    const json = await armFetch(path);
    return (json?.value || []).map((c) => ({
        name: c.name,
        target: c?.properties?.target || "",
        category: c?.properties?.category || "",
        authType: c?.properties?.authType || "",
    }));
}

// Base connection name for a variant, e.g. "Work IQ Teams" → "WorkIQTeams".
function workIqConnBaseName(variant) {
    const base = String(variant.title || variant.entityId || "WorkIQ").replace(/[^A-Za-z0-9]/g, "");
    return /^[A-Za-z]/.test(base) ? base : `WorkIQ${base}`;
}

// Pick a name not already used (case-insensitive), appending 1,2,... like the portal.
function uniqueName(base, used) {
    let name = base;
    let n = 0;
    while (used.has(name.toLowerCase())) name = `${base}${++n}`;
    used.add(name.toLowerCase());
    return name;
}

// server_label must match the backend's ^[A-Za-z][A-Za-z0-9_-]*$.
function sanitizeServerLabel(name) {
    let s = String(name || "tool").replace(/[^A-Za-z0-9_-]/g, "_");
    if (!/^[A-Za-z]/.test(s)) s = `m_${s}`;
    return s.slice(0, 60) || "tool";
}

// Create a secret-free Work IQ MCP connection (UserEntraToken / OBO) via ARM PUT.
async function createWorkIQConnection(projectArmId, variant, name) {
    const toolEntityId =
        `azureml://location/${WORKIQ_CATALOG_REGION}/apiCenter/${WORKIQ_REGISTRY}` +
        `/type/tools/objectId/${variant.entityId}/version/${variant.version || "1"}`;
    const body = {
        properties: {
            authType: "UserEntraToken",
            category: "RemoteTool",
            target: variant.serverUrl,
            audience: variant.audience || WORKIQ_AUDIENCE,
            useWorkspaceManagedIdentity: false,
            isSharedToAll: false,
            metadata: { toolEntityId, type: "catalog_MCP" },
        },
    };
    const path = `${projectArmId}/connections/${encodeURIComponent(name)}?api-version=${CONN_API_VERSION}`;
    const result = await armFetch(path, { method: "PUT", body });
    return result?.name || name;
}

// For each requested variant: skip if already in the toolbox; else reuse a
// connection whose target matches (RemoteTool), or CREATE one; build the `mcp`
// toolbox entry. Returns { ok, entries, results } or { ok:false, reason }.
async function ensureWorkIQEntries(endpoint, subscriptionId, existingTools, variantIds) {
    const armId = await resolveProjectArmId(endpoint, subscriptionId);
    if (!armId) return { ok: false, reason: "needs_connection" };
    const variantsRes = await listWorkIQVariants(endpoint);
    const byId = new Map((variantsRes.data || []).map((v) => [v.entityId, v]));
    const armConns = await getArmConnections(armId).catch(() => []);
    const usedNames = new Set(armConns.map((c) => String(c.name).toLowerCase()));
    const byTarget = new Map();
    for (const c of armConns) {
        if (c.category === "RemoteTool" && c.target) byTarget.set(c.target, c.name);
    }
    const existingUrls = new Set(
        (existingTools || []).filter((t) => t.type === "mcp" && t.server_url).map((t) => t.server_url),
    );
    const usedLabels = new Set((existingTools || []).map((t) => String(t.server_label || "").toLowerCase()));

    const entries = [];
    const results = [];
    for (const id of variantIds) {
        const v = byId.get(id) || WORKIQ_VARIANTS.find((x) => x.entityId === id);
        if (!v) { results.push({ id, ok: false, reason: "unknown_variant" }); continue; }
        if (existingUrls.has(v.serverUrl)) {
            results.push({ id, title: v.title, ok: true, already: true });
            continue;
        }
        let connName = byTarget.get(v.serverUrl);
        let created = false;
        if (!connName) {
            connName = uniqueName(workIqConnBaseName(v), usedNames);
            connName = await createWorkIQConnection(armId, v, connName);
            byTarget.set(v.serverUrl, connName);
            created = true;
        }
        let label = sanitizeServerLabel(connName);
        let unique = label;
        let k = 1;
        while (usedLabels.has(unique.toLowerCase())) unique = `${label}${++k}`;
        usedLabels.add(unique.toLowerCase());
        entries.push({
            type: "mcp",
            name: connName,
            server_label: unique,
            server_url: v.serverUrl,
            project_connection_id: connName,
        });
        existingUrls.add(v.serverUrl);
        results.push({ id, title: v.title, ok: true, connection: connName, created });
    }
    return { ok: true, entries, results };
}

// Add selected Work IQ sub-tools into an EXISTING toolbox (creating connections
// as needed). Structured result; { ok:false, reason:'needs_connection' } lets the
// frontend fall back to the chat prompt.
export async function addWorkIQToolsToToolbox(endpoint, subscriptionId, toolboxName, variantIds) {
    if (!toolboxName || !Array.isArray(variantIds) || !variantIds.length) return { ok: false, reason: "bad_request" };
    try {
        const current = await getToolboxVersionRaw(endpoint, toolboxName);
        const built = await ensureWorkIQEntries(endpoint, subscriptionId, current.tools, variantIds);
        if (!built.ok) return built;
        if (!built.entries.length) {
            return { ok: true, already: true, toolbox: toolboxName, results: built.results };
        }
        const merged = ensureIdentifiers([...current.tools, ...built.entries]);
        const version = await createToolboxVersion(endpoint, toolboxName, merged);
        await setDefaultVersion(endpoint, toolboxName, version);
        invalidateToolboxCache(endpoint, toolboxName);
        return { ok: true, version, toolbox: toolboxName, results: built.results };
    } catch (err) {
        return { ok: false, reason: reasonFor(err), detail: err?.body || err?.message || "" };
    }
}

// Create a NEW toolbox containing the selected Work IQ sub-tools.
export async function createToolboxWithWorkIQTools(endpoint, subscriptionId, toolboxName, variantIds) {
    if (!toolboxName || !Array.isArray(variantIds) || !variantIds.length) return { ok: false, reason: "bad_request" };
    try {
        const built = await ensureWorkIQEntries(endpoint, subscriptionId, [], variantIds);
        if (!built.ok) return built;
        if (!built.entries.length) return { ok: false, reason: "no_tools" };
        const version = await createToolboxVersion(endpoint, toolboxName, ensureIdentifiers(built.entries));
        await setDefaultVersion(endpoint, toolboxName, version);
        invalidateToolboxCache(endpoint, toolboxName);
        return { ok: true, version, toolbox: toolboxName, created: true, results: built.results };
    } catch (err) {
        return { ok: false, reason: reasonFor(err), detail: err?.body || err?.message || "" };
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

// ─── Hosted-agent region availability ────────────────────────────────────────
// Foundry hosted agents are only supported in a subset of Azure regions. There
// is no clean live ARM capability API for this, so the list below is the
// authoritative docs list, kept as normalized region codes.
// Source: https://learn.microsoft.com/azure/foundry/agents/concepts/hosted-agents#region-availability
// Last synced: 2026-07-01. Update when Microsoft adds regions.
export const HOSTED_AGENT_REGIONS_DOC =
    "https://learn.microsoft.com/azure/foundry/agents/concepts/hosted-agents#region-availability";

export const HOSTED_AGENT_REGIONS = [
    "eastus2",
    "northcentralus",
    "swedencentral",
    "canadacentral",
    "canadaeast",
    "southeastasia",
    "polandcentral",
    "southafricanorth",
    "koreacentral",
    "southindia",
    "brazilsouth",
    "westus",
    "westus3",
    "norwayeast",
    "japaneast",
    "francecentral",
    "germanywestcentral",
    "switzerlandnorth",
    "spaincentral",
    "australiaeast",
];

const _hostedRegionSet = new Set(HOSTED_AGENT_REGIONS);

// Normalize an ARM/ARG location to the canonical lowercase, space-free code
// (e.g. "East US 2" and "eastus2" both → "eastus2").
export function normalizeRegion(loc) {
    return String(loc || "").toLowerCase().replace(/[\s_]+/g, "");
}

// true (supported) / false (unsupported) / null (unknown — no region given).
export function isHostedAgentRegionSupported(loc) {
    const code = normalizeRegion(loc);
    if (!code) return null;
    return _hostedRegionSet.has(code);
}

// Resolve a project's Azure region (location) from its data-plane endpoint by
// matching against the subscription's projects (ARG). Cached like project ARM
// ids. Returns "" when it can't be resolved.
const _projLoc = new Map(); // endpoint -> location code
export async function resolveProjectLocation(endpoint, subscriptionId) {
    const ep = normalizeEndpoint(endpoint);
    if (!ep) return "";
    if (_projLoc.has(ep)) return _projLoc.get(ep);
    if (!subscriptionId) return "";
    const r = await listProjects(subscriptionId);
    if (!r.ok) return "";
    const match = (r.data || []).find((p) => normalizeEndpoint(p.endpoint) === ep);
    const loc = normalizeRegion(match?.location || "");
    if (loc) _projLoc.set(ep, loc);
    return loc;
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
