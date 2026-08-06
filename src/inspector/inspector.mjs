import { createInspectorServer } from "./backend.mjs";

export const AGENT_PORT = 8088;
let inspectorProxyUrl = null;
let inspectorProxyServer = null;

// Single source of truth for "is the local agent up?" — used by the readiness
// endpoint and by the terminal launcher. Any HTTP response (even non-2xx) means
// something is listening on AGENT_PORT; a thrown error (e.g. connection refused
// or timeout) means it is not up yet.
export async function isAgentReachable(timeoutMs = 2000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        await fetch(`http://localhost:${AGENT_PORT}/agentdev/version`, { signal: controller.signal });
        return true;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

let _session = null;

export function setInspectorSession(s) {
    _session = s;
}

function logInspector(msg, level = "info") {
    try {
        _session?.log?.(`[inspector] ${msg}`, { level });
    } catch {
        /* ignore */
    }
}

function handleFixRequested(source, errorSummary) {
    logInspector(`Fix requested from ${source}: ${errorSummary}`);
    if (!_session) {
        logInspector("Fix requested but no Copilot session available", "error");
        return;
    }
    const prompt =
        `The agent encountered an error during testing in the Agent Inspector:\n\n${errorSummary}\n\n` +
        "Please fix this error and do a clean restart of the agent with previous running agent " +
        "processes killed, so I can verify it works.";
    _session
        .send({ prompt })
        .catch((err) => logInspector(`Failed to send fix request: ${err?.message ?? err}`, "error"));
}

async function getOrCreateInspectorProxy(uiDir) {
    if (inspectorProxyUrl) return inspectorProxyUrl;
    const { url, server } = await createInspectorServer({
        uiDir,
        agentPort: AGENT_PORT,
        onFixRequested: handleFixRequested,
    });
    inspectorProxyServer = server;
    inspectorProxyUrl = url;
    logInspector(`inspector server: ${inspectorProxyUrl}`);
    return inspectorProxyUrl;
}

export async function ensureInspectorProxy(uiDir) {
    return getOrCreateInspectorProxy(uiDir);
}

export { logInspector };
