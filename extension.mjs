import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";

import { PAGES, servers, defaultState, applyInput } from "./src/state.mjs";
import { pushNavigate, pushSetProtocol, pushFrame } from "./src/server-utils.mjs";
import { createRequestHandler } from "./src/routes.mjs";
import { setInspectorSession } from "./src/inspector.mjs";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(EXT_DIR, "public");
const INSPECTOR_UI_DIR = join(EXT_DIR, "inspector-ui");

function workspaceRoot() {
    const up = join(EXT_DIR, "..", "..", "..");
    if (existsSync(join(up, ".github"))) return up;
    return process.cwd();
}

async function startServer(instanceId, session) {
    const server = createServer(
        createRequestHandler(instanceId, {
            session,
            publicDir: PUBLIC_DIR,
            extDir: EXT_DIR,
            inspectorUiDir: INSPECTOR_UI_DIR,
            workspaceRootFn: workspaceRoot,
        })
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/`, state: defaultState(), sseClients: new Set() };
}

const session = await joinSession({
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
                    name: "setProtocol",
                    description:
                        'Set the agent protocol in the builder\'s "Initialize agent code" starter prompt. ' +
                        "Call this after the user picks between Responses and Invocations so the prompt updates to match.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            protocol: {
                                type: "string",
                                enum: ["Responses", "Invocations"],
                                description: "The hosted-agent protocol the user chose.",
                            },
                        },
                        required: ["protocol"],
                        additionalProperties: false,
                    },
                    handler: async (ctx) => {
                        const entry = servers.get(ctx.instanceId);
                        if (!entry) throw new CanvasError("canvas_not_open", "No open canvas instance for this id.");
                        entry.state.initProtocol = ctx.input.protocol;
                        pushSetProtocol(entry, ctx.input.protocol);
                        return { ok: true, protocol: ctx.input.protocol };
                    },
                },
                {
                    name: "setAgentIdea",
                    description:
                        "Set the agent's purpose phrase in the builder's starter prompt. Pass a short phrase " +
                        "(2-4 words) that fits the sentence 'Create a ___ Python hosted agent'.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            idea: {
                                type: "string",
                                description:
                                    "Short purpose phrase, e.g. 'meeting-notes-summarizing' or 'invoice-parsing'.",
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
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(ctx.instanceId, session);
                    servers.set(ctx.instanceId, entry);
                }
                applyInput(entry.state, ctx.input);
                return { title: "Foundry Agent Canvas", url: entry.url, status: "Build" };
            },
        }),
    ],
});

setInspectorSession(session);
