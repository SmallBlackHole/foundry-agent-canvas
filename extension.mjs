import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";

import { servers, defaultState, applyInput } from "./src/state.mjs";
import { listenLoopbackServer, pushFrame } from "./src/server-utils.mjs";
import { createRequestHandler, selectedHostedAgentPortalAction } from "./src/routes.mjs";
import { setInspectorSession } from "./src/inspector.mjs";
import { closeAgentTerminal } from "./src/agent-terminal.mjs";
import { ensureFoundrySkill } from "./src/skills.mjs";
import { createWorkspaceRootResolver, initializeWorkspaceRoot } from "./src/workspace-root.mjs";
import { refreshWorkspaceState } from "./src/workspace-state.mjs";
import { refreshDeploymentState } from "./src/deployment-state.mjs";
import {
    MICROSOFT_FOUNDRY_CANVAS_ID,
    MICROSOFT_FOUNDRY_CANVAS_SYSTEM_MESSAGE,
    isGitHubCopilotAppEnvironment,
} from "./src/agent-canvas-system-message.mjs";
import {
    createPendingRefreshManager,
    DEPLOYMENT_REFRESH,
} from "./src/pending-refresh.mjs";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(EXT_DIR, "public");
const INSPECTOR_UI_DIR = join(EXT_DIR, "inspector-ui");
const FOUNDRY_SKILL_PROMPT_WAIT_MS = 3_000;
const isGitHubCopilotApp = isGitHubCopilotAppEnvironment();
const openInstances = new Set();
const workspaceRoot = createWorkspaceRootResolver({ extensionDir: EXT_DIR });
let markWorkspaceRootReady;
const workspaceRootReady = new Promise((resolve) => {
    markWorkspaceRootReady = resolve;
});

const resolveWorkspaceRoot = async () => {
    await workspaceRootReady;
    return workspaceRoot.resolve();
};

// Drives the automatic canvas refresh after a canvas-originated deployment.
// The client marks the pending kind when it sends the prompt; on session.idle we
// verify real state and refresh the relevant open canvas instance.
const pendingRefresh = createPendingRefreshManager({
    servers,
    inspectDeployment: (entry) => selectedHostedAgentPortalAction(entry, resolveWorkspaceRoot),
    refreshDeployment: refreshDeploymentState,
    log: (message, options) => session.log(message, options),
});

async function ensureFoundrySkillForCanvas(session) {
    let failure = "";
    let ready = false;
    try {
        const result = await ensureFoundrySkill();
        ready = !!result.ready;
        if (!result.ok && !(result.status === "unknown" && ready)) {
            const operation = result.action === "none" ? "check" : result.action;
            failure = `Foundry Skills automatic ${operation} failed: ${result.summary || "Unknown error"}`;
        }
    } catch (err) {
        failure = `Foundry Skills automatic check failed: ${err?.message ?? err}`;
    }
    if (failure) {
        try {
            await session.log(failure, { level: "error" });
        } catch {
            /* logging must not surface an unhandled rejection */
        }
    }
}

async function waitForFoundrySkillSync(syncPromise) {
    let timer = null;
    try {
        await Promise.race([
            syncPromise,
            new Promise((resolve) => {
                timer = setTimeout(resolve, FOUNDRY_SKILL_PROMPT_WAIT_MS);
                timer.unref?.();
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function startServer(instanceId, session) {
    let foundrySkillSync = null;
    const syncFoundrySkill = () => {
        foundrySkillSync = ensureFoundrySkillForCanvas(session);
        return foundrySkillSync;
    };
    const server = createServer(
        createRequestHandler(instanceId, {
            session,
            publicDir: PUBLIC_DIR,
            extDir: EXT_DIR,
            inspectorUiDir: INSPECTOR_UI_DIR,
            workspaceRootFn: resolveWorkspaceRoot,
            onCanvasOpen: syncFoundrySkill,
            waitForFoundrySkill: () => waitForFoundrySkillSync(foundrySkillSync || syncFoundrySkill()),
            markPendingRefresh: (kind) => pendingRefresh.mark(instanceId, kind),
        })
    );
    const port = await listenLoopbackServer(server);
    return { server, url: `http://127.0.0.1:${port}/`, state: defaultState(), sseClients: new Set() };
}

const session = await joinSession({
    ...(isGitHubCopilotApp
        ? {
            systemMessage: {
                mode: "append",
                content: MICROSOFT_FOUNDRY_CANVAS_SYSTEM_MESSAGE,
            },
            hooks: {
                onSessionStart: (input) => {
                    workspaceRoot.update(input.workingDirectory);
                },
                onUserPromptSubmitted: (input) => {
                    workspaceRoot.update(input.workingDirectory);
                },
            },
        }
        : {}),
    canvases: isGitHubCopilotApp ? [
        createCanvas({
            id: MICROSOFT_FOUNDRY_CANVAS_ID,
            displayName: "Microsoft Foundry (Preview)",
            description:
                "Create, build, or design a Foundry agent — use this whenever the user wants to make, set up, or scaffold a new agent: pick a model, add tools, skills, then deploy it as a Foundry hosted agent.",
            inputSchema: {
                type: "object",
                properties: {
                    // Deprecated and ignored: the canvas only has the build view now.
                    // Retained as an optional property (additionalProperties is false)
                    // so persisted/rehydrated open inputs carrying page:"build" still
                    // pass SDK validation before open(). No navigation reads it.
                    page: {
                        type: "string",
                        enum: ["build"],
                        description: 'Deprecated and ignored; retained only so older inputs with page:"build" still validate.',
                    },
                    agentName: { type: "string", description: "Name shown in the builder header." },
                    idea: {
                        type: "string",
                        description:
                            "Exact original user prompt when it describes what the agent will do or produce. Preserve it verbatim; omit for generic requests such as 'create a basic foundry agent'.",
                    },
                    model: { type: "string", description: "Currently selected model name." },
                    projectEndpoint: {
                        type: "string",
                        description:
                            "Foundry project data-plane endpoint whose live model deployments, toolboxes, skills, and guardrails the selectors should show (e.g. https://<resource>.services.ai.azure.com/api/projects/<project>).",
                    },
                    projectName: { type: "string", description: "Display name of the selected Foundry project." },
                },
                additionalProperties: false,
            },
            actions: [
                {
                    name: "setAgentIdea",
                    description:
                        "Set the original user request shown at the beginning of the builder's starter prompt.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            idea: {
                                type: "string",
                                description:
                                    "Exact original user prompt describing what the agent will do or produce, preserved verbatim without summarizing or rewriting.",
                            },
                        },
                        required: ["idea"],
                        additionalProperties: false,
                    },
                    handler: async (ctx) => {
                        const entry = servers.get(ctx.instanceId);
                        if (!entry) throw new CanvasError("canvas_not_open", "No open canvas instance for this id.");
                        entry.state.initPrompt = ctx.input.idea;
                        pushFrame(entry, { type: "setPrompt", prompt: ctx.input.idea });
                        return { ok: true, idea: ctx.input.idea };
                    },
                },
                {
                    // Idle-driven refresh normally handles this automatically; the
                    // action is retained as a manual/recovery path (e.g. if the
                    // idle refresh was missed or the user wants to force a refresh).
                    name: "refreshWorkspaceState",
                    description: "Refresh the canvas workspace state after the hosted-agent code is created.",
                    handler: async (ctx) => {
                        const entry = servers.get(ctx.instanceId);
                        if (!entry) throw new CanvasError("canvas_not_open", "No open canvas instance for this id.");
                        return refreshWorkspaceState(entry, resolveWorkspaceRoot);
                    },
                },
                {
                    // Retained as a manual/recovery path alongside the idle-driven
                    // deployment refresh.
                    name: "refreshDeploymentState",
                    description: "Refresh the canvas deployment state after the hosted agent is deployed.",
                    handler: async (ctx) => {
                        const entry = servers.get(ctx.instanceId);
                        if (!entry) throw new CanvasError("canvas_not_open", "No open canvas instance for this id.");
                        return refreshDeploymentState(entry, () =>
                            selectedHostedAgentPortalAction(entry, resolveWorkspaceRoot),
                        );
                    },
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (entry && !entry.server.listening) {
                    servers.delete(ctx.instanceId);
                    entry = null;
                }
                if (!entry) {
                    entry = await startServer(ctx.instanceId, session);
                    servers.set(ctx.instanceId, entry);
                }
                openInstances.add(ctx.instanceId);
                applyInput(entry.state, ctx.input);
                return { title: "Microsoft Foundry (Preview)", url: entry.url, status: "Build" };
            },
            onClose: async (ctx) => {
                // Keep the unreferenced loopback server available for cached-URL
                // reloads without allowing it to extend the provider lifetime.
                openInstances.delete(ctx.instanceId);
                // The agent terminal is shared across builder instances, so only
                // close it (stopping the local azd agent and freeing its port)
                // once the last builder canvas is gone.
                if (openInstances.size === 0) {
                    await closeAgentTerminal(session);
                }
            },
        }),
    ] : [],
});

if (isGitHubCopilotApp) {
    // Subscribe before workspace hydration so an early canvas request cannot
    // finish while no idle listener is registered. The refresh manager waits
    // for workspaceRootReady when it needs the resolved workspace.
    session.on("session.idle", () => {
        pendingRefresh.handleSessionIdle().catch(async (err) => {
            try {
                await session.log(`session.idle refresh handler failed: ${err?.message ?? err}`, { level: "error" });
            } catch {
                /* logging must not surface an unhandled rejection */
            }
        });
    });

    try {
        await initializeWorkspaceRoot(session, workspaceRoot);
    } catch (err) {
        try {
            await session.log(`Active workspace detection failed: ${err?.message ?? err}`, { level: "error" });
        } catch {
            /* logging must not prevent the canvas provider from becoming ready */
        }
    } finally {
        markWorkspaceRootReady();
    }

    setInspectorSession(session);
} else {
    // The extension is canvas-only. In regular Copilot CLI sessions the SDK
    // handshake is retained, but no hooks or background listeners are active.
    markWorkspaceRootReady();
}
