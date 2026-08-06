import http from "node:http";
import https from "node:https";

import { createHttpHeaders } from "@azure/core-rest-pipeline";

function responseHeaders(headers) {
    const result = createHttpHeaders();
    for (const [name, value] of Object.entries(headers || {})) {
        if (Array.isArray(value)) {
            if (value.length) result.set(name, value[0]);
        } else if (value !== undefined) {
            result.set(name, String(value));
        }
    }
    return result;
}

function requestBody(body) {
    const value = typeof body === "function" ? body() : body;
    if (
        value === undefined
        || value === null
        || typeof value === "string"
        || Buffer.isBuffer(value)
        || value instanceof Uint8Array
    ) {
        return value;
    }
    return String(value);
}

export function createUnrefHttpClient({ timeoutMs = 5_000 } = {}) {
    return {
        sendRequest(request) {
            return new Promise((resolve, reject) => {
                const target = new URL(request.url);
                const transport = target.protocol === "http:" ? http : https;
                const body = requestBody(request.body);
                const req = transport.request({
                    protocol: target.protocol,
                    hostname: target.hostname,
                    port: target.port || undefined,
                    path: `${target.pathname}${target.search}`,
                    method: request.method,
                    headers: request.headers.toJSON({ preserveCase: true }),
                    agent: false,
                }, (res) => {
                    res.socket?.unref();
                    const chunks = [];
                    res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
                    res.on("end", () => {
                        resolve({
                            request,
                            status: res.statusCode || 0,
                            headers: responseHeaders(res.headers),
                            bodyAsText: Buffer.concat(chunks).toString("utf-8"),
                        });
                    });
                    res.on("error", reject);
                });

                const onAbort = () => req.destroy(new Error("telemetry_aborted"));
                if (request.abortSignal) {
                    if (request.abortSignal.aborted) {
                        onAbort();
                    } else {
                        request.abortSignal.addEventListener("abort", onAbort, { once: true });
                    }
                }
                req.once("socket", (socket) => socket.unref());
                req.once("error", reject);
                req.once("close", () => {
                    request.abortSignal?.removeEventListener?.("abort", onAbort);
                });
                req.setTimeout(timeoutMs, () => req.destroy(new Error("telemetry_timeout")));
                req.end(body);
            });
        },
    };
}
