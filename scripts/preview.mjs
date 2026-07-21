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
} from "../src/catalog.mjs";
import { initialBuildSections } from "../src/build-sections.mjs";
import { inspectHostedAgentWorkspace } from "../src/local-agent.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = join(ROOT, "public");
const FLUENT_ICONS_DIR = join(ROOT, "node_modules", "@fluentui", "svg-icons", "icons");
const PREVIEW_MOCK_JS = join(ROOT, "scripts", "preview-mock.js");
const PREVIEW_MOCK_CSS = join(ROOT, "scripts", "preview-mock.css");

const HOST = valueFor("--host") || process.env.HOST || "127.0.0.1";
const PORT = Number(valueFor("--port") || process.env.PORT || 0);
// Repro/verify knobs:
//   --kill-after <ms> / PREVIEW_KILL_AFTER_MS
//       After N ms, drop every SSE client and stop the server from listening.
//       Simulates the backing loopback server's port going away (in the real
//       extension this now only happens on a process restart / extensions_reload,
//       since the eager teardown was removed). The still-open iframe remains on
//       its recoverable page and shows an in-place reconnecting state.
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

const subscriptions = [
    { id: identity.subscriptionId, name: identity.subscriptionName, isDefault: true },
    { id: "preview-subscription-alt", name: "Preview Subscription Alt", isDefault: false },
];

const projects = [
    {
        account: "preview-foundry",
        endpoint: "https://preview.services.ai.azure.com/api/projects/preview-project",
        id: "/subscriptions/preview/resourceGroups/preview/providers/Microsoft.CognitiveServices/accounts/preview/projects/preview-project",
        location: "eastus2",
        name: "Preview Project",
        project: "Preview Project",
        rg: "preview-rg",
        subscriptionId: identity.subscriptionId,
    },
    {
        account: "preview-alt-foundry",
        endpoint: "https://preview-alt.services.ai.azure.com/api/projects/preview-alt-project",
        id: "/subscriptions/preview-alt/resourceGroups/preview/providers/Microsoft.CognitiveServices/accounts/preview-alt/projects/preview-alt-project",
        location: "westus",
        name: "Preview Alt Project",
        project: "Preview Alt Project",
        rg: "preview-alt-rg",
        subscriptionId: "preview-subscription-alt",
    },
];

let selectedProject = projects[0];
let selectedSubscriptionId = identity.subscriptionId;

const state = {
    agentName: "Preview Agent",
    project: { name: selectedProject.name, endpoint: selectedProject.endpoint, rg: selectedProject.rg, account: selectedProject.account },
    projectEndpoint: selectedProject.endpoint,
    projectLocation: selectedProject.location,
    subscriptionId: selectedSubscriptionId,
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

function mockAgentDeployed(url) {
    return mockBool(url, "deployed", true);
}

function mockAgentMetadata(url) {
    return mockBool(url, "agentMetadata", true);
}

function mockAgentError(url) {
    return mockBool(url, "agentError", false);
}

function mockAgentInput(url) {
    return mockBool(url, "agentInput", true);
}

async function mockResolvedAgentName(url) {
    if (mockAgentInput(url)) return state.agentName;
    return (await projectInit(url)).hasAgent ? "Preview Agent" : "";
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
    const sub = subscriptions.find((s) => s.id === selectedSubscriptionId) || subscriptions[0];
    return { ...identity, subscriptionId: sub.id, subscriptionName: sub.name };
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
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
    });
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
    if (url.pathname.startsWith("/fluent-icons/")) {
        const name = url.pathname.slice("/fluent-icons/".length);
        if (/^[a-z0-9_]+_(12|16|20)_regular\.svg$/.test(name)) {
            const file = join(FLUENT_ICONS_DIR, name);
            if (existsSync(file)) {
                res.writeHead(200, { "Content-Type": "image/svg+xml" });
                res.end(readFileSync(file));
                return true;
            }
        }
        return false;
    }
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

async function projectInit(url) {
    const detected = await inspectHostedAgentWorkspace(ROOT);
    const agentParam = url?.searchParams.get("agent");
    const hasAgent = agentParam == null
        ? detected.hasAgent
        : agentParam !== "false";
    return {
        ok: true,
        hasAzure: detected.hasAzure,
        hasAgent,
        initialized: detected.hasAzure || hasAgent,
        sections: initialBuildSections({ hasAgent }),
    };
}

function selectProject(project) {
    selectedProject = project || projects[0];
    selectedSubscriptionId = selectedProject.subscriptionId || selectedSubscriptionId;
    state.subscriptionId = selectedSubscriptionId;
    state.project = { name: selectedProject.name, endpoint: selectedProject.endpoint };
    state.projectEndpoint = selectedProject.endpoint;
    state.projectLocation = selectedProject.location || "";
}

async function mockHostedAgentDeployment(url) {
    const reason = projectScopedUnavailable(url);
    const agentName = await mockResolvedAgentName(url);
    if (reason || !agentName) {
        return {
            ok: false,
            deployed: false,
            available: false,
            portalUrl: "",
            reason: reason || "no_agent",
        };
    }
    if (mockAgentError(url)) {
        return {
            ok: false,
            deployed: false,
            available: false,
            portalUrl: "",
            reason: "fetch_failed",
        };
    }
    if (!mockAgentDeployed(url)) {
        return {
            ok: true,
            deployed: false,
            available: false,
            portalUrl: "",
            agentName,
            version: "",
            reason: "not_found",
        };
    }
    const available = mockAgentMetadata(url);
    return {
        ok: true,
        deployed: true,
        available,
        portalUrl: available
            ? "https://ai.azure.com/nextgen/r/AAAAAAAAAAAAAAAAAAAAAA,preview-rg,,preview-foundry,preview-project/build/agents/Preview%20Agent/build?version=3"
            : "",
        agentName,
        version: "3",
        reason: "",
    };
}

async function handleApi(req, res, url) {
    const path = url.pathname;
    const method = req.method || "GET";

    if (method === "GET" && path === "/api/state") {
        return sendJson(res, 200, {
            ...state,
            agentName: mockAgentInput(url) ? state.agentName : "",
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

    if (method === "GET" && path === "/api/hosted-agent-deployment") {
        return sendJson(res, 200, await mockHostedAgentDeployment(url));
    }

    if (method === "GET" && path === "/api/hosted-agent-playground") {
        const result = await mockHostedAgentDeployment(url);
        if (!result.available) {
            return sendText(res, 404, "This hosted agent deployment is no longer available.");
        }
        res.writeHead(302, {
            "Cache-Control": "no-store",
            Location: `/__preview-playground?agent=${encodeURIComponent(result.agentName)}&version=${encodeURIComponent(result.version)}`,
        });
        res.end();
        return;
    }

    if (method === "GET" && path === "/api/deployments") {
        const reason = projectScopedUnavailable(url);
        if (reason) return sendJson(res, 200, { ok: false, source: "preview", reason, items: [] });
        return sendJson(res, 200, { ok: true, source: "preview", items: previewDeployments });
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
        const sub = url.searchParams.get("sub") || selectedSubscriptionId;
        return sendJson(res, 200, { ok: true, items: projects.filter((p) => !sub || p.subscriptionId === sub) });
    }

    if (method === "POST" && path === "/api/select-subscription") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const next = subscriptions.find((s) => s.id === body.subscriptionId) || subscriptions[0];
        selectedSubscriptionId = next.id;
        state.subscriptionId = next.id;
        const firstProject = projects.find((p) => p.subscriptionId === next.id) || null;
        selectedProject = firstProject || projects[0];
        state.project = firstProject
            ? { name: firstProject.name, endpoint: firstProject.endpoint, rg: firstProject.rg, account: firstProject.account }
            : emptyProject();
        state.projectEndpoint = firstProject?.endpoint || "";
        state.projectLocation = firstProject?.location || "";
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

    if (method === "GET" && path === "/api/project-init") {
        return sendJson(res, 200, {
            ...(await projectInit(url)),
            azureCliAvailable: mockAzureCli(url),
            azdAvailable: mockAzd(url),
        });
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

    if (method === "GET" && url.pathname === "/__preview-playground") {
        return sendText(
            res,
            200,
            `Preview Playground: ${url.searchParams.get("agent") || "agent"} version ${url.searchParams.get("version") || ""}`,
        );
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
        console.log("[preview]        Expect an in-place 'Reconnecting to canvas…' state with no dead-port reload.");
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
