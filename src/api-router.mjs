import { sendJson } from "./server-utils.mjs";

const DEFAULT_BODY_LIMIT = 1_000_000;

export class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.name = "ApiError";
        this.status = status;
    }
}

async function readJsonBody(req, limit) {
    const contentLength = Number(req.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > limit) {
        req.resume();
        throw new ApiError(413, "Body too large");
    }

    const raw = await new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;

        const cleanup = () => {
            req.off("data", onData);
            req.off("end", onEnd);
            req.off("error", onError);
        };
        const onData = (chunk) => {
            size += chunk.length;
            if (size <= limit) {
                chunks.push(chunk);
                return;
            }
            cleanup();
            req.resume();
            reject(new ApiError(413, "Body too large"));
        };
        const onEnd = () => {
            cleanup();
            resolve(Buffer.concat(chunks).toString("utf8"));
        };
        const onError = (error) => {
            cleanup();
            reject(error);
        };

        req.on("data", onData);
        req.on("end", onEnd);
        req.on("error", onError);
    });

    if (!raw) return {};
    try {
        return JSON.parse(raw);
    } catch {
        throw new ApiError(400, "Malformed JSON");
    }
}

function requiredString(body, field, label) {
    const value = typeof body[field] === "string" ? body[field].trim() : "";
    if (!value) throw new ApiError(400, `Missing ${label}`);
    return value;
}

function optionalString(body, field) {
    return typeof body[field] === "string" ? body[field].trim() : "";
}

function direct(serviceMethod) {
    return ({ services, url, body }) => services[serviceMethod]({ url, body });
}

const routes = new Map();

function route(method, path, serviceMethod, options = {}) {
    routes.set(`${method} ${path}`, {
        parseBody: options.parseBody === true,
        handle: options.handle || direct(serviceMethod),
    });
}

route("GET", "/api/state", "getState");
route("GET", "/api/hosted-agent-deployment", "getHostedAgentDeployment");
route("GET", "/api/hosted-agent-playground", "getHostedAgentPlayground", {
    handle: async ({ services, url }) => {
        const result = await services.getHostedAgentPlayground({ url });
        if (!result?.available || !result.portalUrl) {
            return {
                httpStatus: 404,
                text: "This hosted agent deployment is no longer available.",
            };
        }
        return {
            httpStatus: 302,
            headers: {
                "Cache-Control": "no-store",
                Location: result.portalUrl,
            },
        };
    },
});
route("GET", "/api/hosted-agents", "listHostedAgents");
route("POST", "/api/select-hosted-agent", "selectHostedAgent", {
    parseBody: true,
    handle: ({ services, url, body }) => services.selectHostedAgent({
        url,
        body: {
            ...body,
            agentName: requiredString(body, "agentName", "agentName"),
        },
    }),
});
route("GET", "/api/deployments", "listDeployments");
route("GET", "/api/toolboxes", "listToolboxes");
route("GET", "/api/skills", "listSkills");
route("GET", "/api/guardrails", "listGuardrails");
route("GET", "/api/toolbox/tools", "listToolboxTools");
route("GET", "/api/identity", "getIdentity");
route("GET", "/api/bootstrap", "bootstrap");
route("GET", "/api/subscriptions", "listSubscriptions");
route("GET", "/api/projects", "listProjects");
route("POST", "/api/select-subscription", "selectSubscription", {
    parseBody: true,
    handle: ({ services, url, body }) => services.selectSubscription({
        url,
        body: {
            ...body,
            subscriptionId: requiredString(body, "subscriptionId", "subscriptionId"),
        },
    }),
});
route("POST", "/api/select-project", "selectProject", {
    parseBody: true,
    handle: ({ services, url, body }) => services.selectProject({
        url,
        body: {
            ...body,
            endpoint: requiredString(body, "endpoint", "endpoint"),
        },
    }),
});
route("GET", "/api/region-support", "getRegionSupport");
route("POST", "/api/signin", "signIn");
route("GET", "/api/signin/status", "getSignInStatus");
route("POST", "/api/signin/cancel", "cancelSignIn", { parseBody: true });
route("POST", "/api/signout", "signOut");
route("POST", "/api/send", "sendPrompt", {
    parseBody: true,
    handle: async ({ services, url, body }) => {
        const prompt = requiredString(body, "prompt", "prompt");
        const result = await services.sendPrompt({
            url,
            body: { ...body, prompt },
        });
        return { ok: true, ...result };
    },
});
route("POST", "/api/managed-agent/playground/stream", "streamManagedAgent", {
    parseBody: true,
    handle: ({ services, url, body }) => services.streamManagedAgent({
        url,
        body: {
            agentName: requiredString(body, "agentName", "agentName"),
            agentVersion: optionalString(body, "agentVersion"),
            message: requiredString(body, "message", "message"),
            conversationId: optionalString(body, "conversationId"),
        },
    }),
});
route("POST", "/api/managed-agent/playground/reset", "resetManagedAgentConversation", {
    parseBody: true,
    handle: ({ services, url, body }) => services.resetManagedAgentConversation({
        url,
        body: {
            conversationId: requiredString(body, "conversationId", "conversationId"),
        },
    }),
});
route("GET", "/api/project-init", "getProjectInit");
route("GET", "/api/plugin-update", "getPluginUpdate");
route("GET", "/api/inspect/ready", "getInspectorReady");
route("GET", "/api/inspect/start", "startInspector");

function sendResult(res, result) {
    if (result?.text !== undefined) {
        res.writeHead(result.httpStatus || 200, {
            "Cache-Control": "no-store",
            "Content-Type": "text/plain; charset=utf-8",
            ...result.headers,
        });
        res.end(result.text);
        return;
    }
    if (result?.headers && result.body === undefined) {
        res.writeHead(result.httpStatus || 200, result.headers);
        res.end();
        return;
    }
    sendJson(res, result?.httpStatus || 200, result?.body ?? result);
}

async function writeNdjson(res, event) {
    if (res.destroyed || res.writableEnded) return false;
    if (res.write(`${JSON.stringify(event)}\n`)) return true;
    await new Promise((resolve) => {
        const cleanup = () => {
            res.off("drain", done);
            res.off("close", done);
            res.off("error", done);
        };
        const done = () => {
            cleanup();
            resolve();
        };
        res.once("drain", done);
        res.once("close", done);
        res.once("error", done);
    });
    return !res.destroyed && !res.writableEnded;
}

async function sendNdjson(req, res, result) {
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    req.once("aborted", abort);
    res.once("close", abort);
    res.writeHead(200, {
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
    });
    try {
        await result.run({
            signal: abortController.signal,
            emit: (event) => writeNdjson(res, event),
        });
        if (!res.destroyed && !res.writableEnded) res.end();
    } finally {
        req.off("aborted", abort);
        res.off("close", abort);
    }
}

function requestDisconnected(req, res) {
    return req.aborted || res.destroyed;
}

export function createApiRouter({
    services,
    bodyLimit = DEFAULT_BODY_LIMIT,
    reportError,
}) {
    return async function handleApi(req, res, providedUrl) {
        const url = providedUrl || new URL(req.url, "http://127.0.0.1");
        const method = req.method || "GET";
        const match = routes.get(`${method} ${url.pathname}`);
        if (!match) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Not found");
            return false;
        }

        try {
            const body = match.parseBody ? await readJsonBody(req, bodyLimit) : undefined;
            const result = await match.handle({ services, url, body });
            if (result?.stream === "ndjson" && typeof result.run === "function") {
                await sendNdjson(req, res, result);
            } else {
                sendResult(res, result);
            }
        } catch (error) {
            if (requestDisconnected(req, res)) return true;
            const status = error instanceof ApiError ? error.status : 500;
            if (res.headersSent) {
                await writeNdjson(res, {
                    type: "error",
                    error: error?.message || String(error),
                });
                if (!res.destroyed && !res.writableEnded) res.end();
            } else {
                sendJson(res, status, { ok: false, error: error?.message || String(error) });
            }
            if (status === 500 && reportError) {
                try {
                    await reportError(error, { method, path: url.pathname });
                } catch {
                    /* diagnostics must never affect the HTTP response */
                }
            }
        }
        return true;
    };
}
