import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

const COPILOT_HOME = process.env.COPILOT_HOME || join(homedir(), ".copilot");
const ARTIFACTS_DIR = join(COPILOT_HOME, "extensions", "foundry-agent-canvas", "artifacts");

function selectionFileFor(workspacePath) {
    if (!workspacePath) return join(ARTIFACTS_DIR, "selection.json");
    const hash = createHash("sha256").update(resolve(workspacePath)).digest("hex").slice(0, 12);
    return join(ARTIFACTS_DIR, `selection-${hash}.json`);
}

let _workspacePath = "";

export function setSelectionWorkspace(workspacePath) {
    _workspacePath = workspacePath || "";
}

export function loadSelection() {
    try {
        const file = selectionFileFor(_workspacePath);
        if (!existsSync(file)) return null;
        const data = JSON.parse(readFileSync(file, "utf-8"));
        if (data && typeof data === "object") return data;
    } catch {
        /* ignore a corrupt/unreadable store */
    }
    return null;
}

export function saveSelection(sel) {
    try {
        mkdirSync(ARTIFACTS_DIR, { recursive: true });
        writeFileSync(selectionFileFor(_workspacePath), JSON.stringify(sel ?? {}, null, 2), "utf-8");
    } catch {
        /* best-effort persistence */
    }
}

export function clearSelection() {
    try {
        const file = selectionFileFor(_workspacePath);
        if (existsSync(file)) writeFileSync(file, "{}", "utf-8");
    } catch {
        /* ignore */
    }
}
