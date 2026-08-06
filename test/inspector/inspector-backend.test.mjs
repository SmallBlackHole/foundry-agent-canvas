import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

test("Inspector listener does not extend the provider lifetime", async () => {
    const moduleUrl = pathToFileURL(resolve("src/inspector/backend.mjs")).href;
    const script = `
        import { resolve } from "node:path";
        import { createInspectorServer } from ${JSON.stringify(moduleUrl)};

        const { server } = await createInspectorServer({
            uiDir: resolve("inspector-ui"),
            agentPort: 8088,
            onFixRequested() {},
        });
        console.log(server.listening ? "listening" : "not-listening");
    `;

    const { stdout } = await execFileAsync(
        process.execPath,
        ["--input-type=module", "--eval", script],
        { timeout: 5_000 },
    );
    assert.equal(stdout.trim(), "listening");
});
