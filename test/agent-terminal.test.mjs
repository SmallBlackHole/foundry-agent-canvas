import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";

import {
    buildAgentRunCommand,
    closeAgentTerminal,
    launchAgentTerminal,
} from "../src/agent-terminal.mjs";

test("builds an azd command with a native absolute project directory", () => {
    const projectDir = resolve("workspace", "Agent Projects", "support");
    const quotedProjectDir = process.platform === "win32"
        ? `"${projectDir}"`
        : `'${projectDir}'`;

    assert.equal(
        buildAgentRunCommand(projectDir),
        `azd --cwd ${quotedProjectDir} ai agent run --no-inspector`,
    );
});

test("quotes Windows project directories", { skip: process.platform !== "win32" }, () => {
    assert.equal(
        buildAgentRunCommand("C:\\workspace\\Agent Projects\\support", "win32"),
        "azd --cwd \"C:\\workspace\\Agent Projects\\support\" ai agent run --no-inspector",
    );
});

test("quotes POSIX project directories", { skip: process.platform === "win32" }, () => {
    assert.equal(
        buildAgentRunCommand("/workspace/customer's agent", "linux"),
        "azd --cwd '/workspace/customer'\"'\"'s agent' ai agent run --no-inspector",
    );
});

test("rejects relative project directories", () => {
    assert.throws(
        () => buildAgentRunCommand("relative-agent", "linux"),
        /must be an absolute path/,
    );
});

test("opens and retries the terminal with the selected nested project", async () => {
    let open = false;
    const opened = [];
    const invoked = [];
    const logs = [];
    const session = {
        log(message, options) {
            logs.push({ message, options });
        },
        rpc: {
            canvas: {
                async listOpen() {
                    return {
                        openCanvases: open
                            ? [{ canvasId: "terminal", instanceId: "foundry-agent-run" }]
                            : [],
                    };
                },
                async list() {
                    return { canvases: [{ canvasId: "terminal", extensionId: "terminal-ext" }] };
                },
                async open(params) {
                    opened.push(params);
                    open = true;
                },
                action: {
                    async invoke(params) {
                        invoked.push(params);
                    },
                },
                async close() {
                    open = false;
                },
            },
        },
    };
    const alphaProjectDir = resolve("workspace", "apps", "alpha");
    const project = {
        projectDir: alphaProjectDir,
        manifestPath: join(alphaProjectDir, "azure.yaml"),
        projects: [
            { projectDir: alphaProjectDir },
            { projectDir: resolve("workspace", "apps", "zeta") },
        ],
    };

    try {
        assert.deepEqual(
            await launchAgentTerminal(session, project, {
                agentReachable: async () => false,
                now: () => 1_000,
            }),
            { ok: true, status: "launched" },
        );
        assert.equal(
            opened[0].input.command,
            buildAgentRunCommand(alphaProjectDir),
        );
        assert.equal(opened[0].extensionId, "terminal-ext");

        assert.deepEqual(
            await launchAgentTerminal(session, project, {
                agentReachable: async () => false,
                now: () => 6_000,
            }),
            { ok: true, status: "restarted" },
        );
        assert.equal(invoked[0].input.input, opened[0].input.command);
        assert.ok(logs.some(({ options }) => options?.level === "warn"));
    } finally {
        await closeAgentTerminal(session);
    }
});

test("allows an already-running agent without a discovered project", async () => {
    const session = {
        rpc: {
            canvas: {
                async listOpen() {
                    return { openCanvases: [] };
                },
                async list() {
                    return { canvases: [] };
                },
                async open() {
                    throw new Error("should not open");
                },
            },
        },
    };

    assert.deepEqual(
        await launchAgentTerminal(session, {}, { agentReachable: async () => true }),
        { ok: true, status: "already-running" },
    );
});

test("reports a missing runnable azd project before opening a terminal", async () => {
    let opened = false;
    const session = {
        rpc: {
            canvas: {
                async listOpen() {
                    return { openCanvases: [] };
                },
                async list() {
                    return { canvases: [] };
                },
                async open() {
                    opened = true;
                },
            },
        },
    };

    const result = await launchAgentTerminal(
        session,
        {},
        { agentReachable: async () => false },
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /No runnable Foundry hosted agent project was found/);
    assert.equal(opened, false);
});
