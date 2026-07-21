import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
    getIdentity,
    listSubscriptions,
    listProjects,
    resolveProjectLocation,
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
    const current = normalizeSelection(state.selection);
    const hasEndpoint = typeof input.projectEndpoint === "string" && !!input.projectEndpoint.trim();
    const hasName = typeof input.projectName === "string" && !!input.projectName.trim();
    const endpoint = hasEndpoint
        ? input.projectEndpoint.trim().replace(/\/+$/, "")
        : current.project?.endpoint || "";
    const name = hasName
        ? input.projectName.trim()
        : current.project?.name || "";
    if (hasEndpoint && endpoint !== (current.project?.endpoint || "")) {
        state.selection = selectProject(emptySelection(), {
            endpoint,
            name: hasName ? name : "",
            location: "",
            resourceGroup: "",
            accountName: "",
            subscriptionId: "",
        });
    } else if (endpoint || name) {
        state.selection = selectProject(current, {
            ...current.project,
            endpoint,
            name,
        });
    }
    if (typeof input.model === "string" && input.model.trim()) {
        state.model = { name: input.model.trim(), color: "#10a37f" };
    }
    return state;
}

export async function enrichProjectLocation(
    entry,
    resolveLocation = resolveProjectLocation,
    persist = saveSelection,
) {
    const captured = normalizeSelection(entry?.state?.selection);
    const endpoint = captured.project?.endpoint || "";
    const subscriptionId = captured.subscription.id;
    if (!endpoint) return "";
    if (captured.project.location) return captured.project.location;

    const location = await resolveLocation(endpoint, subscriptionId);
    if (!location || !entry) return location || "";

    const current = normalizeSelection(entry.state.selection);
    if (
        current.subscription.id !== subscriptionId
        || current.project?.endpoint !== endpoint
    ) {
        return "";
    }

    const selection = selectProject(current, {
        ...current.project,
        location,
    });
    entry.state.selection = selection;
    persist(selection);
    return selection.project.location;
}

export async function bootstrapInstance(entry, dependencies = {}) {
    const services = {
        getIdentity,
        listSubscriptions,
        listProjects,
        loadSelection,
        saveSelection,
        ...dependencies,
    };
    const identity = await services.getIdentity();
    const seed = normalizeSelection(entry.state.selection);
    let selection = seed;
    let resolved = !!selection.project;
    if (identity.signedIn) {
        const saved = normalizeSelection(services.loadSelection());
        if (saved?.subscription.id) {
            if (saved.project) {
                selection = saved;
                resolved = true;
                const projects = await services.listProjects(saved.subscription.id);
                if (projects.ok) {
                    const endpoint = saved.project.endpoint.replace(/\/+$/, "");
                    const match = projects.data.find((item) => item.endpoint.replace(/\/+$/, "") === endpoint);
                    selection = selectProject(selection, match, selection.subscription);
                    resolved = !!selection.project;
                    services.saveSelection(selection);
                }
            } else {
                const projects = await services.listProjects(saved.subscription.id);
                if (projects.ok) {
                    selection = selectSubscription(emptySelection(), saved.subscription);
                    if (projects.data.length) {
                        selection = selectProject(selection, projects.data[0], saved.subscription);
                    }
                    resolved = !!selection.project;
                    services.saveSelection(selection);
                } else if (!seed.project) {
                    selection = selectSubscription(seed, saved.subscription);
                }
            }
        } else {
            const subscriptions = await services.listSubscriptions();
            const subscription = subscriptions.ok
                ? subscriptions.data.find((item) => item.isDefault) || subscriptions.data[0]
                : null;
            if (subscription) {
                const projects = await services.listProjects(subscription.id);
                if (projects.ok) {
                    selection = selectSubscription(emptySelection(), subscription);
                    if (projects.data.length) {
                        selection = selectProject(selection, projects.data[0], subscription);
                    }
                    resolved = !!selection.project;
                    services.saveSelection(selection);
                } else if (!seed.project) {
                    selection = selectSubscription(seed, subscription);
                }
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
