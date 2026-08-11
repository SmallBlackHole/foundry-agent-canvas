import { existsSync } from "node:fs";
import { join } from "node:path";

import { createApiRouter } from "./api-router.mjs";
import { createRuntimeApiServices } from "./api/index.mjs";
import { resolvePluginVersion } from "./plugin-update.mjs";
import { serveFile, serveStatic, SSE_HEARTBEAT_MS } from "./server-utils.mjs";
import { servers } from "./state.mjs";
import { flushPendingWorkspaceState } from "./hosted-agent/workspace-state.mjs";

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
        clearPendingRefresh,
        telemetry,
        createAgentOperations,
        deploymentOperations,
    },
) {
    const pluginVersion = resolvePluginVersion(extDir);
    const handleApi = createApiRouter({
        services: createRuntimeApiServices(instanceId, {
            session,
            inspectorUiDir,
            extensionDir: extDir,
            workspaceRootFn,
            waitForFoundrySkill,
            markPendingRefresh,
            clearPendingRefresh,
            pluginVersion,
            telemetry,
            createAgentOperations,
            deploymentOperations,
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
        if (method === "GET" && path.startsWith("/app/")) {
            const name = path.slice("/app/".length);
            if (/^[a-z0-9-]+\.js$/.test(name)) {
                return serveStatic(res, join("app", name), publicDir);
            }
        }
        if (method === "GET" && path === "/selection-state.js") {
            return serveStatic(res, "selection-state.js", publicDir);
        }
        if (method === "GET" && path === "/issue-report.js") {
            return serveStatic(res, "issue-report.js", publicDir);
        }
        if (method === "GET" && path === "/telemetry-constants.js") {
            return serveStatic(res, "telemetry-constants.js", publicDir);
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
