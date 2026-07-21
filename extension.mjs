import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";

import { PAGES, servers, defaultState, applyInput } from "./src/state.mjs";
import { pushNavigate, pushFrame } from "./src/server-utils.mjs";
import { createRequestHandler, selectedHostedAgentPortalAction } from "./src/routes.mjs";
import { setInspectorSession } from "./src/inspector.mjs";
import { closeAgentTerminal } from "./src/agent-terminal.mjs";
import { ensureFoundrySkill } from "./src/skills.mjs";
import { createWorkspaceRootResolver, initializeWorkspaceRoot } from "./src/workspace-root.mjs";
import { refreshWorkspaceState } from "./src/workspace-state.mjs";
import { refreshDeploymentState } from "./src/deployment-state.mjs";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(EXT_DIR, "public");
const INSPECTOR_UI_DIR = join(EXT_DIR, "inspector-ui");
const FOUNDRY_SKILL_PROMPT_WAIT_MS = 3_000;
const openInstances = new Set();
const workspaceRoot = createWorkspaceRootResolver({ extensionDir: EXT_DIR });
let markWorkspaceRootReady;
const workspaceRootReady = new Promise((resolve) => {
    markWorkspaceRootReady = resolve;
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
            workspaceRootFn: async () => {
                await workspaceRootReady;
                return workspaceRoot.resolve();
            },
            onCanvasOpen: syncFoundrySkill,
            waitForFoundrySkill: () => waitForFoundrySkillSync(foundrySkillSync || syncFoundrySkill()),
        })
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/`, state: defaultState(), sseClients: new Set() };
}

const session = await joinSession({
    hooks: {
        onSessionStart: (input) => {
            workspaceRoot.update(input.workingDirectory);
        },
        onUserPromptSubmitted: (input) => {
            workspaceRoot.update(input.workingDirectory);
        },
    },
    canvases: [
        createCanvas({
            id: "agent-builder",
            displayName: "Foundry Agent Canvas",
            description:
                "Create, build, or design a Foundry agent — use this whenever the user wants to make, set up, or scaffold a new agent: pick a model, add tools, skills, then deploy it as a Foundry hosted agent.",
            inputSchema: {
                type: "object",
                properties: {
                    page: { type: "string", enum: PAGES, description: "Initial view to show." },
                    agentName: { type: "string", description: "Name shown in the builder header." },
                    model: { type: "string", description: "Currently selected model name." },
                    projectEndpoint: {
                        type: "string",
                        description:
                            "Foundry project data-plane endpoint whose live model deployments and tool connections the selectors should show (e.g. https://<resource>.services.ai.azure.com/api/projects/<project>).",
                    },
                    projectName: { type: "string", description: "Display name of the selected Foundry project." },
                },
                additionalProperties: false,
            },
            actions: [
                {
                    name: "navigate",
                    description: "Switch the open canvas to the build view.",
                    inputSchema: {
                        type: "object",
                        properties: { page: { type: "string", enum: PAGES } },
                        required: ["page"],
                        additionalProperties: false,
                    },
                    handler: async (ctx) => {
                        const entry = servers.get(ctx.instanceId);
                        if (!entry) throw new CanvasError("canvas_not_open", "No open canvas instance for this id.");
                        entry.state.page = ctx.input.page;
                        pushNavigate(entry, ctx.input.page);
                        return { ok: true, page: ctx.input.page };
                    },
                },
                {
                    name: "setAgentIdea",
                    description:
                        "Set the idea shown at the beginning of the builder's starter prompt. Pass one concise " +
                        "capability clause describing what the agent should do.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            idea: {
                                type: "string",
                                description:
                                    "Concise purpose clause, e.g. 'summarize meeting notes into decisions and action items'.",
                            },
                        },
                        required: ["idea"],
                        additionalProperties: false,
                    },
                    handler: async (ctx) => {
                        const entry = servers.get(ctx.instanceId);
                        if (!entry) throw new CanvasError("canvas_not_open", "No open canvas instance for this id.");
                        entry.state.initIdea = ctx.input.idea;
                        pushFrame(entry, { type: "setIdea", idea: ctx.input.idea });
                        return { ok: true, idea: ctx.input.idea };
                    },
                },
                {
                    name: "refreshWorkspaceState",
                    description: "Refresh the canvas workspace state after the hosted-agent code is created.",
                    handler: async (ctx) => {
                        const entry = servers.get(ctx.instanceId);
                        if (!entry) throw new CanvasError("canvas_not_open", "No open canvas instance for this id.");
                        return refreshWorkspaceState(entry, async () => {
                            await workspaceRootReady;
                            return workspaceRoot.resolve();
                        });
                    },
                },
                {
                    name: "refreshDeploymentState",
                    description: "Refresh the canvas deployment state after the hosted agent is deployed.",
                    handler: async (ctx) => {
                        const entry = servers.get(ctx.instanceId);
                        if (!entry) throw new CanvasError("canvas_not_open", "No open canvas instance for this id.");
                        return refreshDeploymentState(entry, () =>
                            selectedHostedAgentPortalAction(entry, async () => {
                                await workspaceRootReady;
                                return workspaceRoot.resolve();
                            }),
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
                return { title: "Foundry Agent Canvas", url: entry.url, status: "Build" };
            },
            onClose: async (ctx) => {
                // Keep the loopback server alive for this provider process. The
                // host can later reload the cached URL for the same instance
                // without invoking open(), so closing it here strands the iframe
                // on a dead port. Process exit reclaims every retained server.
                openInstances.delete(ctx.instanceId);
                // The agent terminal is shared across builder instances, so only
                // close it (stopping the local azd agent and freeing its port)
                // once the last builder canvas is gone.
                if (openInstances.size === 0) {
                    await closeAgentTerminal(session);
                }
            },
        }),
    ],
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
