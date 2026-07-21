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
import { ApiError, createApiRouter } from "../src/api-router.mjs";
import { initialBuildSections } from "../src/build-sections.mjs";
import { inspectHostedAgentWorkspace } from "../src/local-agent.mjs";
import {
    emptySelection,
    normalizeSelection,
    selectProject as transitionProject,
    selectSubscription as transitionSubscription,
} from "../public/selection-state.js";

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

const DEFAULT_SUBSCRIPTION_ID = "00000000-0000-0000-0000-000000000001";
const ALT_SUBSCRIPTION_ID = "00000000-0000-0000-0000-000000000002";

const identity = {
    signedIn: true,
    account: "preview@local",
    tenantId: "preview-tenant",
};

const subscriptions = [
    { id: DEFAULT_SUBSCRIPTION_ID, name: "Preview Subscription", isDefault: true },
    { id: ALT_SUBSCRIPTION_ID, name: "Preview Subscription Alt", isDefault: false },
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
        subscriptionId: DEFAULT_SUBSCRIPTION_ID,
    },
    {
        account: "preview-alt-foundry",
        endpoint: "https://preview-alt.services.ai.azure.com/api/projects/preview-alt-project",
        id: "/subscriptions/preview-alt/resourceGroups/preview/providers/Microsoft.CognitiveServices/accounts/preview-alt/projects/preview-alt-project",
        location: "westus",
        name: "Preview Alt Project",
        project: "Preview Alt Project",
        rg: "preview-alt-rg",
        subscriptionId: ALT_SUBSCRIPTION_ID,
    },
];

function initialSelection() {
    const subscription = subscriptions[0];
    return transitionProject(
        transitionSubscription(emptySelection(), subscription),
        projects[0],
        subscription,
    );
}

const state = {
    agentName: "Preview Agent",
    selection: initialSelection(),
    model: { name: "gpt-5", color: "#10a37f" },
};
let sessionSignedIn = true;

function restoreInitialSelection() {
    if (!state.selection.subscription.id) state.selection = initialSelection();
}

function mockBool(url, key, fallback = true) {
    const raw = url.searchParams.get(key);
    if (raw == null) return fallback;
    return raw !== "false";
}

function mockSignedIn(url) {
    return sessionSignedIn && mockBool(url, "signedIn", true);
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

function mockIdentity(url) {
    if (!mockSignedIn(url)) {
        return {
            signedIn: false,
            account: "",
            tenantId: "",
        };
    }
    return identity;
}

function mockSelection(url) {
    if (!mockSignedIn(url)) return emptySelection();
    const selection = state.selection.subscription.id
        ? normalizeSelection(state.selection)
        : initialSelection();
    return mockProjectSelected(url) ? selection : transitionProject(selection, null);
}

function projectScopedUnavailable(url) {
    if (!mockSignedIn(url)) return "not_signed_in";
    if (!mockSelection(url).project) return "no_project";
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

function sendText(res, status, text) {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(text);
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
            '<script type="module" src="app.js"></script>',
            '<link rel="stylesheet" href="/__preview-mock.css">\n        <script src="/__preview-mock.js"></script>\n        <script type="module" src="app.js"></script>',
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

async function mockHostedAgentDeployment(url) {
    const reason = projectScopedUnavailable(url);
    const agentName = await mockResolvedAgentName(url);
    const selection = mockSelection(url);
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
    const project = selection.project;
    const encodedSubscription = Buffer.from(selection.subscription.id.replace(/-/g, ""), "hex").toString("base64url");
    return {
        ok: true,
        deployed: true,
        available,
        portalUrl: available
            ? `https://ai.azure.com/nextgen/r/${encodedSubscription},${encodeURIComponent(project.resourceGroup)},,${encodeURIComponent(project.accountName)},${encodeURIComponent(project.name)}/build/agents/${encodeURIComponent(agentName)}/build?version=3`
            : "",
        agentName,
        version: "3",
        reason: "",
    };
}

function createPreviewApiServices() {
    const resourceResult = (url, items, extra = {}) => {
        const reason = projectScopedUnavailable(url);
        return reason
            ? { ok: false, reason, items: [], ...extra }
            : { ok: true, items, ...extra };
    };

    return {
        getState({ url }) {
            return {
                ...state,
                agentName: mockAgentInput(url) ? state.agentName : "",
                preview: true,
                selection: mockSelection(url),
                deployPrompt: DEPLOY_PROMPT,
            };
        },
        getHostedAgentDeployment({ url }) {
            return mockHostedAgentDeployment(url);
        },
        async getHostedAgentPlayground({ url }) {
            const result = await mockHostedAgentDeployment(url);
            return result.available
                ? {
                    ...result,
                    portalUrl: `/__preview-playground?agent=${encodeURIComponent(result.agentName)}&version=${encodeURIComponent(result.version)}`,
                }
                : result;
        },
        listDeployments({ url }) {
            return resourceResult(url, previewDeployments, { source: "preview" });
        },
        listToolboxes({ url }) {
            return resourceResult(url, previewToolboxes);
        },
        listSkills({ url }) {
            return resourceResult(url, previewSkills);
        },
        listGuardrails({ url }) {
            return resourceResult(url, previewGuardrails);
        },
        listToolboxTools({ url }) {
            return resourceResult(
                url,
                previewToolboxTools[url.searchParams.get("name") || ""] || [],
            );
        },
        getIdentity({ url }) {
            return { ok: true, ...mockIdentity(url) };
        },
        bootstrap({ url }) {
            const previewIdentity = mockIdentity(url);
            if (previewIdentity.signedIn) restoreInitialSelection();
            const selection = mockSelection(url);
            return {
                ok: true,
                identity: previewIdentity,
                selection,
                resolved: !!selection.project,
                preview: true,
            };
        },
        listSubscriptions({ url }) {
            return mockSignedIn(url)
                ? { ok: true, items: subscriptions }
                : { ok: false, reason: "not_signed_in", items: [] };
        },
        listProjects({ url }) {
            if (!mockSignedIn(url)) {
                return { ok: false, reason: "not_signed_in", items: [] };
            }
            const subscriptionId = url.searchParams.get("sub")
                || state.selection.subscription.id;
            return {
                ok: true,
                items: projects.filter((project) =>
                    !subscriptionId || project.subscriptionId === subscriptionId),
            };
        },
        selectSubscription({ body }) {
            const subscription = subscriptions.find((item) =>
                item.id === body.subscriptionId);
            if (!subscription) throw new ApiError(404, "Subscription not found");
            state.selection = transitionSubscription(state.selection, subscription);
            return { ok: true, selection: state.selection };
        },
        selectProject({ body }) {
            const subscription = state.selection.subscription;
            const project = projects.find((item) =>
                item.subscriptionId === subscription.id
                && (item.endpoint === body.endpoint || item.name === body.name));
            if (!project) throw new ApiError(404, "Project not found");
            state.selection = transitionProject(state.selection, project, subscription);
            return { ok: true, selection: state.selection };
        },
        getRegionSupport({ url }) {
            const project = mockSelection(url).project;
            return {
                ok: true,
                docsUrl: hostedAgentRegionsDoc,
                location: project?.location || "",
                regions: hostedAgentRegions,
                supported: project ? true : null,
            };
        },
        signIn({ url }) {
            return {
                ok: true,
                sessionId: "preview-signin",
                mode: mockAzureCli(url) ? "preview" : "preview-no-az",
            };
        },
        getSignInStatus() {
            sessionSignedIn = true;
            restoreInitialSelection();
            return { ok: true, status: "done", identity };
        },
        cancelSignIn() {
            return { ok: true };
        },
        signOut() {
            sessionSignedIn = false;
            state.selection = emptySelection();
            return { ok: true };
        },
        sendPrompt({ body }) {
            sentPrompts.push({ prompt: body.prompt, at: new Date().toISOString() });
            console.log("\n[preview] prompt-to-chat stub\n" + body.prompt + "\n");
            return { preview: true };
        },
        async getProjectInit({ url }) {
            return {
                ...(await projectInit(url)),
                azureCliAvailable: mockAzureCli(url),
                azdAvailable: mockAzd(url),
            };
        },
        getInspectorReady() {
            return { ready: false };
        },
        startInspector({ url }) {
            return {
                ok: false,
                error: !mockAzd(url)
                    ? "Azure Developer CLI (azd) is not available. Install azd, then try Inspect locally again."
                    : "Preview mode does not start the Agent Inspector. Open the canvas in Copilot for this flow.",
            };
        },
    };
}

const handleApi = createApiRouter({
    services: createPreviewApiServices(),
    reportError: (error, request) => {
        console.error(`[preview] ${request.method} ${request.path} failed: ${error?.message ?? error}`);
    },
});

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
        await handleApi(req, res, url);
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
