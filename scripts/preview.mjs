// Standalone browser preview for the Foundry Agent Canvas.
//
// This intentionally does not import extension.mjs: the real extension entry
// depends on @github/copilot-sdk/extension, which is provided by the Copilot
// runtime rather than this repo. The preview server hosts the same public SPA
// and stubs host/runtime operations so the canvas can be inspected in a normal
// integrated browser.

import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
    DEPLOY_PROMPT,
    providerColor,
    selectModelPrompt,
    selectToolboxPrompt,
    selectSkillPrompt,
    selectGuardrailPrompt,
    toolConnections,
} from "../src/catalog.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = join(ROOT, "public");
const PROTOCOL_REF = join(ROOT, "references", "responses-vs-invocations.md");
const PREVIEW_MOCK_JS = join(ROOT, "scripts", "preview-mock.js");
const PREVIEW_MOCK_CSS = join(ROOT, "scripts", "preview-mock.css");

const HOST = valueFor("--host") || process.env.HOST || "127.0.0.1";
const PORT = Number(valueFor("--port") || process.env.PORT || 0);
// Repro/verify knobs:
//   --kill-after <ms> / PREVIEW_KILL_AFTER_MS
//       After N ms, drop every SSE client and stop the server from listening.
//       Simulates the backing loopback server's port going away (in the real
//       extension this now only happens on a process restart / extensions_reload,
//       since the eager teardown was removed). The still-open iframe then shows
//       "Canvas disconnected — reload" and a raw Reload lands on "127.0.0.1
//       refused to connect" — lets you verify the client's reconnect/recovery.
//   --sse-heartbeat <ms> / PREVIEW_SSE_HEARTBEAT_MS (default 20000; 0 disables)
//       Heartbeat cadence for /events. Set 0 to let an idle SSE be dropped. This
//       is the preview-side counterpart of the extension's
//       FOUNDRY_CANVAS_SSE_HEARTBEAT_MS (named per-context, same behavior).
const KILL_AFTER_MS = Number(valueFor("--kill-after") || process.env.PREVIEW_KILL_AFTER_MS || 0);
const SSE_HEARTBEAT_MS = (() => {
    const raw = valueFor("--sse-heartbeat") || process.env.PREVIEW_SSE_HEARTBEAT_MS;
    const n = Number(raw);
    return raw && Number.isFinite(n) && n >= 0 ? n : 20_000;
})();

const CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ttf": "font/ttf",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
};

const identity = {
    signedIn: true,
    account: "preview@local",
    tenantId: "preview-tenant",
    subscriptionId: "preview-subscription",
    subscriptionName: "Preview Subscription",
};

const subscriptions = [{ id: identity.subscriptionId, name: identity.subscriptionName, isDefault: true }];

const projects = [
    {
        account: "preview-foundry",
        endpoint: "https://preview.services.ai.azure.com/api/projects/preview-project",
        id: "/subscriptions/preview/resourceGroups/preview/providers/Microsoft.CognitiveServices/accounts/preview/projects/preview-project",
        location: "eastus2",
        name: "Preview Project",
        project: "Preview Project",
        rg: "preview-rg",
    },
];

let selectedProject = projects[0];

const state = {
    page: "build",
    agentName: "Preview Agent",
    project: { name: selectedProject.name, endpoint: selectedProject.endpoint, rg: selectedProject.rg, account: selectedProject.account },
    projectEndpoint: selectedProject.endpoint,
    projectLocation: selectedProject.location,
    subscriptionId: identity.subscriptionId,
    bootstrapped: true,
    model: { name: "gpt-5", color: "#10a37f" },
};

function mockBool(url, key, fallback = true) {
    const raw = url.searchParams.get(key);
    if (raw == null) return fallback;
    return raw !== "false";
}

function mockSignedIn(url) {
    return mockBool(url, "signedIn", true);
}

function mockProjectSelected(url) {
    return mockSignedIn(url) && mockBool(url, "project", true);
}

function mockAzureCli(url) {
    return mockBool(url, "az", true);
}

function mockAzd(url) {
    return mockBool(url, "azd", true);
}

function emptyProject() {
    return { name: "", endpoint: "", rg: "", account: "" };
}

function mockIdentity(url) {
    if (!mockSignedIn(url)) {
        return {
            signedIn: false,
            account: "",
            tenantId: "",
            subscriptionId: "",
            subscriptionName: "",
        };
    }
    return identity;
}

function mockProjectState(url) {
    if (!mockProjectSelected(url)) return emptyProject();
    return { name: selectedProject.name, endpoint: selectedProject.endpoint, rg: selectedProject.rg, account: selectedProject.account };
}

function projectScopedUnavailable(url) {
    if (!mockSignedIn(url)) return "not_signed_in";
    if (!mockProjectSelected(url)) return "no_project";
    return "";
}

const previewDeployments = [
    { id: "gpt-5.5", name: "gpt-5.5", provider: "OpenAI" },
    { id: "gpt-5.4", name: "gpt-5.4", provider: "OpenAI" },
    { id: "gpt-5", name: "gpt-5", provider: "OpenAI" },
].map((m) => ({
    ...m,
    version: "preview",
    color: providerColor(m.provider),
    prompt: selectModelPrompt(m.name),
}));

const previewToolboxes = [
    { id: "starter-toolbox", name: "Starter Toolbox", version: "1", prompt: selectToolboxPrompt("Starter Toolbox") },
    { id: "research-toolbox", name: "Research Toolbox", version: "2", prompt: selectToolboxPrompt("Research Toolbox") },
];

const previewToolboxTools = {
    "Starter Toolbox": [
        { name: "Web search", type: "mcp" },
        { name: "File Search", type: "built-in" },
    ],
    "Research Toolbox": [
        { name: "GitHub", type: "mcp" },
        { name: "Azure AI Search", type: "built-in" },
    ],
};

const previewSkills = [
    { id: "greeting-skill", name: "Greeting Skill", prompt: selectSkillPrompt("Greeting Skill") },
    { id: "summarization-skill", name: "Summarization Skill", prompt: selectSkillPrompt("Summarization Skill") },
    { id: "code-review-skill", name: "Code Review Skill", prompt: selectSkillPrompt("Code Review Skill") },
];

const previewGuardrails = [
    { id: "content-safety", name: "Content Safety", prompt: selectGuardrailPrompt("Content Safety") },
    { id: "financial-advice-policy", name: "Financial Advice Policy", prompt: selectGuardrailPrompt("Financial Advice Policy") },
];

const workIqVariants = [
    { entityId: "microsoft-copilot-chat-frontier", title: "Work IQ Copilot" },
    { entityId: "microsoft-teams-mcp-frontier", title: "Work IQ Teams" },
    { entityId: "microsoft-word-mcp-frontier", title: "Work IQ Word" },
    { entityId: "microsoft-outlook-calendar-mcp-frontier", title: "Work IQ Calendar" },
    { entityId: "microsoft-outlook-mail-mcp-frontier", title: "Work IQ Mail" },
    { entityId: "microsoft-sharepoint-mcp-frontier", title: "Work IQ SharePoint" },
    { entityId: "microsoft-onedrive-mcp-frontier", title: "Work IQ OneDrive" },
];

const hostedAgentRegions = [
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

const hostedAgentRegionsDoc = "https://learn.microsoft.com/azure/foundry/agents/concepts/hosted-agents#region-availability";
const sentPrompts = [];
const sseClients = new Set();

function valueFor(flag) {
    const index = process.argv.indexOf(flag);
    return index >= 0 ? process.argv[index + 1] : "";
}

function sendJson(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
}

function sendText(res, status, text) {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(text);
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

function publicFile(pathname) {
    const decoded = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
    const rel = decoded.replace(/^\/+/, "");
    const file = normalize(join(PUBLIC_DIR, rel));
    const back = relative(PUBLIC_DIR, file);
    if (!back || back.startsWith("..") || isAbsolute(back) || back.split(sep).includes("..")) return null;
    return file;
}

function serveStatic(req, res) {
    const url = new URL(req.url, `http://${HOST}`);
    if (url.pathname === "/__preview-mock.js") {
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
        res.end(readFileSync(PREVIEW_MOCK_JS));
        return true;
    }
    if (url.pathname === "/__preview-mock.css") {
        res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
        res.end(readFileSync(PREVIEW_MOCK_CSS));
        return true;
    }
    const file = publicFile(url.pathname);
    if (!file || !existsSync(file)) return false;
    const ext = extname(file);
    res.writeHead(200, { "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream" });
    if (ext === ".html" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const html = readFileSync(file, "utf8").replace(
            '<script src="app.js"></script>',
            '<link rel="stylesheet" href="/__preview-mock.css">\n        <script src="/__preview-mock.js"></script>\n        <script src="app.js"></script>',
        );
        res.end(html);
    } else {
        res.end(readFileSync(file));
    }
    return true;
}

function projectInit() {
    const hasAzure = existsSync(join(ROOT, "azure.yaml")) || existsSync(join(ROOT, "azure.yml"));
    const hasAgent = existsSync(join(ROOT, "agent.yaml")) || existsSync(join(ROOT, "agent.yml"));
    return { ok: true, hasAzure, hasAgent, initialized: hasAzure || hasAgent };
}

function selectProject(project) {
    selectedProject = project || projects[0];
    state.project = { name: selectedProject.name, endpoint: selectedProject.endpoint };
    state.projectEndpoint = selectedProject.endpoint;
    state.projectLocation = selectedProject.location || "";
}

function stubNeedsCopilot(res, extra = {}) {
    return sendJson(res, 200, {
        ok: false,
        reason: "preview_mode",
        detail: "Preview mode does not call Copilot, Azure, or Foundry write APIs.",
        ...extra,
    });
}

async function handleApi(req, res, url) {
    const path = url.pathname;
    const method = req.method || "GET";

    if (method === "GET" && path === "/api/state") {
        return sendJson(res, 200, {
            ...state,
            preview: true,
            project: mockProjectState(url),
            deployPrompt: DEPLOY_PROMPT,
        });
    }

    if (method === "GET" && path === "/api/project") {
        if (!mockProjectSelected(url)) {
            return sendJson(res, 200, { ok: true, name: "", endpoint: "", resourceName: "" });
        }
        return sendJson(res, 200, {
            ok: true,
            name: selectedProject.name,
            endpoint: selectedProject.endpoint,
            resourceName: selectedProject.account,
        });
    }

    if (method === "GET" && path === "/api/deployments") {
        const reason = projectScopedUnavailable(url);
        if (reason) return sendJson(res, 200, { ok: false, source: "preview", reason, items: [] });
        return sendJson(res, 200, { ok: true, source: "preview", items: previewDeployments });
    }

    if (method === "GET" && path === "/api/connections") {
        const reason = projectScopedUnavailable(url);
        if (reason) return sendJson(res, 200, { ok: false, source: "preview", reason, items: [] });
        return sendJson(res, 200, { ok: true, source: "preview", items: toolConnections });
    }

    if (method === "GET" && path === "/api/toolboxes") {
        const reason = projectScopedUnavailable(url);
        if (reason) return sendJson(res, 200, { ok: false, reason, items: [] });
        return sendJson(res, 200, { ok: true, items: previewToolboxes });
    }

    if (method === "GET" && path === "/api/skills") {
        const reason = projectScopedUnavailable(url);
        if (reason) return sendJson(res, 200, { ok: false, reason, items: [] });
        return sendJson(res, 200, { ok: true, items: previewSkills });
    }

    if (method === "GET" && path === "/api/guardrails") {
        const reason = projectScopedUnavailable(url);
        if (reason) return sendJson(res, 200, { ok: false, reason, items: [] });
        return sendJson(res, 200, { ok: true, items: previewGuardrails });
    }

    if (method === "GET" && path === "/api/toolbox/tools") {
        const reason = projectScopedUnavailable(url);
        if (reason) return sendJson(res, 200, { ok: false, reason, items: [] });
        const name = url.searchParams.get("name") || "";
        return sendJson(res, 200, { ok: true, items: previewToolboxTools[name] || [] });
    }

    if (method === "POST" && (path === "/api/toolbox/add-tool" || path === "/api/toolbox/create-with-tool")) {
        const reason = projectScopedUnavailable(url);
        if (reason) return sendJson(res, 200, { ok: false, reason });
        return stubNeedsCopilot(res, { reason: "needs_connection" });
    }

    if (method === "GET" && path === "/api/workiq/variants") {
        return sendJson(res, 200, { ok: true, data: workIqVariants });
    }

    if (method === "POST" && (path === "/api/workiq/add-tools" || path === "/api/workiq/create-with-tools")) {
        const reason = projectScopedUnavailable(url);
        if (reason) return sendJson(res, 200, { ok: false, reason });
        return stubNeedsCopilot(res, { reason: "needs_connection" });
    }

    if (method === "GET" && path === "/api/identity") {
        return sendJson(res, 200, { ok: true, ...mockIdentity(url) });
    }

    if (method === "GET" && path === "/api/bootstrap") {
        const id = mockIdentity(url);
        if (!id.signedIn || !mockProjectSelected(url)) {
            return sendJson(res, 200, {
                ok: true,
                identity: id,
                project: null,
                resolved: false,
                subscriptionId: "",
                preview: true,
            });
        }
        return sendJson(res, 200, {
            ok: true,
            identity: id,
            project: { name: selectedProject.name, endpoint: selectedProject.endpoint, rg: selectedProject.rg, account: selectedProject.account },
            resolved: true,
            subscriptionId: id.subscriptionId,
            preview: true,
        });
    }

    if (method === "GET" && path === "/api/subscriptions") {
        if (!mockSignedIn(url)) return sendJson(res, 200, { ok: false, reason: "not_signed_in", items: [] });
        return sendJson(res, 200, { ok: true, items: subscriptions });
    }

    if (method === "GET" && path === "/api/projects") {
        if (!mockSignedIn(url)) return sendJson(res, 200, { ok: false, reason: "not_signed_in", items: [] });
        return sendJson(res, 200, { ok: true, items: projects });
    }

    if (method === "POST" && path === "/api/select-subscription") {
        return sendJson(res, 200, { ok: true });
    }

    if (method === "POST" && path === "/api/select-project") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const match = projects.find((p) => p.endpoint === body.endpoint || p.name === body.name) || projects[0];
        selectProject(match);
        return sendJson(res, 200, { ok: true, name: match.name, endpoint: match.endpoint });
    }

    if (method === "GET" && path === "/api/region-support") {
        if (!mockProjectSelected(url)) {
            return sendJson(res, 200, {
                ok: true,
                docsUrl: hostedAgentRegionsDoc,
                location: "",
                regions: hostedAgentRegions,
                supported: null,
            });
        }
        return sendJson(res, 200, {
            ok: true,
            docsUrl: hostedAgentRegionsDoc,
            location: selectedProject.location,
            regions: hostedAgentRegions,
            supported: true,
        });
    }

    if (method === "POST" && path === "/api/signin") {
        return sendJson(res, 200, {
            ok: true,
            sessionId: "preview-signin",
            mode: mockAzureCli(url) ? "preview" : "preview-no-az",
        });
    }

    if (method === "GET" && path === "/api/signin/status") {
        return sendJson(res, 200, { ok: true, status: "done", identity });
    }

    if (method === "POST" && path === "/api/signin/cancel") {
        return sendJson(res, 200, { ok: true });
    }

    if (method === "POST" && path === "/api/signout") {
        return sendJson(res, 200, { ok: true });
    }

    if (method === "POST" && path === "/api/send") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
        if (!prompt) return sendJson(res, 400, { ok: false, error: "Missing prompt" });
        sentPrompts.push({ prompt, at: new Date().toISOString() });
        console.log("\n[preview] prompt-to-chat stub\n" + prompt + "\n");
        return sendJson(res, 200, { ok: true, preview: true });
    }

    if (method === "GET" && path === "/api/protocol-ref") {
        return sendJson(res, 200, { path: PROTOCOL_REF });
    }

    if (method === "GET" && path === "/api/project-init") {
        return sendJson(res, 200, {
            ...projectInit(),
            azureCliAvailable: mockAzureCli(url),
            azdAvailable: mockAzd(url),
        });
    }

    if (method === "GET" && path === "/api/skills/status") {
        const scenario = url.searchParams.get("skillStatus") || "missing";
        const scenarios = {
            missing: {
                ok: true,
                status: "missing",
                installed: false,
                installedVersion: "",
                latestVersion: "",
                summary: "Foundry Skills are not installed yet.",
            },
            outdated: {
                ok: true,
                status: "outdated",
                installed: true,
                installedVersion: "1.1.29",
                latestVersion: "1.1.30",
                summary: "A newer version of Foundry Skills is available.",
            },
            latest: {
                ok: true,
                status: "latest",
                installed: true,
                installedVersion: "1.1.30",
                latestVersion: "1.1.30",
                summary: "The latest Foundry Skills are already installed (version 1.1.30).",
            },
            unknown: {
                ok: false,
                status: "unknown",
                installed: true,
                installedVersion: "1.1.30",
                latestVersion: "",
                summary: "Unable to access GitHub to verify whether Foundry Skills are up to date.",
            },
        };
        return sendJson(res, 200, scenarios[scenario] || scenarios.missing);
    }

    if (method === "POST" && path === "/api/skills/install") {
        return sendJson(res, 200, { ok: true, code: 0, summary: "Preview mode: command skipped" });
    }

    if (method === "GET" && path === "/api/inspect/ready") {
        return sendJson(res, 200, { ready: false });
    }

    if (method === "GET" && path === "/api/inspect/start") {
        if (!mockAzd(url)) {
            return sendJson(res, 200, {
                ok: false,
                error: "Azure Developer CLI (azd) is not available. Install azd, then try Inspect locally again.",
            });
        }
        return sendJson(res, 200, {
            ok: false,
            error: "Preview mode does not start the Agent Inspector. Open the canvas in Copilot for this flow.",
        });
    }

    return sendText(res, 404, "Not found");
}

async function handle(req, res) {
    const url = new URL(req.url, `http://${HOST}`);
    const method = req.method || "GET";

    if (method === "GET" && url.pathname === "/events") {
        res.writeHead(200, {
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Content-Type": "text/event-stream",
        });
        res.write(":ok\n\n");
        sseClients.add(res);
        let heartbeat = null;
        if (SSE_HEARTBEAT_MS > 0) {
            heartbeat = setInterval(() => {
                try {
                    res.write(`: hb ${Date.now()}\n\n`);
                } catch {
                    /* connection went away between ticks */
                }
            }, SSE_HEARTBEAT_MS);
            heartbeat.unref?.();
        }
        req.on("close", () => {
            if (heartbeat) clearInterval(heartbeat);
            sseClients.delete(res);
        });
        return;
    }

    if (url.pathname.startsWith("/api/")) {
        try {
            await handleApi(req, res, url);
        } catch (err) {
            sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
        }
        return;
    }

    if (method === "GET" && serveStatic(req, res)) return;
    sendText(res, 404, "Not found");
}

const server = createServer(handle);
server.listen(PORT, HOST, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : PORT;
    console.log(`Foundry Agent Canvas preview: http://${HOST}:${port}/`);
    console.log("Preview mode stubs Copilot chat, Azure sign-in, Foundry writes, and Agent Inspector startup.");
    if (SSE_HEARTBEAT_MS === 0) {
        console.log("[preview] SSE heartbeat DISABLED (--sse-heartbeat 0) — idle /events may be dropped.");
    }
    if (KILL_AFTER_MS > 0) {
        console.log(`[preview] REPRO: tearing down the server in ${KILL_AFTER_MS}ms to simulate the canvas backend going away.`);
        console.log("[preview]        Expect the iframe to show 'Canvas disconnected — reload'; Reload then hits 'can't reach this page'.");
        const kill = setTimeout(() => {
            console.log("[preview] REPRO: dropping SSE clients and closing the server now. The iframe's port is now dead.");
            for (const client of sseClients) {
                try {
                    client.end();
                } catch {
                    /* ignore */
                }
            }
            sseClients.clear();
            // Stop accepting connections so reloads/fetches get ECONNREFUSED,
            // matching a torn-down loopback canvas server.
            server.close();
        }, KILL_AFTER_MS);
        kill.unref?.();
    }
});

function shutdown() {
    for (const client of sseClients) client.end();
    server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
