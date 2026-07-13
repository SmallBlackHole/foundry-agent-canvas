import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { project } from "./catalog.mjs";
import {
    getIdentity,
    getDefaultSubscriptionId,
    listProjects,
    getProject,
} from "./foundry.mjs";

const COPILOT_HOME = process.env.COPILOT_HOME || join(homedir(), ".copilot");
const STATE_DIR = join(COPILOT_HOME, "extension-state", "foundry-agent-canvas");
const STATE_FILE = join(STATE_DIR, "state.json");

export function loadSelection() {
    try {
        if (!existsSync(STATE_FILE)) return null;
        const data = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
        if (data && typeof data === "object") return data;
    } catch {
        /* ignore a corrupt/unreadable store */
    }
    return null;
}

export function saveSelection(sel) {
    try {
        mkdirSync(STATE_DIR, { recursive: true });
        writeFileSync(STATE_FILE, JSON.stringify(sel ?? {}, null, 2), "utf-8");
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

export const PAGES = ["build"];

// Retained for the provider process lifetime because the host may reload a
// cached canvas URL without invoking the provider's open handler again.
export const servers = new Map(); // instanceId -> { server, url, state, sseClients:Set }

export function defaultState() {
    return {
        page: "build",
        agentName: "",
        project: { ...project, rg: "", account: "" },
        projectEndpoint: "",
        projectLocation: "",
        subscriptionId: "",
        bootstrapped: false,
        model: { name: "", color: "#10a37f" },
    };
}

export function applyInput(state, input) {
    if (!input || typeof input !== "object") return state;
    if (typeof input.page === "string" && PAGES.includes(input.page)) state.page = input.page;
    if (typeof input.agentName === "string" && input.agentName.trim()) state.agentName = input.agentName.trim();
    if (typeof input.projectEndpoint === "string" && input.projectEndpoint.trim()) {
        state.projectEndpoint = input.projectEndpoint.trim();
    }
    if (typeof input.projectName === "string" && input.projectName.trim()) {
        state.project = { ...state.project, name: input.projectName.trim() };
    }
    if (typeof input.model === "string" && input.model.trim()) {
        state.model = { name: input.model.trim(), color: "#10a37f" };
    }
    return state;
}

export async function bootstrapInstance(entry) {
    const identity = await getIdentity();
    let resolved = false;
    if (identity.signedIn) {
        const saved = loadSelection();
        if (saved && saved.subscriptionId) {
            entry.state.subscriptionId = saved.subscriptionId;
            identity.subscriptionId = saved.subscriptionId;
            if (saved.subscriptionName) identity.subscriptionName = saved.subscriptionName;
            if (saved.projectEndpoint) {
                entry.state.projectEndpoint = saved.projectEndpoint;
                entry.state.projectLocation = saved.projectLocation || "";
                let rg = saved.projectRg || "";
                let account = saved.projectAccount || "";
                const projName = saved.projectName || getProject(saved.projectEndpoint).projectName || "";
                if (!account && saved.projectEndpoint) {
                    account = getProject(saved.projectEndpoint).resourceName || "";
                }
                if ((!rg || !account) && saved.subscriptionId) {
                    const proj = await listProjects(saved.subscriptionId);
                    if (proj.ok) {
                        const ep = saved.projectEndpoint.replace(/\/+$/, "");
                        const match = (proj.data || []).find((p) => p.endpoint.replace(/\/+$/, "") === ep);
                        if (match) {
                            rg = match.rg || rg;
                            account = match.account || account;
                        }
                    }
                }
                if ((rg && !saved.projectRg) || (account && !saved.projectAccount)) {
                    saveSelection({ ...saved, projectRg: rg, projectAccount: account });
                }
                entry.state.project = {
                    ...entry.state.project,
                    name: projName,
                    rg,
                    account,
                };
                resolved = true;
            } else {
                entry.state.projectEndpoint = "";
                entry.state.projectLocation = "";
                entry.state.project = { ...entry.state.project, name: "" };
            }
        } else {
            const subId = identity.subscriptionId || getDefaultSubscriptionId();
            if (subId) {
                entry.state.subscriptionId = subId;
                identity.subscriptionId = subId;
                const proj = await listProjects(subId);
                if (proj.ok && proj.data.length) {
                    const first = proj.data[0];
                    entry.state.projectEndpoint = first.endpoint;
                    entry.state.projectLocation = first.location || "";
                    entry.state.project = { ...entry.state.project, name: first.name, rg: first.rg || "", account: first.account || "" };
                    resolved = true;
                } else {
                    entry.state.projectEndpoint = "";
                    entry.state.projectLocation = "";
                    entry.state.project = { ...entry.state.project, name: "" };
                }
            }
        }
    }
    entry.state.bootstrapped = true;
    const p = getProject(entry.state.projectEndpoint);
    return {
        identity,
        subscriptionId: entry.state.subscriptionId,
        resolved,
        project: { name: p.projectName || entry.state.project?.name || "", endpoint: p.endpoint, rg: entry.state.project?.rg || "", account: entry.state.project?.account || "" },
    };
}
