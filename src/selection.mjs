import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const EXT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SELECTION_FILE = join(EXT_DIR, ".selection.json");

export function loadSelection() {
    try {
        if (!existsSync(SELECTION_FILE)) return null;
        const data = JSON.parse(readFileSync(SELECTION_FILE, "utf-8"));
        if (data && typeof data === "object") return data;
    } catch {
        /* ignore a corrupt/unreadable store */
    }
    return null;
}

export function saveSelection(sel) {
    try {
        writeFileSync(SELECTION_FILE, JSON.stringify(sel ?? {}, null, 2), "utf-8");
    } catch {
        /* best-effort persistence */
    }
}

export function clearSelection() {
    try {
        if (existsSync(SELECTION_FILE)) writeFileSync(SELECTION_FILE, "{}", "utf-8");
    } catch {
        /* ignore */
    }
}
