import { existsSync } from "node:fs";
import { join } from "node:path";

import { deployments, DEPLOY_PROMPT } from "./catalog.mjs";
import {
    listDeployments,
    listToolboxes,
    listToolboxTools,
    listGuardrails,
    listSkills,
    getToken,
    resolveProjectLocation,
    isHostedAgentRegionSupported,
    HOSTED_AGENT_REGIONS,
    HOSTED_AGENT_REGIONS_DOC,
} from "./foundry.mjs";
import {
    getIdentity,
    listSubscriptions,
    listProjects,
    signInStart,
    signInStatus,
    signInCancel,
    signOut,
} from "./foundry.mjs";
import { saveSelection, clearSelection, servers, defaultState, bootstrapInstance } from "./state.mjs";
import {
    emptySelection,
    selectProject,
    selectSubscription,
} from "../public/selection-state.js";
import { enrichDeployment, enrichToolbox, enrichGuardrail, enrichSkill } from "./mappers.mjs";
import { sendJson, serveStatic, serveFile, readBody, SSE_HEARTBEAT_MS } from "./server-utils.mjs";
import { ensureInspectorProxy, isAgentReachable } from "./inspector.mjs";
import { launchAgentTerminal } from "./agent-terminal.mjs";
import { initialBuildSections } from "./build-sections.mjs";
import { inspectHostedAgentWorkspace, resolveHostedAgentName } from "./local-agent.mjs";
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

export function createRequestHandler(
    instanceId,
    { session, publicDir, extDir, inspectorUiDir, workspaceRootFn, onCanvasOpen, waitForFoundrySkill, markPendingRefresh }
) {
    return async (req, res) => {
        const entry = servers.get(instanceId);
        const url = new URL(req.url, "http://127.0.0.1");
        const path = url.pathname;
        const method = req.method || "GET";
        const forceRefresh = url.searchParams.get("refresh") === "1";

        // Static assets.
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

        // Tool icons (path-traversal-safe: name must be a bare slug).
        if (method === "GET" && path.startsWith("/tool-icons/")) {
            const name = path.slice("/tool-icons/".length);
            if (/^[a-z0-9-]+\.svg$/.test(name)) return serveStatic(res, join("tool-icons", name), publicDir);
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Not found");
            return;
        }

        // Fluent UI SVG icons are sourced from @fluentui/svg-icons. Packaged
        // builds copy the used subset into public/fluent-icons; source checkouts
        // can serve them directly from node_modules after npm install.
        if (method === "GET" && path.startsWith("/fluent-icons/")) {
            const name = path.slice("/fluent-icons/".length);
            if (/^[a-z0-9_]+_(12|16|20)_regular\.svg$/.test(name)) {
                const packaged = join(publicDir, "fluent-icons", name);
                if (existsSync(packaged)) return serveFile(res, packaged);
                const installed = join(extDir, "node_modules", "@fluentui", "svg-icons", "icons", name);
                if (existsSync(installed)) return serveFile(res, installed);
            }
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Not found");
            return;
        }

        // Per-instance view state for the SPA.
        if (method === "GET" && path === "/api/state") {
            const state = entry ? entry.state : defaultState();
            return sendJson(res, 200, { ...state, deployPrompt: DEPLOY_PROMPT });
        }

        // Live hosted-agent deployment lookup. The direct agent GET is
        // intentionally uncached; the selected project + agent name identify
        // the resource, while the returned latest version proves deployment.
        if (method === "GET" && path === "/api/hosted-agent-deployment") {
            const result = await selectedHostedAgentPortalAction(entry, workspaceRootFn);
            return sendJson(res, 200, result);
        }

        // Synchronous navigation target for the Playground button. Revalidate
        // immediately before redirecting without mutating the clicked control.
        if (method === "GET" && path === "/api/hosted-agent-playground") {
            const result = await selectedHostedAgentPortalAction(entry, workspaceRootFn);
            if (result.available && result.portalUrl.startsWith("https://ai.azure.com/")) {
                res.writeHead(302, {
                    "Cache-Control": "no-store",
                    Location: result.portalUrl,
                });
                res.end();
                return;
            }
            res.writeHead(404, {
                "Cache-Control": "no-store",
                "Content-Type": "text/plain; charset=utf-8",
            });
            res.end("This hosted agent deployment is no longer available.");
            return;
        }

        // Live model deployments in the selected project (mock fallback).
        if (method === "GET" && path === "/api/deployments") {
            const ep = entry?.state.selection.project?.endpoint || "";
            const r = await listDeployments(ep, { force: forceRefresh });
            if (r.ok) {
                return sendJson(res, 200, { ok: true, source: "live", items: r.data.map(enrichDeployment) });
            }
            return sendJson(res, 200, { ok: true, source: "mock", reason: r.reason, items: deployments });
        }

        if (method === "GET" && path === "/api/toolboxes") {
            const ep = entry?.state.selection.project?.endpoint || "";
            const r = await listToolboxes(ep, { force: forceRefresh });
            if (r.ok) {
                return sendJson(res, 200, { ok: true, items: r.data.map(enrichToolbox) });
            }
            return sendJson(res, 200, { ok: false, reason: r.reason, items: [] });
        }

        if (method === "GET" && path === "/api/guardrails") {
            const ep = entry?.state.selection.project?.endpoint || "";
            const sub = entry?.state.selection.subscription.id || "";
            const r = await listGuardrails(ep, sub, { force: forceRefresh });
            if (r.ok) {
                return sendJson(res, 200, { ok: true, items: r.data.map(enrichGuardrail) });
            }
            return sendJson(res, 200, { ok: false, reason: r.reason, items: [] });
        }

        if (method === "GET" && path === "/api/skills") {
            const ep = entry?.state.selection.project?.endpoint || "";
            const r = await listSkills(ep, { force: forceRefresh });
            if (r.ok) {
                return sendJson(res, 200, { ok: true, items: r.data.map(enrichSkill) });
            }
            return sendJson(res, 200, { ok: false, reason: r.reason, items: [] });
        }

        if (method === "GET" && path === "/api/toolbox/tools") {
            const ep = entry?.state.selection.project?.endpoint || "";
            const name = url.searchParams.get("name") || "";
            const version = url.searchParams.get("version") || "";
            const r = await listToolboxTools(ep, name, version);
            if (r.ok) return sendJson(res, 200, { ok: true, items: r.data });
            return sendJson(res, 200, { ok: false, reason: r.reason, items: [] });
        }

        // ── Project picker: identity / subscriptions / projects ──────────────
        if (method === "GET" && path === "/api/identity") {
            const identity = await getIdentity();
            return sendJson(res, 200, { ok: true, ...identity });
        }

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
            const sub = url.searchParams.get("sub") || entry?.state.selection.subscription.id || "";
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
                const selection = selectSubscription(entry?.state.selection, {
                    id: subscriptionId,
                    name: typeof body.subscriptionName === "string" ? body.subscriptionName : "",
                });
                if (entry) entry.state.selection = selection;
                saveSelection(selection);
                return sendJson(res, 200, { ok: true, selection });
            } catch (err) {
                return sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
            }
        }

        if (method === "POST" && path === "/api/select-project") {
            try {
                const body = JSON.parse((await readBody(req)) || "{}");
                const ep = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
                if (!ep) return sendJson(res, 400, { ok: false, error: "Missing endpoint" });
                const current = entry?.state.selection ?? emptySelection();
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
                    endpoint: ep,
                    location: typeof body.location === "string" ? body.location : "",
                    resourceGroup: typeof body.resourceGroup === "string" ? body.resourceGroup : "",
                    accountName: typeof body.accountName === "string" ? body.accountName : "",
                }, subscription);
                if (entry) entry.state.selection = selection;
                saveSelection(selection);
                return sendJson(res, 200, { ok: true, selection });
            } catch (err) {
                return sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
            }
        }

        if (method === "GET" && path === "/api/region-support") {
            const docsUrl = HOSTED_AGENT_REGIONS_DOC;
            const regions = HOSTED_AGENT_REGIONS;
            const selection = entry?.state.selection ?? emptySelection();
            const ep = selection.project?.endpoint || "";
            if (!ep) {
                return sendJson(res, 200, { ok: true, location: "", supported: null, regions, docsUrl });
            }
            let location = selection.project.location;
            if (!location) {
                try {
                    location = await resolveProjectLocation(ep, selection.subscription.id);
                    if (location && entry) {
                        entry.state.selection = selectProject(selection, {
                            ...selection.project,
                            location,
                        });
                        saveSelection(entry.state.selection);
                    }
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
                entry.state.selection = emptySelection();
            }
            return sendJson(res, 200, r);
        }

        // Server-Sent Events so agent-driven canvas updates reflect live.
        if (method === "GET" && path === "/events") {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
            });
            res.write(":ok\n\n");
            if (entry) {
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
            return;
        }

        // "Prompt to chat": forward the text to the session as a user turn.
        if (method === "POST" && path === "/api/send") {
            try {
                const raw = await readBody(req);
                const { prompt, refresh } = JSON.parse(raw || "{}");
                if (typeof prompt !== "string" || !prompt.trim()) {
                    return sendJson(res, 400, { ok: false, error: "Missing prompt" });
                }
                // A canvas-originated create/deploy request expects the canvas to
                // refresh once the agent finishes. Register the intent before the
                // prompt is sent so the session.idle handler can verify real state
                // and drive the refresh itself (no model-invoked action needed).
                if (typeof refresh === "string" && refresh) markPendingRefresh?.(refresh);
                await waitForFoundrySkill?.();
                await session.send({ prompt });
                return sendJson(res, 200, { ok: true });
            } catch (err) {
                await session.log(`Failed to send prompt to chat: ${err?.message ?? err}`, { level: "error" });
                return sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
            }
        }

        if (method === "GET" && path === "/api/project-init") {
            const root = await workspaceRootFn();
            const { hasAzure, hasAgent } = await inspectHostedAgentWorkspace(root);
            return sendJson(res, 200, {
                ok: true,
                hasAzure,
                hasAgent,
                initialized: hasAzure || hasAgent,
                sections: initialBuildSections({ hasAgent }),
            });
        }

        if (method === "GET" && path === "/api/inspect/ready") {
            const ready = await isAgentReachable();
            return sendJson(res, 200, { ready });
        }

        if (method === "GET" && path === "/api/inspect/start") {
            try {
                const proxyUrl = await ensureInspectorProxy(inspectorUiDir);
                if (!proxyUrl) {
                    return sendJson(res, 200, {
                        ok: false,
                        error: "Inspector failed to start. Check the extension logs for details.",
                    });
                }
                // Launch (or reuse) the local agent in the integrated terminal so
                // it becomes reachable for the inspector to connect to. If the
                // terminal couldn't be launched there's nothing for the inspector
                // to connect to, so fail now instead of letting the UI poll for
                // an agent that will never come up.
                const terminal = await launchAgentTerminal(session);
                if (!terminal?.ok) {
                    return sendJson(res, 200, {
                        ok: false,
                        error: terminal?.error || "Could not start the agent in the integrated terminal.",
                        terminal,
                    });
                }
                return sendJson(res, 200, { ok: true, url: proxyUrl, terminal });
            } catch (err) {
                await session.log(`Inspector start failed: ${err?.message ?? err}`, { level: "error" });
                return sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
            }
        }

        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
    };
}
