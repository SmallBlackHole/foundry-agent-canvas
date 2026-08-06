import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

test("an in-flight Azure Monitor export does not extend provider lifetime", async () => {
    const bundleDir = await mkdtemp(join(tmpdir(), "foundry-canvas-telemetry-bundle-"));
    const bundlePath = join(bundleDir, "telemetry.mjs");
    await build({
        entryPoints: [resolve("src/telemetry/index.mjs")],
        outfile: bundlePath,
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node20.19",
        banner: {
            js: "import { createRequire as __cliCreateRequire } from 'node:module'; const require = __cliCreateRequire(import.meta.url);",
        },
        logLevel: "silent",
    });
    const sockets = new Set();
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        // Deliberately never answer the HTTP request.
    });
    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const moduleUrl = pathToFileURL(bundlePath).href;
    const connectionString = [
        "InstrumentationKey=00000000-0000-0000-0000-000000000001",
        `IngestionEndpoint=http://127.0.0.1:${server.address().port}`,
    ].join(";");
    const script = `
        import { createCanvasTelemetry } from ${JSON.stringify(moduleUrl)};
        const telemetry = createCanvasTelemetry({
            env: {
                FOUNDRY_CANVAS_APPINSIGHTS_CONNECTION_STRING:
                    ${JSON.stringify(connectionString)},
            },
            productVersion: "test",
        });
        telemetry.recordAction({ action: "report_issue" });
    `;

    try {
        const child = spawn(
            process.execPath,
            ["--input-type=module", "--eval", script],
            { stdio: "ignore" },
        );
        const result = await Promise.race([
            new Promise((resolveExit) => {
                child.once("exit", (code, signal) => {
                    resolveExit({ exited: true, code, signal });
                });
            }),
            new Promise((resolveTimeout) => {
                const timer = setTimeout(
                    () => resolveTimeout({ exited: false }),
                    5_000,
                );
                timer.unref?.();
            }),
        ]);
        if (!result.exited) child.kill();
        assert.deepEqual(result, { exited: true, code: 0, signal: null });
    } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolveClose) => server.close(resolveClose));
        await rm(bundleDir, { recursive: true, force: true });
    }
});
