// foundry.mjs — live Foundry project and resource reads for the agent canvas.
//
// Pulls the *selected project's* real model deployments, toolboxes, skills, and
// guardrails from Microsoft Foundry data-plane and ARM APIs. Authentication and
// interactive sign-in lifecycle live in foundry-auth.mjs.

import {
    getAuthGeneration,
    getDefaultSubscriptionId,
    getToken,
    MANAGEMENT_SCOPE,
} from "./foundry-auth.mjs";

const API_VERSION = "2025-05-01";
const MGMT_BASE = "https://management.azure.com";
const TTL_MS = 30_000;
let cacheGeneration = 0;

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
    const token = await getToken(MANAGEMENT_SCOPE);
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
async function cached(key, producer, { force = false } = {}) {
    const authGeneration = getAuthGeneration();
    if (!force) {
        const hit = _cache.get(key);
        if (
            hit
            && hit.authGeneration === authGeneration
            && Date.now() < hit.exp
        ) {
            return hit.value;
        }
    }
    const generation = cacheGeneration;
    const value = await producer();
    if (
        generation !== cacheGeneration
        || authGeneration !== getAuthGeneration()
    ) {
        throw new Error("auth_changed");
    }
    _cache.set(key, {
        authGeneration,
        exp: Date.now() + TTL_MS,
        value,
    });
    return value;
}

export function clearFoundryCache() {
    cacheGeneration += 1;
    _cache.clear();
    _accountInfoCache.clear();
    _projLoc.clear();
}

function reasonFor(err) {
    if (err?.message === "not_signed_in") return "not_signed_in";
    if (err?.message === "auth_changed") return "auth_changed";
    if (err?.status === 401 || err?.status === 403) return "unauthorized";
    if (err?.status === 404) return "not_found";
    return "fetch_failed";
}

// ─── Public read API ──────────────────────────────────────────────────────────

// Returns { ok:true, data:[{ name, modelName, version, provider, sku }] }
// or { ok:false, reason }.
export async function listDeployments(endpoint, { force = false } = {}) {
    try {
        const json = await cached(`dep:${endpoint}`, () => apiGet(endpoint, "deployments"), { force });
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

// Returns { ok:true, data:[{ name, defaultVersion }] } or { ok:false, reason }.
// Foundry Toolboxes are a data-plane resource that bundles one or more tools
// behind a single MCP endpoint. The toolboxes API uses its own api-version (v1)
// and preview feature header.
export async function listToolboxes(endpoint, { force = false } = {}) {
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
        }, { force });
        const data = (json?.data || []).map((t) => ({
            name: t.name,
            defaultVersion: t.default_version || "",
        }));
        return { ok: true, data };
    } catch (err) {
        return { ok: false, reason: reasonFor(err) };
    }
}

// ─── Skills ─────────────────────────────────────────────────────────────────
// Skills are project-scoped structured instructions. The data-plane API uses
// its own preview feature header, similar to toolboxes.

export async function listSkills(endpoint, { force = false } = {}) {
    try {
        const json = await cached(`skills:${endpoint}`, async () => {
            const token = await getToken();
            const url = `${normalizeEndpoint(endpoint)}/skills?api-version=v1`;
            const res = await fetch(url, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/json",
                    "Foundry-Features": "Skills=V1Preview",
                },
            });
            if (!res.ok) {
                const err = new Error(`HTTP ${res.status}`);
                err.status = res.status;
                throw err;
            }
            return res.json();
        }, { force });
        const data = (json?.data || []).map((s) => ({
            name: s.name,
            defaultVersion: s.default_version || "",
        }));
        return { ok: true, data };
    } catch (err) {
        return { ok: false, reason: reasonFor(err) };
    }
}

// ─── RAI policies (guardrails) ──────────────────────────────────────────────
// Guardrails are scoped to the AI Services *account*, not the project. We
// resolve the account name + resource group from the project list, then call
// the ARM API to list all raiPolicies. Pagination is supported via nextLink.
const RAI_API_VERSION = "2024-10-01";
const _accountInfoCache = new Map();

async function resolveAccountInfo(endpoint, subscriptionId) {
    const ep = normalizeEndpoint(endpoint);
    const authGeneration = getAuthGeneration();
    const hit = _accountInfoCache.get(ep);
    if (hit?.authGeneration === authGeneration) return hit.value;
    if (!subscriptionId) return null;
    const generation = cacheGeneration;
    const r = await listProjects(subscriptionId);
    if (!r.ok) return null;
    if (
        generation !== cacheGeneration
        || authGeneration !== getAuthGeneration()
    ) {
        return null;
    }
    const match = (r.data || []).find((p) => normalizeEndpoint(p.endpoint) === ep);
    if (!match || !match.account || !match.rg) return null;
    const info = { account: match.account, rg: match.rg };
    _accountInfoCache.set(ep, { authGeneration, value: info });
    return info;
}

export async function listGuardrails(endpoint, subscriptionId, { force = false } = {}) {
    try {
        const acct = await resolveAccountInfo(endpoint, subscriptionId);
        if (!acct) return { ok: false, reason: "not_found" };
        const data = await cached(`rai:${endpoint}`, async () => {
            const all = [];
            let nextUrl = `/subscriptions/${subscriptionId}/resourceGroups/${acct.rg}/providers/Microsoft.CognitiveServices/accounts/${acct.account}/raiPolicies?api-version=${RAI_API_VERSION}`;
            while (nextUrl) {
                const json = await armFetch(nextUrl);
                if (json?.value) all.push(...json.value);
                nextUrl = json?.nextLink || null;
            }
            return all;
        }, { force });
        return { ok: true, data: data.map((p) => ({ name: p.name })) };
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

// All enabled subscriptions (ARM). Marks the az default. { ok, data | reason }.
export async function listSubscriptions() {
    try {
        const defaultId = await getDefaultSubscriptionId();
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
                        subscriptionId: row.subscriptionId || subscriptionId,
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
// is no public ARM or Foundry capability API for this, so the list below is
// synced weekly from Microsoft Learn by sync-hosted-agent-regions.mjs.
// Source: https://learn.microsoft.com/azure/foundry/agents/concepts/hosted-agents#region-availability
export const HOSTED_AGENT_REGIONS_DOC =
    "https://learn.microsoft.com/azure/foundry/agents/concepts/hosted-agents#region-availability";

// BEGIN HOSTED_AGENT_REGIONS
// Last synced: 2026-07-28.
export const HOSTED_AGENT_REGIONS = [
    "australiaeast",
    "brazilsouth",
    "canadacentral",
    "canadaeast",
    "centralus",
    "eastus",
    "eastus2",
    "francecentral",
    "germanywestcentral",
    "italynorth",
    "japaneast",
    "japanwest",
    "koreacentral",
    "northcentralus",
    "norwayeast",
    "polandcentral",
    "southafricanorth",
    "southcentralus",
    "southeastasia",
    "southindia",
    "spaincentral",
    "swedencentral",
    "switzerlandnorth",
    "switzerlandwest",
    "uaenorth",
    "uksouth",
    "ukwest",
    "westcentralus",
    "westeurope",
    "westus",
    "westus3",
];
// END HOSTED_AGENT_REGIONS

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
    const authGeneration = getAuthGeneration();
    const hit = _projLoc.get(ep);
    if (hit?.authGeneration === authGeneration) return hit.value;
    if (!subscriptionId) return "";
    const generation = cacheGeneration;
    const r = await listProjects(subscriptionId);
    if (!r.ok) return "";
    if (
        generation !== cacheGeneration
        || authGeneration !== getAuthGeneration()
    ) {
        return "";
    }
    const match = (r.data || []).find((p) => normalizeEndpoint(p.endpoint) === ep);
    const loc = normalizeRegion(match?.location || "");
    if (loc) _projLoc.set(ep, { authGeneration, value: loc });
    return loc;
}
