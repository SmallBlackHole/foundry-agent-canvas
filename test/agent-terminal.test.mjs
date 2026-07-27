import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";

import {
    buildAgentRunCommand,
    closeAgentTerminal,
    isAgentTerminalRunning,
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

test("mounts the terminal by focusing it, then sends the run command and restores focus", async () => {
    let mounted = false;
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
                        openCanvases: mounted
                            ? [{ canvasId: "terminal", instanceId: "foundry-agent-run" }]
                            : [],
                    };
                },
                async list() {
                    return { canvases: [{ canvasId: "terminal", extensionId: "terminal-ext" }] };
                },
                async open(params) {
                    opened.push(params);
                    // The host only starts the shell once the panel is focused.
                    if (params.canvasId === "terminal" && params.input?.placement?.focus) mounted = true;
                },
                action: {
                    async invoke(params) {
                        invoked.push(params);
                    },
                },
                async close() {
                    mounted = false;
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
    const command = buildAgentRunCommand(alphaProjectDir);
    const dependencies = {
        agentReachable: async () => false,
        terminalRunning: async () => mounted,
        sleep: async () => {},
        builderInstanceId: "foundry-agent-builder",
        now: () => 1_000,
    };

    try {
        assert.deepEqual(
            await launchAgentTerminal(session, project, dependencies),
            { ok: true, status: "launched" },
        );

        // The terminal is focused to mount it, and deliberately carries no
        // `command` because the host races it against the shell's startup.
        assert.equal(opened[0].canvasId, "terminal");
        assert.equal(opened[0].extensionId, "terminal-ext");
        assert.equal(opened[0].input.placement.focus, true);
        assert.equal(opened[0].input.command, undefined);
        // The command arrives as terminal input, once the shell is confirmed up.
        assert.equal(invoked.at(-1).actionName, "send_terminal_input");
        assert.equal(invoked.at(-1).input.input, command);
        // Focus goes back to the builder canvas.
        assert.equal(opened[1].canvasId, "agent-builder");
        assert.equal(opened[1].instanceId, "foundry-agent-builder");
        assert.equal(opened[1].input, undefined);
        assert.ok(logs.some(({ options }) => options?.level === "warn"));

        // Terminal is live now, so a later click re-sends in place instead of
        // stealing focus again.
        const openCount = opened.length;
        assert.deepEqual(
            await launchAgentTerminal(session, project, { ...dependencies, now: () => 6_000 }),
            { ok: true, status: "restarted" },
        );
        assert.equal(opened.length, openCount);
        assert.equal(invoked.at(-1).input.input, command);
    } finally {
        await closeAgentTerminal(session);
    }
});

test("collapses a rapid second click while the agent is still coming up", async () => {
    const invoked = [];
    const session = {
        log() {},
        rpc: {
            canvas: {
                async listOpen() {
                    return { openCanvases: [] };
                },
                async list() {
                    return { canvases: [] };
                },
                async open() {},
                action: {
                    async invoke(params) {
                        invoked.push(params);
                    },
                },
                async close() {},
            },
        },
    };
    const project = { projectDir: resolve("workspace", "apps", "alpha"), projects: [] };
    const dependencies = {
        agentReachable: async () => false,
        terminalRunning: async () => true,
        sleep: async () => {},
    };

    try {
        assert.deepEqual(
            await launchAgentTerminal(session, project, { ...dependencies, now: () => 1_000 }),
            { ok: true, status: "restarted" },
        );
        assert.equal(invoked.length, 1);
        // Within the debounce window nothing else is sent.
        assert.deepEqual(
            await launchAgentTerminal(session, project, { ...dependencies, now: () => 2_000 }),
            { ok: true, status: "starting" },
        );
        assert.equal(invoked.length, 1);
    } finally {
        await closeAgentTerminal(session);
    }
});

test("reports a terminal that never starts instead of sending into the void", async () => {
    const invoked = [];
    const session = {
        log() {},
        rpc: {
            canvas: {
                async listOpen() {
                    return { openCanvases: [] };
                },
                async list() {
                    return { canvases: [] };
                },
                async open() {},
                action: {
                    async invoke(params) {
                        invoked.push(params);
                    },
                },
                async close() {},
            },
        },
    };

    try {
        const result = await launchAgentTerminal(
            session,
            { projectDir: resolve("workspace", "apps", "alpha"), projects: [] },
            {
                agentReachable: async () => false,
                terminalRunning: async () => false, // never mounts
                sleep: async () => {},
            },
        );
        assert.equal(result.ok, false);
        assert.match(result.error, /terminal did not start/);
        assert.equal(invoked.length, 0);
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

test("detects a terminal that the host has not mounted yet", async () => {
    const invoked = [];
    const running = {
        rpc: {
            canvas: {
                action: {
                    async invoke(params) {
                        invoked.push(params);
                        return { output: "" };
                    },
                },
            },
        },
    };
    const notMounted = {
        rpc: {
            canvas: {
                action: {
                    async invoke() {
                        throw new Error("Terminal not found or not running");
                    },
                },
            },
        },
    };

    assert.equal(await isAgentTerminalRunning(running), true);
    assert.equal(invoked[0].instanceId, "foundry-agent-run");
    assert.equal(invoked[0].actionName, "read_terminal_output");
    assert.equal(invoked[0].input.mode, "screen");
    assert.equal(await isAgentTerminalRunning(notMounted), false);
    assert.equal(await isAgentTerminalRunning({}), false);
});
