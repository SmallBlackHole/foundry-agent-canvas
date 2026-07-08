import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const COPILOT_HOME = process.env.COPILOT_HOME || join(homedir(), ".copilot");
const EXT_DIR = join(COPILOT_HOME, "extensions", "foundry-agent-canvas");
const STATE_FILE = join(EXT_DIR, "state.json");

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
        mkdirSync(EXT_DIR, { recursive: true });
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
