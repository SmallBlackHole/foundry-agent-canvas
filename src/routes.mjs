import { existsSync } from "node:fs";
import { join } from "node:path";

import { createApiRouter } from "./api-router.mjs";
import { deployments, DEPLOY_PROMPT } from "./catalog.mjs";
import {
    clearFoundryCache,
    HOSTED_AGENT_REGIONS,
    HOSTED_AGENT_REGIONS_DOC,
    isHostedAgentRegionSupported,
    listDeployments,
    listGuardrails,
    listProjects,
    listSkills,
    listSubscriptions,
    listToolboxes,
    listToolboxTools,
} from "./foundry.mjs";
import {
    getIdentity,
    getToken,
    signInCancel,
    signInStart,
    signInStatus,
    signOut,
} from "./foundry-auth.mjs";
import {
    bootstrapInstance,
    clearSelection,
    defaultState,
    enrichProjectLocation,
    saveSelection,
    servers,
} from "./state.mjs";
import {
    emptySelection,
    selectProject,
    selectSubscription,
} from "../public/selection-state.js";
import { enrichDeployment, enrichGuardrail, enrichSkill, enrichToolbox } from "./mappers.mjs";
import { serveFile, serveStatic, SSE_HEARTBEAT_MS } from "./server-utils.mjs";
import { ensureInspectorProxy, isAgentReachable } from "./inspector.mjs";
import { launchAgentTerminal } from "./agent-terminal.mjs";
import { initialBuildSections } from "./build-sections.mjs";
import {
    inspectHostedAgentWorkspace,
    resolveHostedAgentName,
    resolveHostedAgentProject,
} from "./local-agent.mjs";
import { resolveHostedAgentPortalAction } from "./hosted-agent.mjs";
import { flushPendingWorkspaceState } from "./workspace-state.mjs";

export async function selectedHostedAgentPortalAction(entry, workspaceRootFn) {
    const selection = entry?.state.selection ?? emptySelection();
    const project = selection.project;
    const agent = await resolveHostedAgentName(
        await workspaceRootFn(),
        entry ? entry.state.agentName : "",
    );
    if (agent.ambiguous) {
        return {
            ok: false,
            deployed: false,
            available: false,
            portalUrl: "",
            agentName: "",
            version: "",
            reason: "ambiguous_agent",
        };
    }
    return resolveHostedAgentPortalAction(
        {
            endpoint: project?.endpoint || "",
            agentName: agent.agentName,
            subscriptionId: selection.subscription.id,
            resourceGroup: project?.resourceGroup || "",
            accountName: project?.accountName || "",
            projectName: project?.name || "",
        },
        { getToken },
    );
}

function liveItems(result, mapItem) {
    if (result.ok) return { ok: true, items: result.data.map(mapItem) };
    return { ok: false, reason: result.reason, items: [] };
}

export function createRuntimeApiServices(instanceId, {
    session,
    inspectorUiDir,
    workspaceRootFn,
    waitForFoundrySkill,
    markPendingRefresh,
    auth = {
        getIdentity,
        signInStart,
        signInStatus,
        signInCancel,
        signOut,
    },
    clearResourceCache = clearFoundryCache,
    clearSavedSelection = clearSelection,
    localInspector = {
        ensureProxy: ensureInspectorProxy,
        launchTerminal: launchAgentTerminal,
        resolveProject: resolveHostedAgentProject,
    },
}) {
    const getEntry = () => servers.get(instanceId);
    const getSelection = () => getEntry()?.state.selection ?? emptySelection();
    const getEndpoint = () => getSelection().project?.endpoint || "";
    const reportedRegionWarnings = new Set();

    async function reportUnsupportedRegion(selection, location) {
        const project = selection.project;
        const key = `${project?.endpoint || project?.name || ""}|${location}`;
        if (!key || reportedRegionWarnings.has(key)) return;

        reportedRegionWarnings.add(key);
        const region = location ? ` (${location})` : "";
        try {
            await session.log(
                `Hosted agents aren't available in this project's region${region}. `
                    + "Select a project in a supported region before deploying.",
                { level: "warning" },
            );
        } catch {
            reportedRegionWarnings.delete(key);
        }
    }

    return {
        async getState() {
            return { ...(getEntry()?.state ?? defaultState()), deployPrompt: DEPLOY_PROMPT };
        },
        getHostedAgentDeployment() {
            return selectedHostedAgentPortalAction(getEntry(), workspaceRootFn);
        },
        async getHostedAgentPlayground() {
            const result = await selectedHostedAgentPortalAction(getEntry(), workspaceRootFn);
            return result.available && result.portalUrl.startsWith("https://ai.azure.com/")
                ? result
                : { ...result, available: false, portalUrl: "" };
        },
        async listDeployments({ url }) {
            const result = await listDeployments(getEndpoint(), {
                force: url.searchParams.get("refresh") === "1",
            });
            if (result.ok) {
                return {
                    ok: true,
                    source: "live",
                    items: result.data.map(enrichDeployment),
                };
            }
            return {
                ok: true,
                source: "mock",
                reason: result.reason,
                items: deployments,
            };
        },
        async listToolboxes({ url }) {
            return liveItems(
                await listToolboxes(getEndpoint(), {
                    force: url.searchParams.get("refresh") === "1",
                }),
                enrichToolbox,
            );
        },
        async listSkills({ url }) {
            return liveItems(
                await listSkills(getEndpoint(), {
                    force: url.searchParams.get("refresh") === "1",
                }),
                enrichSkill,
            );
        },
        async listGuardrails({ url }) {
            return liveItems(
                await listGuardrails(getEndpoint(), getSelection().subscription.id, {
                    force: url.searchParams.get("refresh") === "1",
                }),
                enrichGuardrail,
            );
        },
        async listToolboxTools({ url }) {
            const result = await listToolboxTools(
                getEndpoint(),
                url.searchParams.get("name") || "",
                url.searchParams.get("version") || "",
            );
            return result.ok
                ? { ok: true, items: result.data }
                : { ok: false, reason: result.reason, items: [] };
        },
        async getIdentity() {
            return { ok: true, ...(await auth.getIdentity()) };
        },
        async bootstrap() {
            const entry = getEntry();
            if (!entry) return { ok: false, reason: "no_instance" };
            try {
                return { ok: true, ...(await bootstrapInstance(entry)) };
            } catch (error) {
                await session.log(`bootstrap failed: ${error?.message ?? error}`, { level: "error" });
                return { ok: false, reason: "bootstrap_failed" };
            }
        },
        async listSubscriptions() {
            const result = await listSubscriptions();
            return result.ok
                ? { ok: true, items: result.data }
                : { ok: false, reason: result.reason, items: [] };
        },
        async listProjects({ url }) {
            const subscriptionId = url.searchParams.get("sub")
                || getSelection().subscription.id;
            const result = await listProjects(subscriptionId);
            return result.ok
                ? { ok: true, items: result.data }
                : { ok: false, reason: result.reason, items: [] };
        },
        async selectSubscription({ body }) {
            const selection = selectSubscription(getSelection(), {
                id: body.subscriptionId,
                name: typeof body.subscriptionName === "string" ? body.subscriptionName : "",
            });
            const entry = getEntry();
            if (entry) entry.state.selection = selection;
            saveSelection(selection);
            return { ok: true, selection };
        },
        async selectProject({ body }) {
            const current = getSelection();
            const subscription = {
                id: typeof body.subscriptionId === "string"
                    ? body.subscriptionId.trim()
                    : current.subscription.id,
                name: typeof body.subscriptionName === "string"
                    ? body.subscriptionName.trim()
                    : current.subscription.name,
            };
            const selection = selectProject(current, {
                subscriptionId: subscription.id,
                name: typeof body.name === "string" ? body.name : "",
                endpoint: body.endpoint,
                location: typeof body.location === "string" ? body.location : "",
                resourceGroup: typeof body.resourceGroup === "string" ? body.resourceGroup : "",
                accountName: typeof body.accountName === "string" ? body.accountName : "",
            }, subscription);
            const entry = getEntry();
            if (entry) entry.state.selection = selection;
            saveSelection(selection);
            return { ok: true, selection };
        },
        async getRegionSupport() {
            const entry = getEntry();
            const selection = getSelection();
            if (!selection.project?.endpoint) {
                return {
                    ok: true,
                    location: "",
                    supported: null,
                    regions: HOSTED_AGENT_REGIONS,
                    docsUrl: HOSTED_AGENT_REGIONS_DOC,
                };
            }
            let location = selection.project.location;
            if (!location) {
                try {
                    location = await enrichProjectLocation(entry);
                } catch {
                    location = "";
                }
            }
            const supported = isHostedAgentRegionSupported(location);
            if (supported === false) {
                await reportUnsupportedRegion(selection, location);
            }
            return {
                ok: true,
                location,
                supported,
                regions: HOSTED_AGENT_REGIONS,
                docsUrl: HOSTED_AGENT_REGIONS_DOC,
            };
        },
        signIn() {
            return auth.signInStart();
        },
        async getSignInStatus({ url }) {
            const result = await auth.signInStatus(url.searchParams.get("sessionId") || "");
            if (result.ok && result.status === "done") clearResourceCache();
            return result;
        },
        cancelSignIn({ body }) {
            return auth.signInCancel(typeof body.sessionId === "string" ? body.sessionId : "");
        },
        async signOut() {
            const result = await auth.signOut();
            if (result.ok) {
                clearResourceCache();
                clearSavedSelection();
                for (const entry of servers.values()) {
                    if (entry?.state) entry.state.selection = emptySelection();
                }
            }
            return result;
        },
        async sendPrompt({ body }) {
            if (typeof body.refresh === "string" && body.refresh) {
                markPendingRefresh?.(body.refresh);
            }
            await waitForFoundrySkill?.();
            await session.send({ prompt: body.prompt });
            return {};
        },
        async getProjectInit() {
            const root = await workspaceRootFn();
            const { hasAzure, hasAgent } = await inspectHostedAgentWorkspace(root);
            return {
                ok: true,
                hasAzure,
                hasAgent,
                initialized: hasAzure || hasAgent,
                sections: initialBuildSections({ hasAgent }),
            };
        },
        async getInspectorReady() {
            return { ready: await isAgentReachable() };
        },
        async startInspector() {
            const project = await localInspector.resolveProject(await workspaceRootFn());
            const proxyUrl = await localInspector.ensureProxy(inspectorUiDir);
            if (!proxyUrl) {
                return {
                    ok: false,
                    error: "Inspector failed to start. Check the extension logs for details.",
                };
            }
            const terminal = await localInspector.launchTerminal(session, project);
            if (!terminal?.ok) {
                return {
                    ok: false,
                    error: terminal?.error || "Could not start the agent in the integrated terminal.",
                    terminal,
                };
            }
            return { ok: true, url: proxyUrl, terminal };
        },
    };
}

function openEventStream(req, res, entry) {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });
    res.write(":ok\n\n");
    if (!entry) return;

    entry.sseClients.add(res);
    flushPendingWorkspaceState(entry, res);
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
        entry.sseClients.delete(res);
    });
}

export function createRequestHandler(
    instanceId,
    {
        session,
        publicDir,
        extDir,
        inspectorUiDir,
        workspaceRootFn,
        onCanvasOpen,
        waitForFoundrySkill,
        markPendingRefresh,
    },
) {
    const handleApi = createApiRouter({
        services: createRuntimeApiServices(instanceId, {
            session,
            inspectorUiDir,
            workspaceRootFn,
            waitForFoundrySkill,
            markPendingRefresh,
        }),
        reportError: (error, request) => session.log(
            `${request.method} ${request.path} failed: ${error?.message ?? error}`,
            { level: "error" },
        ),
    });

    return async (req, res) => {
        const entry = servers.get(instanceId);
        const url = new URL(req.url, "http://127.0.0.1");
        const path = url.pathname;
        const method = req.method || "GET";

        if (method === "GET" && (path === "/" || path === "/index.html")) {
            onCanvasOpen?.();
            return serveStatic(res, "index.html", publicDir);
        }
        if (method === "GET" && path === "/app.css") return serveStatic(res, "app.css", publicDir);
        if (method === "GET" && path === "/app.js") return serveStatic(res, "app.js", publicDir);
        if (method === "GET" && path === "/selection-state.js") {
            return serveStatic(res, "selection-state.js", publicDir);
        }
        if (method === "GET" && path === "/codicons/codicon.ttf") {
            return serveStatic(res, join("codicons", "codicon.ttf"), publicDir);
        }
        if (method === "GET" && path.startsWith("/tool-icons/")) {
            const name = path.slice("/tool-icons/".length);
            if (/^[a-z0-9-]+\.svg$/.test(name)) {
                return serveStatic(res, join("tool-icons", name), publicDir);
            }
        }
        if (method === "GET" && path.startsWith("/fluent-icons/")) {
            const name = path.slice("/fluent-icons/".length);
            if (/^[a-z0-9_]+_(12|16|20)_regular\.svg$/.test(name)) {
                const packaged = join(publicDir, "fluent-icons", name);
                if (existsSync(packaged)) return serveFile(res, packaged);
                const installed = join(extDir, "node_modules", "@fluentui", "svg-icons", "icons", name);
                if (existsSync(installed)) return serveFile(res, installed);
            }
        }
        if (method === "GET" && path === "/events") {
            openEventStream(req, res, entry);
            return;
        }
        if (path.startsWith("/api/")) {
            await handleApi(req, res, url);
            return;
        }

        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
    };
}
