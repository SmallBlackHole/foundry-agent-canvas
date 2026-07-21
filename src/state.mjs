import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
    getIdentity,
    listSubscriptions,
    listProjects,
} from "./foundry.mjs";
import {
    emptySelection,
    normalizeSelection,
    selectProject,
    selectSubscription,
    serializeSelection,
} from "../public/selection-state.js";

const COPILOT_HOME = process.env.COPILOT_HOME || join(homedir(), ".copilot");
const STATE_DIR = join(COPILOT_HOME, "extension-state", "foundry-agent-canvas");
const STATE_FILE = join(STATE_DIR, "state.json");

export function loadSelection() {
    try {
        if (!existsSync(STATE_FILE)) return null;
        const data = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
        if (data && typeof data === "object") return normalizeSelection(data);
    } catch {
        /* ignore a corrupt/unreadable store */
    }
    return null;
}

export function saveSelection(sel) {
    try {
        mkdirSync(STATE_DIR, { recursive: true });
        writeFileSync(STATE_FILE, JSON.stringify(serializeSelection(sel), null, 2), "utf-8");
    } catch {
        /* best-effort persistence */
    }
}

export function clearSelection() {
    try {
        if (existsSync(STATE_FILE)) writeFileSync(STATE_FILE, "{}", "utf-8");
    } catch {
        /* ignore */
    }
}

// Retained for the provider process lifetime because the host may reload a
// cached canvas URL without invoking the provider's open handler again.
export const servers = new Map(); // instanceId -> { server, url, state, sseClients:Set }

export function defaultState() {
    return {
        agentName: "",
        selection: emptySelection(),
        model: { name: "", color: "#10a37f" },
    };
}

export function applyInput(state, input) {
    if (!input || typeof input !== "object") return state;
    if (typeof input.agentName === "string" && input.agentName.trim()) state.agentName = input.agentName.trim();
    const endpoint = typeof input.projectEndpoint === "string" && input.projectEndpoint.trim()
        ? input.projectEndpoint.trim()
        : state.selection.project?.endpoint || "";
    const name = typeof input.projectName === "string" && input.projectName.trim()
        ? input.projectName.trim()
        : state.selection.project?.name || "";
    if (endpoint || name) {
        state.selection = selectProject(state.selection, {
            ...state.selection.project,
            endpoint,
            name,
        });
    }
    if (typeof input.model === "string" && input.model.trim()) {
        state.model = { name: input.model.trim(), color: "#10a37f" };
    }
    return state;
}

export async function bootstrapInstance(entry) {
    const identity = await getIdentity();
    let selection = emptySelection();
    let resolved = false;
    if (identity.signedIn) {
        const saved = loadSelection();
        if (saved?.subscription.id) {
            selection = saved;
            if (saved.project) {
                const projects = await listProjects(saved.subscription.id);
                if (projects.ok) {
                    const endpoint = saved.project.endpoint.replace(/\/+$/, "");
                    const match = projects.data.find((item) => item.endpoint.replace(/\/+$/, "") === endpoint);
                    selection = selectProject(selection, match, selection.subscription);
                    saveSelection(selection);
                }
            }
            resolved = !!selection.project;
        } else {
            const subscriptions = await listSubscriptions();
            const subscription = subscriptions.ok
                ? subscriptions.data.find((item) => item.isDefault) || subscriptions.data[0]
                : null;
            if (subscription) {
                selection = selectSubscription(selection, subscription);
                const projects = await listProjects(subscription.id);
                if (projects.ok && projects.data.length) {
                    selection = selectProject(selection, projects.data[0], subscription);
                    resolved = true;
                }
                saveSelection(selection);
            }
        }
    }
    entry.state.selection = selection;
    return {
        identity,
        selection,
        resolved,
    };
}
