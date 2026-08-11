import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRequestHandler } from "../../src/routes.mjs";

function response() {
    return {
        body: "",
        headers: {},
        status: 0,
        writeHead(status, headers = {}) {
            this.status = status;
            this.headers = headers;
        },
        end(body = "") {
            this.body = String(body);
        },
    };
}

test("serves allowlisted client modules without exposing arbitrary paths", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "microsoft-foundry-client-modules-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const publicDir = join(root, "public");
    await mkdir(join(publicDir, "app"), { recursive: true });
    await writeFile(
        join(publicDir, "app", "runtime.js"),
        'export const ready = true;\n',
    );
    await writeFile(
        join(publicDir, "telemetry-constants.js"),
        'export const TELEMETRY_ACTION = {};\n',
    );

    const handler = createRequestHandler("client-modules-test", {
        session: { log: async () => {} },
        publicDir,
        extDir: root,
        inspectorUiDir: "",
        workspaceRootFn: async () => root,
    });

    const moduleResponse = response();
    await handler(
        { method: "GET", url: "/app/runtime.js" },
        moduleResponse,
    );
    assert.equal(moduleResponse.status, 200);
    assert.match(
        moduleResponse.headers["Content-Type"],
        /text\/javascript/,
    );
    assert.equal(moduleResponse.body, "export const ready = true;\n");

    const constantsResponse = response();
    await handler(
        { method: "GET", url: "/telemetry-constants.js" },
        constantsResponse,
    );
    assert.equal(constantsResponse.status, 200);
    assert.match(
        constantsResponse.headers["Content-Type"],
        /text\/javascript/,
    );
    assert.equal(
        constantsResponse.body,
        "export const TELEMETRY_ACTION = {};\n",
    );

    const nestedResponse = response();
    await handler(
        { method: "GET", url: "/app/nested/runtime.js" },
        nestedResponse,
    );
    assert.equal(nestedResponse.status, 404);
});
