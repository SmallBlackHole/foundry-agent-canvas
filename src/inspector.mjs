import { createInspectorServer } from "./inspector-backend/index.mjs";

export const AGENT_PORT = 8088;
let inspectorProxyUrl = null;
let inspectorProxyServer = null;

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
