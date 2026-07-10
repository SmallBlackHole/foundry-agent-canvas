import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
};

const numFromEnv = (name, fallback) => {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export const SSE_HEARTBEAT_MS = numFromEnv("FOUNDRY_CANVAS_SSE_HEARTBEAT_MS", 20_000);

export function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
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

export function readBody(req, limit = 1_000_000) {
    return new Promise((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => {
            data += chunk;
            if (data.length > limit) {
                reject(new Error("Body too large"));
                req.destroy();
            }
        });
        req.on("end", () => resolve(data));
        req.on("error", reject);
    });
}

export function pushNavigate(entry, page) {
    const frame = `data: ${JSON.stringify({ type: "navigate", page })}\n\n`;
    for (const client of entry.sseClients) {
        try {
            client.write(frame);
        } catch {
            /* drop broken client */
        }
    }
}

export function pushSetProtocol(entry, protocol) {
    const frame = `data: ${JSON.stringify({ type: "setProtocol", protocol })}\n\n`;
    for (const client of entry.sseClients) {
        try {
            client.write(frame);
        } catch {
            /* drop broken client */
        }
    }
}

export function pushFrame(entry, obj) {
    const frame = `data: ${JSON.stringify(obj)}\n\n`;
    for (const client of entry.sseClients) {
        try {
            client.write(frame);
        } catch {
            /* drop broken client */
        }
    }
}
