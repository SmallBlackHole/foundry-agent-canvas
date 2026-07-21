import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ttf": "font/ttf",
};

const numFromEnv = (name, fallback) => {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export const SSE_HEARTBEAT_MS = numFromEnv("FOUNDRY_CANVAS_SSE_HEARTBEAT_MS", 20_000);

export function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
    });
    res.end(payload);
}

export function serveStatic(res, fileName, publicDir) {
    return serveFile(res, join(publicDir, fileName));
}

export function serveFile(res, filePath) {
    try {
        const ext = filePath.slice(filePath.lastIndexOf("."));
        const body = readFileSync(filePath);
        res.writeHead(200, { "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream" });
        res.end(body);
        return true;
    } catch {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return false;
    }
}

export function pushFrame(entry, obj) {
    const frame = `data: ${JSON.stringify(obj)}\n\n`;
    let delivered = 0;
    for (const client of entry.sseClients) {
        try {
            client.write(frame);
            delivered += 1;
        } catch {
            /* drop broken client */
        }
    }
    return delivered;
}
