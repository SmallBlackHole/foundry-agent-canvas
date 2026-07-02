// Extension: foundry-agent-builder
// A canvas that reproduces the Foundry "Build agent" design. It lists the
// components a developer keeps adding (Models, Skills, Tools, Knowledge,
// Connected agents, Memory) plus a Deploy-to-Foundry entry. Add/Deploy
// affordances in the iframe "prompt to chat" by POSTing to /api/send, which
// forwards the text to the chat via session.send().
//
// Wiring lives here; catalog data is in catalog.mjs and the renderer assets
// live under public/.

import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { createInspectorServer } from "./inspector-backend/index.mjs";
import {
    tools,
    models,
    deployments,
    toolConnections,
    project,
    DEPLOY_PROMPT,
    INSPECT_PROMPT,
    selectModelPrompt,
    selectToolPrompt,
    selectToolboxPrompt,
    providerIcon,
    providerColor,
    toolIconFor,
} from "./catalog.mjs";
import { listDeployments, listConnections, listToolboxes, listToolboxTools, addToolToToolbox, createToolboxWithTool, listWorkIQVariants, addWorkIQToolsToToolbox, createToolboxWithWorkIQTools, getProject, resolveProjectLocation, isHostedAgentRegionSupported, HOSTED_AGENT_REGIONS, HOSTED_AGENT_REGIONS_DOC } from "./foundry.mjs";
import {
    getIdentity,
    getDefaultSubscriptionId,
    listSubscriptions,
    listProjects,
    signInStart,
    signInStatus,
    signInCancel,
    signOut,
} from "./foundry.mjs";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(EXT_DIR, "public");
const INSPECTOR_UI_DIR = join(EXT_DIR, "inspector-ui");

// Repo/workspace root. A project-scoped extension lives at
// <workspace>/.github/extensions/<name>, so the workspace root is three levels
// up from EXT_DIR. Fall back to the process cwd if that shape doesn't hold.
function workspaceRoot() {
    const up = join(EXT_DIR, "..", "..", "..");
    if (existsSync(join(up, ".github"))) return up;
    return process.cwd();
}

// ─── Selection persistence ─────────────────────────────────────────────────
// Remembers the user's chosen subscription + project so the picker keeps the
// selection across canvas reopens, extension reloads, and app restarts.
// Without this, every open re-bootstraps from the az CLI default subscription
// and the choice appears to "not stick". Stored as a single JSON file next to
// the extension; it holds only local UI selection (no secrets) and is
// gitignored so it never gets committed.
const SELECTION_FILE = join(EXT_DIR, ".selection.json");

function loadSelection() {
    try {
        if (!existsSync(SELECTION_FILE)) return null;
        const data = JSON.parse(readFileSync(SELECTION_FILE, "utf-8"));
        if (data && typeof data === "object") return data;
    } catch {
        /* ignore a corrupt/unreadable store */
    }
    return null;
}

function saveSelection(sel) {
    try {
        writeFileSync(SELECTION_FILE, JSON.stringify(sel ?? {}, null, 2), "utf-8");
    } catch (err) {
        logInspector(`Failed to persist selection: ${err?.message ?? err}`, "error");
    }
}

function clearSelection() {
    try {
        if (existsSync(SELECTION_FILE)) writeFileSync(SELECTION_FILE, "{}", "utf-8");
    } catch {
        /* ignore */
    }
}

// ─── Local Agent Inspector ─────────────────────────────────────────────────
// Serves the prebuilt inspector UI and proxies HTTP/WebSocket traffic to the
// locally running agent on AGENT_PORT. The inspector is a static web page with
// no azd dependency — it loads regardless of whether the agent is up, and
// proxied requests simply return 502 until the agent starts. Starting the
// agent itself is handled separately (the "Inspect locally" button sends a
// chat prompt asking the agent to run `azd ai agent run`). The inspector
// server is a singleton shared by every open builder instance.
const AGENT_PORT = 8088;
let inspectorProxyUrl = null;
let inspectorProxyServer = null;

function logInspector(msg, level = "info") {
    try {
        // session is initialized by the time any of these run (after joinSession).
        session?.log?.(`[inspector] ${msg}`, { level });
    } catch {
        /* ignore */
    }
}

// "Fix with Copilot" round-trip: the inspector posts an error summary, which we
// forward into the chat session so the agent can repair and restart.
function handleFixRequested(source, errorSummary) {
    logInspector(`Fix requested from ${source}: ${errorSummary}`);
    if (!session) {
        logInspector("Fix requested but no Copilot session available", "error");
        return;
    }
    const prompt =
        `The agent encountered an error during testing in the Agent Inspector:\n\n${errorSummary}\n\n` +
        "Please fix this error and do a clean restart of the agent with previous running agent " +
        "processes killed, so I can verify it works.";
    session
        .send({ prompt })
        .catch((err) => logInspector(`Failed to send fix request: ${err?.message ?? err}`, "error"));
}

async function getOrCreateInspectorProxy() {
    if (inspectorProxyUrl) return inspectorProxyUrl;
    const { url, server } = await createInspectorServer({
        uiDir: INSPECTOR_UI_DIR,
        agentPort: AGENT_PORT,
        onFixRequested: handleFixRequested,
    });
    inspectorProxyServer = server;
    inspectorProxyUrl = url;
    logInspector(`inspector server: ${inspectorProxyUrl}`);
    return inspectorProxyUrl;
}

// Return the inspector server URL. The inspector UI is a static web page that
// proxies to the agent on AGENT_PORT, so it loads even before the agent is
// running — the agent is started separately (the "Inspect locally" button
// sends a chat prompt asking the agent to run it). Proxied requests return 502
// until the agent is up, at which point the inspector connects automatically.
async function ensureInspectorProxy() {
    return getOrCreateInspectorProxy();
}

// The skills package + skill to (re)install when the user clicks "Install latest
// Foundry Skills". Deterministic — runs the command directly so there is no chat
// round-trip.
const SKILLS_REPO = "https://github.com/microsoft/azure-skills";
const SKILLS_SKILL = "microsoft-foundry";
const SKILLS_INSTALL_TIMEOUT_MS = 180_000;

// Run `npx skills add <repo> --skill <skill>` directly and resolve with a small
// status object. No LLM/chat turn involved. `shell:true` so `npx` resolves to
// npx.cmd on Windows. We capture output and surface the last meaningful line so
// the canvas can show "up to date" vs "installed".
function installFoundrySkill() {
    return new Promise((resolve) => {
        const args = ["skills", "add", SKILLS_REPO, "--skill", SKILLS_SKILL];
        let child;
        try {
            child = spawn("npx", args, {
                cwd: EXT_DIR,
                shell: true,
                windowsHide: true,
                env: process.env,
            });
        } catch (err) {
            resolve({ ok: false, code: -1, summary: `Could not start npx: ${err?.message ?? err}` });
            return;
        }

        let out = "";
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };

        const timer = setTimeout(() => {
            try {
                child.kill();
            } catch {
                /* ignore */
            }
            finish({ ok: false, code: -1, summary: "Timed out after 3 min. Try installing from a terminal." });
        }, SKILLS_INSTALL_TIMEOUT_MS);

        child.stdout?.on("data", (d) => {
            out += d.toString();
        });
        child.stderr?.on("data", (d) => {
            out += d.toString();
        });
        child.on("error", (err) => {
            finish({ ok: false, code: -1, summary: `npx failed: ${err?.message ?? err}` });
        });
        child.on("close", (code) => {
            finish({ ok: code === 0, code: code ?? -1, summary: summarizeSkillOutput(out, code) });
        });
    });
}

// Distil the npx output into one short status line for the canvas.
function summarizeSkillOutput(raw, code) {
    const text = String(raw || "").replace(/\u001b\[[0-9;]*m/g, ""); // strip ANSI
    if (code === 0) {
        if (/up[\s-]?to[\s-]?date|already.*(installed|latest|up to date)/i.test(text)) {
            return "Already up to date";
        }
        return "Installed latest Foundry Skills";
    }
    // Strip the decorative box-drawing / bullet glyphs the skills CLI prints,
    // but never letters or digits. (An earlier version stripped o/O/0 too, which
    // turned a real "Installation failed" line into "Installati n failed".)
    const DECOR = /[\u2500-\u25FF\u2022\u00B7|]/g;
    const lines = text
        .split(/\r?\n/)
        .map((l) => l.replace(DECOR, " ").replace(/^[\s*+-]+/, "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
    const lastErr = lines.reverse().find((l) =>
        /(error|err!|fail|not found|cannot|could ?n['o]t|unable|denied|permission|refused|timed? out|enoent|econn|resolve)/i.test(l)
    );
    return lastErr || lines[0] || `npx exited with code ${code}`;
}


// Default selected Foundry project (data-plane endpoint). Empty by default;
// overridable per instance via the canvas open() input or resolved at runtime
// from the signed-in user's project. Never hardcode a real project here.
const PROJECT_ENDPOINT = "";

const PAGES = ["build", "tools", "models"];

const CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
};

// One local server per open canvas instance. Each entry tracks its own view
// state and the set of connected SSE clients (the open iframe).
const servers = new Map(); // instanceId -> { server, url, state, sseClients:Set }

function defaultState() {
    return {
        page: "build",
        agentName: "",
        project: { ...project },
        projectEndpoint: PROJECT_ENDPOINT,
        projectLocation: "",
        subscriptionId: "",
        bootstrapped: false,
        model: { name: "", color: "#10a37f" },
    };
}

// Merge an open() input payload into an instance's view state.
function applyInput(state, input) {
    if (!input || typeof input !== "object") return state;
    if (typeof input.page === "string" && PAGES.includes(input.page)) state.page = input.page;
    if (typeof input.agentName === "string" && input.agentName.trim()) state.agentName = input.agentName.trim();
    if (typeof input.projectEndpoint === "string" && input.projectEndpoint.trim()) {
        state.projectEndpoint = input.projectEndpoint.trim();
    }
    if (typeof input.projectName === "string" && input.projectName.trim()) {
        state.project = { ...state.project, name: input.projectName.trim() };
    }
    if (typeof input.model === "string" && input.model.trim()) {
        const match = models.find((m) => m.name.toLowerCase() === input.model.trim().toLowerCase());
        state.model = { name: input.model.trim(), color: match ? match.color : "#57606a" };
    }
    return state;
}

function slug(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Shape a live deployment into the dropdown item the client expects.
function enrichDeployment(d) {
    return {
        id: d.name,
        name: d.name,
        provider: d.provider,
        version: d.version,
        color: providerColor(d.provider),
        iconSrc: providerIcon(d.provider),
        prompt: selectModelPrompt(d.name),
    };
}

// Shape a live tool connection into the dropdown item the client expects.
function enrichConnection(c) {
    const { iconSrc, color } = toolIconFor(`${c.name} ${c.toolEntityId} ${c.metaType} ${c.type}`);
    return {
        id: slug(c.name),
        name: c.name,
        kind: c.type,
        iconSrc,
        color,
        prompt: selectToolPrompt(c.name),
    };
}

// Shape a live Foundry Toolbox into the dropdown item the client expects.
function enrichToolbox(t) {
    return {
        id: slug(t.name),
        name: t.name,
        version: t.defaultVersion || "",
        prompt: selectToolboxPrompt(t.name),
    };
}

// Resolve a sensible default selection (az default subscription + its first
// Foundry project). Falls back to an empty selection on any failure (signed
// out / no projects). Lazy — called from /api/bootstrap, never from open(), so
// opening the canvas stays instant.
async function bootstrapInstance(entry) {
    const identity = await getIdentity();
    let resolved = false;
    if (identity.signedIn) {
        const saved = loadSelection();
        if (saved && saved.subscriptionId) {
            // Prefer the user's persisted selection so it sticks across
            // reopens/reloads instead of resetting to the az CLI default.
            entry.state.subscriptionId = saved.subscriptionId;
            identity.subscriptionId = saved.subscriptionId;
            if (saved.subscriptionName) identity.subscriptionName = saved.subscriptionName;
            if (saved.projectEndpoint) {
                entry.state.projectEndpoint = saved.projectEndpoint;
                entry.state.projectLocation = saved.projectLocation || "";
                entry.state.project = {
                    ...entry.state.project,
                    name: saved.projectName || getProject(saved.projectEndpoint).projectName || "",
                };
                resolved = true;
            } else {
                entry.state.projectEndpoint = "";
                entry.state.projectLocation = "";
                entry.state.project = { ...entry.state.project, name: "" };
            }
        } else {
            const subId = identity.subscriptionId || getDefaultSubscriptionId();
            if (subId) {
                entry.state.subscriptionId = subId;
                const proj = await listProjects(subId);
                if (proj.ok && proj.data.length) {
                    const first = proj.data[0];
                    entry.state.projectEndpoint = first.endpoint;
                    entry.state.projectLocation = first.location || "";
                    entry.state.project = { ...entry.state.project, name: first.name };
                    resolved = true;
                } else {
                    // Signed in, but the selected subscription has no Foundry
                    // projects. Clear the project so the header stays consistent
                    // with the subscription instead of showing a stale default
                    // from another subscription (e.g. the hardcoded sample
                    // endpoint). The user can pick a project via "Switch project".
                    entry.state.projectEndpoint = "";
                    entry.state.projectLocation = "";
                    entry.state.project = { ...entry.state.project, name: "" };
                }
            }
        }
    }
    entry.state.bootstrapped = true;
    const p = getProject(entry.state.projectEndpoint);
    return {
        identity,
        subscriptionId: entry.state.subscriptionId,
        resolved,
        project: { name: p.projectName || entry.state.project?.name || "", endpoint: p.endpoint },
    };
}

function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(payload);
}

function serveStatic(res, fileName) {
    try {
        const ext = fileName.slice(fileName.lastIndexOf("."));
        const body = readFileSync(join(PUBLIC_DIR, fileName));
        res.writeHead(200, { "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream" });
        res.end(body);
    } catch {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
    }
}

function readBody(req, limit = 1_000_000) {
    return new Promise((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => {
            data += chunk;
            if (data.length > limit) {
                reject(new Error("Body too large"));
                req.destroy();
            }
        });
        req.on("end", () => resolve(data));
        req.on("error", reject);
    });
}

function pushNavigate(entry, page) {
    const frame = `data: ${JSON.stringify({ type: "navigate", page })}\n\n`;
    for (const client of entry.sseClients) {
        try {
            client.write(frame);
        } catch {
            /* drop broken client */
        }
    }
}

function pushSetProtocol(entry, protocol) {
    const frame = `data: ${JSON.stringify({ type: "setProtocol", protocol })}\n\n`;
    for (const client of entry.sseClients) {
        try {
            client.write(frame);
        } catch {
            /* drop broken client */
        }
    }
}

function pushFrame(entry, obj) {
    const frame = `data: ${JSON.stringify(obj)}\n\n`;
    for (const client of entry.sseClients) {
        try {
            client.write(frame);
        } catch {
            /* drop broken client */
        }
    }
}

function createRequestHandler(instanceId) {
    return async (req, res) => {
        const entry = servers.get(instanceId);
        const url = new URL(req.url, "http://127.0.0.1");
        const path = url.pathname;
        const method = req.method || "GET";

        // Static assets.
        if (method === "GET" && (path === "/" || path === "/index.html")) return serveStatic(res, "index.html");
        if (method === "GET" && path === "/app.css") return serveStatic(res, "app.css");
        if (method === "GET" && path === "/app.js") return serveStatic(res, "app.js");

        // Model provider icons (path-traversal-safe: name must be a bare slug).
        if (method === "GET" && path.startsWith("/model-icons/")) {
            const name = path.slice("/model-icons/".length);
            if (/^[a-z0-9-]+\.svg$/.test(name)) return serveStatic(res, join("model-icons", name));
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Not found");
            return;
        }

        // Tool icons (path-traversal-safe: name must be a bare slug).
        if (method === "GET" && path.startsWith("/tool-icons/")) {
            const name = path.slice("/tool-icons/".length);
            if (/^[a-z0-9-]+\.svg$/.test(name)) return serveStatic(res, join("tool-icons", name));
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Not found");
            return;
        }

        // Per-instance view state for the SPA.
        if (method === "GET" && path === "/api/state") {
            const state = entry ? entry.state : defaultState();
            return sendJson(res, 200, { ...state, deployPrompt: DEPLOY_PROMPT, inspectPrompt: INSPECT_PROMPT });
        }

        // Live project identity (parsed from the endpoint; no network).
        if (method === "GET" && path === "/api/project") {
            const ep = (entry ? entry.state.projectEndpoint : null) || PROJECT_ENDPOINT;
            const p = getProject(ep);
            const name = p.projectName || (entry ? entry.state.project?.name : project.name) || "";
            return sendJson(res, 200, { ok: true, name, endpoint: p.endpoint, resourceName: p.resourceName });
        }

        // Live model deployments in the selected project (mock fallback).
        if (method === "GET" && path === "/api/deployments") {
            const ep = (entry ? entry.state.projectEndpoint : null) || PROJECT_ENDPOINT;
            const r = await listDeployments(ep);
            if (r.ok) {
                return sendJson(res, 200, { ok: true, source: "live", items: r.data.map(enrichDeployment) });
            }
            return sendJson(res, 200, { ok: true, source: "mock", reason: r.reason, items: deployments });
        }

        // Live tool connections in the selected project (mock fallback).
        if (method === "GET" && path === "/api/connections") {
            const ep = (entry ? entry.state.projectEndpoint : null) || PROJECT_ENDPOINT;
            const r = await listConnections(ep);
            if (r.ok) {
                return sendJson(res, 200, { ok: true, source: "live", items: r.data.map(enrichConnection) });
            }
            return sendJson(res, 200, { ok: true, source: "mock", reason: r.reason, items: toolConnections });
        }

        // Live Foundry Toolboxes in the selected project. Unlike connections,
        // there is no mock fallback — an empty/failed result just yields an
        // empty list, which the client renders as "No toolboxes".
        if (method === "GET" && path === "/api/toolboxes") {
            const ep = (entry ? entry.state.projectEndpoint : null) || PROJECT_ENDPOINT;
            const r = await listToolboxes(ep);
            if (r.ok) {
                return sendJson(res, 200, { ok: true, items: r.data.map(enrichToolbox) });
            }
            return sendJson(res, 200, { ok: false, reason: r.reason, items: [] });
        }

        // Tools inside a single toolbox (lazy — fetched when a row is expanded).
        if (method === "GET" && path === "/api/toolbox/tools") {
            const ep = (entry ? entry.state.projectEndpoint : null) || PROJECT_ENDPOINT;
            const name = url.searchParams.get("name") || "";
            const version = url.searchParams.get("version") || "";
            const r = await listToolboxTools(ep, name, version);
            if (r.ok) return sendJson(res, 200, { ok: true, items: r.data });
            return sendJson(res, 200, { ok: false, reason: r.reason, items: [] });
        }

        // Add a catalog tool into an EXISTING toolbox directly via the data-plane
        // API (no chat turn). Returns a structured result; the frontend falls back
        // to the prompt path on { ok:false, reason:'needs_connection' }.
        if (method === "POST" && path === "/api/toolbox/add-tool") {
            const ep = (entry ? entry.state.projectEndpoint : null) || PROJECT_ENDPOINT;
            try {
                const { toolbox, toolId, toolName } = JSON.parse((await readBody(req)) || "{}");
                if (!toolbox || !toolId) return sendJson(res, 400, { ok: false, reason: "bad_request" });
                const r = await addToolToToolbox(ep, toolbox, toolId, toolName || "");
                return sendJson(res, 200, r);
            } catch (err) {
                await session.log(`add-tool failed: ${err?.message ?? err}`, { level: "error" });
                return sendJson(res, 500, { ok: false, reason: "exception", detail: String(err?.message ?? err) });
            }
        }

        // Create a NEW toolbox containing just the catalog tool, via the API.
        if (method === "POST" && path === "/api/toolbox/create-with-tool") {
            const ep = (entry ? entry.state.projectEndpoint : null) || PROJECT_ENDPOINT;
            try {
                const { name, toolId, toolName } = JSON.parse((await readBody(req)) || "{}");
                if (!name || !toolId) return sendJson(res, 400, { ok: false, reason: "bad_request" });
                const r = await createToolboxWithTool(ep, name, toolId, toolName || "");
                return sendJson(res, 200, r);
            } catch (err) {
                await session.log(`create-with-tool failed: ${err?.message ?? err}`, { level: "error" });
                return sendJson(res, 500, { ok: false, reason: "exception", detail: String(err?.message ?? err) });
            }
        }

        // ── Work IQ sub-tool picker ─────────────────────────────────────────
        // List the Work IQ MCP variants (Teams, Mail, Word, ...) the developer
        // can add. Live catalog with a hardcoded fallback.
        if (method === "GET" && path === "/api/workiq/variants") {
            const ep = (entry ? entry.state.projectEndpoint : null) || PROJECT_ENDPOINT;
            const r = await listWorkIQVariants(ep);
            return sendJson(res, 200, r);
        }

        // Add selected Work IQ sub-tools into an EXISTING toolbox, CREATING the
        // required (secret-free, OBO) connections along the way. Falls back to
        // the chat prompt via { ok:false, reason:'needs_connection' }.
        if (method === "POST" && path === "/api/workiq/add-tools") {
            const ep = (entry ? entry.state.projectEndpoint : null) || PROJECT_ENDPOINT;
            const sub = entry ? entry.state.subscriptionId : "";
            try {
                const { toolbox, variantIds } = JSON.parse((await readBody(req)) || "{}");
                if (!toolbox || !Array.isArray(variantIds) || !variantIds.length) {
                    return sendJson(res, 400, { ok: false, reason: "bad_request" });
                }
                const r = await addWorkIQToolsToToolbox(ep, sub, toolbox, variantIds);
                return sendJson(res, 200, r);
            } catch (err) {
                await session.log(`workiq add-tools failed: ${err?.message ?? err}`, { level: "error" });
                return sendJson(res, 500, { ok: false, reason: "exception", detail: String(err?.message ?? err) });
            }
        }

        // Create a NEW toolbox containing the selected Work IQ sub-tools.
        if (method === "POST" && path === "/api/workiq/create-with-tools") {
            const ep = (entry ? entry.state.projectEndpoint : null) || PROJECT_ENDPOINT;
            const sub = entry ? entry.state.subscriptionId : "";
            try {
                const { name, variantIds } = JSON.parse((await readBody(req)) || "{}");
                if (!name || !Array.isArray(variantIds) || !variantIds.length) {
                    return sendJson(res, 400, { ok: false, reason: "bad_request" });
                }
                const r = await createToolboxWithWorkIQTools(ep, sub, name, variantIds);
                return sendJson(res, 200, r);
            } catch (err) {
                await session.log(`workiq create-with-tools failed: ${err?.message ?? err}`, { level: "error" });
                return sendJson(res, 500, { ok: false, reason: "exception", detail: String(err?.message ?? err) });
            }
        }

        // ── Project picker: identity / subscriptions / projects ──────────────
        if (method === "GET" && path === "/api/identity") {
            const identity = await getIdentity();
            return sendJson(res, 200, { ok: true, ...identity });
        }

        // Lazy default-selection resolver (default sub + first project).
        if (method === "GET" && path === "/api/bootstrap") {
            if (!entry) return sendJson(res, 200, { ok: false, reason: "no_instance" });
            try {
                const result = await bootstrapInstance(entry);
                return sendJson(res, 200, { ok: true, ...result });
            } catch (err) {
                await session.log(`bootstrap failed: ${err?.message ?? err}`, { level: "error" });
                return sendJson(res, 200, { ok: false, reason: "bootstrap_failed" });
            }
        }

        if (method === "GET" && path === "/api/subscriptions") {
            const r = await listSubscriptions();
            if (r.ok) return sendJson(res, 200, { ok: true, items: r.data });
            return sendJson(res, 200, { ok: false, reason: r.reason, items: [] });
        }

        if (method === "GET" && path === "/api/projects") {
            const sub = url.searchParams.get("sub") || (entry ? entry.state.subscriptionId : "");
            const r = await listProjects(sub);
            if (r.ok) return sendJson(res, 200, { ok: true, items: r.data });
            return sendJson(res, 200, { ok: false, reason: r.reason, items: [] });
        }

        if (method === "POST" && path === "/api/select-subscription") {
            try {
                const body = JSON.parse((await readBody(req)) || "{}");
                const subscriptionId = typeof body.subscriptionId === "string" ? body.subscriptionId.trim() : "";
                if (!subscriptionId) {
                    return sendJson(res, 400, { ok: false, error: "Missing subscriptionId" });
                }
                if (entry) entry.state.subscriptionId = subscriptionId;
                if (entry) entry.state.projectLocation = "";
                // Persist the subscription. Switching subscription resets the
                // project, so clear the persisted project too until one is picked.
                saveSelection({
                    subscriptionId,
                    subscriptionName: typeof body.subscriptionName === "string" ? body.subscriptionName : "",
                    projectEndpoint: "",
                    projectName: "",
                    projectLocation: "",
                });
                return sendJson(res, 200, { ok: true });
            } catch (err) {
                return sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
            }
        }

        if (method === "POST" && path === "/api/select-project") {
            try {
                const body = JSON.parse((await readBody(req)) || "{}");
                const ep = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
                if (!ep) return sendJson(res, 400, { ok: false, error: "Missing endpoint" });
                const p = getProject(ep);
                const name = (typeof body.name === "string" && body.name.trim()) || p.projectName || "project";
                const subscriptionId = typeof body.subscriptionId === "string" ? body.subscriptionId.trim() : "";
                const location = typeof body.location === "string" ? body.location.trim() : "";
                if (entry) {
                    entry.state.projectEndpoint = ep;
                    entry.state.projectLocation = location;
                    entry.state.project = { ...entry.state.project, name };
                    if (subscriptionId) entry.state.subscriptionId = subscriptionId;
                }
                // Persist the full subscription + project selection.
                saveSelection({
                    subscriptionId: subscriptionId || (entry ? entry.state.subscriptionId : ""),
                    subscriptionName: typeof body.subscriptionName === "string" ? body.subscriptionName : "",
                    projectEndpoint: p.endpoint,
                    projectName: name,
                    projectLocation: location,
                });
                return sendJson(res, 200, { ok: true, name, endpoint: p.endpoint });
            } catch (err) {
                return sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
            }
        }

        // Hosted-agent region availability for the selected project. Drives the
        // Deploy button + warning banner. `supported` is true / false / null
        // (null = unknown → the client leaves Deploy enabled, i.e. fail open).
        if (method === "GET" && path === "/api/region-support") {
            const docsUrl = HOSTED_AGENT_REGIONS_DOC;
            const regions = HOSTED_AGENT_REGIONS;
            const ep = entry ? entry.state.projectEndpoint : "";
            if (!ep) {
                return sendJson(res, 200, { ok: true, location: "", supported: null, regions, docsUrl });
            }
            let location = (entry && entry.state.projectLocation) || "";
            if (!location) {
                try {
                    location = await resolveProjectLocation(ep, entry ? entry.state.subscriptionId : "");
                    if (location && entry) entry.state.projectLocation = location;
                } catch {
                    location = "";
                }
            }
            const supported = isHostedAgentRegionSupported(location);
            return sendJson(res, 200, { ok: true, location, supported, regions, docsUrl });
        }

        // ── Sign in / out (device-code flow shown in the canvas) ─────────────
        if (method === "POST" && path === "/api/signin") {
            const r = await signInStart();
            return sendJson(res, r.ok ? 200 : 200, r);
        }

        if (method === "GET" && path === "/api/signin/status") {
            const sessionId = url.searchParams.get("sessionId") || "";
            const r = await signInStatus(sessionId);
            return sendJson(res, 200, r);
        }

        if (method === "POST" && path === "/api/signin/cancel") {
            try {
                const { sessionId } = JSON.parse((await readBody(req)) || "{}");
                return sendJson(res, 200, signInCancel(sessionId || ""));
            } catch {
                return sendJson(res, 200, { ok: true });
            }
        }

        if (method === "POST" && path === "/api/signout") {
            const r = await signOut();
            clearSelection();
            if (entry) {
                entry.state.subscriptionId = "";
                entry.state.bootstrapped = false;
            }
            return sendJson(res, 200, r);
        }

        // Catalogs (recommended + mocked), prompts already attached.
        if (method === "GET" && path === "/api/tools") return sendJson(res, 200, { tools });
        if (method === "GET" && path === "/api/models") return sendJson(res, 200, { models });

        // Server-Sent Events so an agent-invoked navigate() reflects live.
        if (method === "GET" && path === "/events") {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
            });
            res.write(":ok\n\n");
            if (entry) {
                entry.sseClients.add(res);
                req.on("close", () => entry.sseClients.delete(res));
            }
            return;
        }

        // "Prompt to chat": forward the text to the session as a user turn.
        if (method === "POST" && path === "/api/send") {
            try {
                const raw = await readBody(req);
                const { prompt } = JSON.parse(raw || "{}");
                if (typeof prompt !== "string" || !prompt.trim()) {
                    return sendJson(res, 400, { ok: false, error: "Missing prompt" });
                }
                await session.send({ prompt });
                return sendJson(res, 200, { ok: true });
            } catch (err) {
                await session.log(`Failed to send prompt to chat: ${err?.message ?? err}`, { level: "error" });
                return sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
            }
        }

        // Absolute path of the embedded Responses-vs-Invocations reference file,
        // so the "Responses vs Invocations" prompt can point the agent at one file
        // instead of inlining the whole text.
        if (method === "GET" && path === "/api/protocol-ref") {
            return sendJson(res, 200, {
                path: join(EXT_DIR, "references", "responses-vs-invocations.md"),
            });
        }

        // Whether the workspace already has agent scaffolding. Drives the
        // initial expand/fold state of the Build sections: an un-initialized
        // project expands "Initialize Agent Code"; an initialized one folds it
        // and expands "Add Project Resources" / "Deploy & Test".
        if (method === "GET" && path === "/api/project-init") {
            const root = workspaceRoot();
            const hasAzure = existsSync(join(root, "azure.yaml")) || existsSync(join(root, "azure.yml"));
            const hasAgent = existsSync(join(root, "agent.yaml")) || existsSync(join(root, "agent.yml"));
            return sendJson(res, 200, {
                ok: true,
                hasAzure,
                hasAgent,
                initialized: hasAzure || hasAgent,
            });
        }

        // Install/upgrade the microsoft-foundry skill directly (no chat turn).
        if (method === "POST" && path === "/api/skills/install") {
            try {
                const result = await installFoundrySkill();
                if (!result.ok) {
                    await session.log(`Skills install failed: ${result.summary}`, { level: "error" });
                }
                return sendJson(res, 200, result);
            } catch (err) {
                await session.log(`Skills install error: ${err?.message ?? err}`, { level: "error" });
                return sendJson(res, 500, { ok: false, code: -1, summary: String(err?.message ?? err) });
            }
        }

        // Probe whether the local agent is up and accepting requests.
        // Returns { ready: true } when localhost:AGENT_PORT responds to any HTTP request,
        // { ready: false } on connection refused / timeout. Used by the UI to poll before
        // loading the inspector iframe.
        if (method === "GET" && path === "/api/inspect/ready") {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 2000);
                try {
                    await fetch(`http://localhost:${AGENT_PORT}/agentdev/version`, {
                        signal: controller.signal,
                    });
                    clearTimeout(timeout);
                    // Any HTTP response (including 404) means the server is up.
                    return sendJson(res, 200, { ready: true });
                } catch {
                    clearTimeout(timeout);
                    return sendJson(res, 200, { ready: false });
                }
            } catch (err) {
                return sendJson(res, 200, { ready: false });
            }
        }

        // Launch (or reuse) the local Agent Inspector and return its URL.
        if (method === "GET" && path === "/api/inspect/start") {
            try {
                const proxyUrl = await ensureInspectorProxy();
                if (!proxyUrl) {
                    return sendJson(res, 200, {
                        ok: false,
                        error: "Inspector failed to start. Check the extension logs for details.",
                    });
                }
                return sendJson(res, 200, { ok: true, url: proxyUrl });
            } catch (err) {
                await session.log(`Inspector start failed: ${err?.message ?? err}`, { level: "error" });
                return sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
            }
        }

        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
    };
}

async function startServer(instanceId) {
    const server = createServer(createRequestHandler(instanceId));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/`, state: defaultState(), sseClients: new Set() };
}

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "agent-builder",
            displayName: "Foundry Agent Canvas",
            description:
                "Create, build, or design a Foundry agent — use this whenever the user wants to make, set up, or scaffold a new agent: pick a model, add tools, skills, knowledge, then deploy it as a Foundry hosted agent.",
            inputSchema: {
                type: "object",
                properties: {
                    page: { type: "string", enum: PAGES, description: "Initial view to show." },
                    agentName: { type: "string", description: "Name shown in the builder header." },
                    model: { type: "string", description: "Currently selected model name." },
                    projectEndpoint: {
                        type: "string",
                        description:
                            "Foundry project data-plane endpoint whose live model deployments and tool connections the selectors should show (e.g. https://<resource>.services.ai.azure.com/api/projects/<project>).",
                    },
                    projectName: { type: "string", description: "Display name of the selected Foundry project." },
                },
                additionalProperties: false,
            },
            actions: [
                {
                    name: "navigate",
                    description: "Switch the open canvas to the build, tools, or models view.",
                    inputSchema: {
                        type: "object",
                        properties: { page: { type: "string", enum: PAGES } },
                        required: ["page"],
                        additionalProperties: false,
                    },
                    handler: async (ctx) => {
                        const entry = servers.get(ctx.instanceId);
                        if (!entry) throw new CanvasError("canvas_not_open", "No open canvas instance for this id.");
                        entry.state.page = ctx.input.page;
                        pushNavigate(entry, ctx.input.page);
                        return { ok: true, page: ctx.input.page };
                    },
                },
                {
                    name: "setProtocol",
                    description:
                        'Set the agent protocol in the builder\'s "Initialize agent code" starter prompt. ' +
                        "Call this after the user picks between Responses and Invocations so the prompt updates to match.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            protocol: {
                                type: "string",
                                enum: ["Responses", "Invocations"],
                                description: "The hosted-agent protocol the user chose.",
                            },
                        },
                        required: ["protocol"],
                        additionalProperties: false,
                    },
                    handler: async (ctx) => {
                        const entry = servers.get(ctx.instanceId);
                        if (!entry) throw new CanvasError("canvas_not_open", "No open canvas instance for this id.");
                        entry.state.initProtocol = ctx.input.protocol;
                        pushSetProtocol(entry, ctx.input.protocol);
                        return { ok: true, protocol: ctx.input.protocol };
                    },
                },
                {
                    name: "setAgentIdea",
                    description:
                        "Set the agent's purpose phrase in the builder's starter prompt. Pass a short phrase " +
                        "(2-4 words) that fits the sentence 'Create a ___ Python hosted agent'.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            idea: {
                                type: "string",
                                description:
                                    "Short purpose phrase, e.g. 'meeting-notes-summarizing' or 'invoice-parsing'.",
                            },
                        },
                        required: ["idea"],
                        additionalProperties: false,
                    },
                    handler: async (ctx) => {
                        const entry = servers.get(ctx.instanceId);
                        if (!entry) throw new CanvasError("canvas_not_open", "No open canvas instance for this id.");
                        entry.state.initIdea = ctx.input.idea;
                        pushFrame(entry, { type: "setIdea", idea: ctx.input.idea });
                        return { ok: true, idea: ctx.input.idea };
                    },
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(ctx.instanceId);
                    servers.set(ctx.instanceId, entry);
                }
                applyInput(entry.state, ctx.input);
                return { title: "Foundry Agent Canvas", url: entry.url, status: "Build" };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    for (const client of entry.sseClients) {
                        try {
                            client.end();
                        } catch {
                            /* ignore */
                        }
                    }
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
    ],
});
