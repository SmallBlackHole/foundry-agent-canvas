import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";

import {
    buildAgentRunCommand,
    buildShellProbe,
    closeAgentTerminal,
    isAgentTerminalRunning,
    launchAgentTerminal,
    parseShellProbe,
} from "../src/agent-terminal.mjs";
import { GITHUB_COPILOT_APP_AGENT } from "../src/agent-canvas-system-message.mjs";

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

test("detects CMD, PowerShell, and Bash probe output", () => {
    const token = "abc123";
    assert.equal(
        buildShellProbe("win32", token),
        "echo __FA_abc123__$($PSVersionTable.PSEdition)%COMSPEC%",
    );
    assert.equal(
        parseShellProbe(
            "C:\\>echo __FA_abc123__$($PSVersionTable.PSEdition)%COMSPEC%\r\n"
                + "__FA_abc123__$($PSVersionTable.PSEdition)"
                + "C:\\Windows\\System32\\cmd.exe\r\n",
            "win32",
            token,
        ),
        "cmd",
    );
    assert.equal(
        parseShellProbe(
            "PS C:\\> echo __FA_abc123__$($PSVersionTable.PSEdition)%COMSPEC%\r\n"
                + "__FA_abc123__Core%COMSPEC%\r\n",
            "win32",
            token,
        ),
        "powershell",
    );
    assert.equal(
        buildShellProbe("linux", token),
        "printf '__FA_abc123__%s\\n' \"$BASH_VERSION\"",
    );
    assert.equal(
        parseShellProbe("__FA_abc123__5.2.26(1)-release\n", "linux", token),
        "bash",
    );
});

test("treats unsupported or ambiguous shell probes as unknown", () => {
    assert.equal(parseShellProbe("__FA_abc123__\n", "darwin", "abc123"), "");
    assert.equal(parseShellProbe("__FA_abc123__/bin/fish\n", "win32", "abc123"), "");
    assert.equal(
        parseShellProbe("__FA_abc123__%COMSPEC%\n", "win32", "abc123"),
        "",
    );
    assert.equal(buildShellProbe("freebsd", "abc123"), "");
});

test("builds Bash-scoped App commands", { skip: process.platform === "win32" }, () => {
    const environment = { AI_AGENT: GITHUB_COPILOT_APP_AGENT };
    assert.equal(
        buildAgentRunCommand("/workspace/support", "linux", { environment, shell: "bash" }),
        "AI_AGENT='github_copilot_app_agent' "
            + "azd --cwd '/workspace/support' ai agent run --no-inspector",
    );
});

test("builds Windows shell-scoped App commands", { skip: process.platform !== "win32" }, () => {
    const environment = { AI_AGENT: GITHUB_COPILOT_APP_AGENT };
    assert.equal(
        buildAgentRunCommand("C:\\workspace\\support", "win32", { environment, shell: "cmd" }),
        "cmd.exe /d /s /c \"set \"AI_AGENT=github_copilot_app_agent\" && "
            + "azd --cwd \"C:\\workspace\\support\" ai agent run --no-inspector\"",
    );
    assert.equal(
        buildAgentRunCommand(
            "C:\\workspace\\customer's support",
            "win32",
            { environment, shell: "powershell" },
        ),
        "$env:AI_AGENT='github_copilot_app_agent'; "
            + "& azd --cwd 'C:\\workspace\\customer''s support' ai agent run --no-inspector",
    );
});

test("leaves unknown shells and non-App launches unmarked", () => {
    const projectDir = resolve("workspace", "support");
    const platform = process.platform;
    const quotedProjectDir = platform === "win32"
        ? `"${projectDir}"`
        : `'${projectDir}'`;
    const command =
        `azd --cwd ${quotedProjectDir} ai agent run --no-inspector`;

    assert.equal(
        buildAgentRunCommand(projectDir, platform, {
            environment: { AI_AGENT: GITHUB_COPILOT_APP_AGENT },
            shell: "",
        }),
        command,
    );
    assert.equal(
        buildAgentRunCommand(projectDir, platform, {
            environment: { AI_AGENT: "github_copilot_cli" },
            shell: platform === "win32" ? "cmd" : "bash",
        }),
        command,
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
        environment: {},
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

test("detects CMD in a new App terminal before launching azd with attribution", async () => {
    let mounted = false;
    const sent = [];
    const token = "abc123";
    const session = {
        log() {},
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
                    return { canvases: [] };
                },
                async open() {
                    mounted = true;
                },
                action: {
                    async invoke(params) {
                        if (params.actionName === "send_terminal_input") {
                            sent.push(params.input.input);
                            return {};
                        }
                        if (params.actionName === "read_terminal_output") {
                            return {
                                result: {
                                    output:
                                        `__FA_${token}__$($PSVersionTable.PSEdition)`
                                        + "C:\\Windows\\System32\\cmd.exe\r\n",
                                },
                            };
                        }
                        return {};
                    },
                },
                async close() {
                    mounted = false;
                },
            },
        },
    };
    const projectDir = resolve("workspace", "apps", "alpha");
    const environment = { AI_AGENT: GITHUB_COPILOT_APP_AGENT };

    try {
        assert.deepEqual(
            await launchAgentTerminal(
                session,
                { projectDir, projects: [] },
                {
                    agentReachable: async () => false,
                    terminalRunning: async () => mounted,
                    sleep: async () => {},
                    environment,
                    platform: "win32",
                    shellProbeToken: token,
                },
            ),
            { ok: true, status: "launched" },
        );
        assert.deepEqual(sent, [
            buildShellProbe("win32", token),
            buildAgentRunCommand(projectDir, "win32", { environment, shell: "cmd" }),
        ]);
    } finally {
        await closeAgentTerminal(session);
    }
});

test("falls back to an unmarked command when the App terminal shell is unknown", async () => {
    let mounted = false;
    const sent = [];
    const token = "unknown123";
    const session = {
        log() {},
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
                    return { canvases: [] };
                },
                async open() {
                    mounted = true;
                },
                action: {
                    async invoke(params) {
                        if (params.actionName === "send_terminal_input") {
                            sent.push(params.input.input);
                            return {};
                        }
                        return {
                            result: {
                                output: `__FA_${token}__/bin/fish\n`,
                            },
                        };
                    },
                },
                async close() {
                    mounted = false;
                },
            },
        },
    };
    const projectDir = resolve("workspace", "apps", "alpha");

    try {
        assert.deepEqual(
            await launchAgentTerminal(
                session,
                { projectDir, projects: [] },
                {
                    agentReachable: async () => false,
                    terminalRunning: async () => mounted,
                    sleep: async () => {},
                    environment: { AI_AGENT: GITHUB_COPILOT_APP_AGENT },
                    platform: "win32",
                    shellProbeToken: token,
                },
            ),
            { ok: true, status: "launched" },
        );
        assert.deepEqual(sent, [
            buildShellProbe("win32", token),
            buildAgentRunCommand(projectDir, "win32", { environment: {}, shell: "" }),
        ]);
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
        environment: {},
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

test("switching hosted agents stops the previous run before starting the new one", async () => {
    let mounted = false;
    let running = false;
    const closed = [];
    const sent = [];
    const session = {
        log() {},
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
                    return { canvases: [] };
                },
                async open() {
                    mounted = true;
                },
                action: {
                    async invoke(params) {
                        if (params.actionName === "send_terminal_input") sent.push(params.input.input);
                    },
                },
                async close(params) {
                    closed.push(params);
                    mounted = false;
                    running = false;
                },
            },
        },
    };
    const alpha = { projectDir: resolve("workspace", "apps", "alpha"), manifestPath: "" };
    const zeta = { projectDir: resolve("workspace", "apps", "zeta"), manifestPath: "" };
    const dependencies = {
        agentReachable: async () => running,
        terminalRunning: async () => mounted,
        sleep: async () => {},
        now: () => 1_000,
        environment: {},
    };

    try {
        assert.deepEqual(
            await launchAgentTerminal(session, alpha, dependencies),
            { ok: true, status: "launched" },
        );
        running = true;

        // Same agent: the running process is reused rather than restarted.
        assert.deepEqual(
            await launchAgentTerminal(session, alpha, dependencies),
            { ok: true, status: "reused" },
        );
        assert.deepEqual(sent, [buildAgentRunCommand(alpha.projectDir)]);

        assert.deepEqual(
            await launchAgentTerminal(session, zeta, dependencies),
            { ok: true, status: "switched" },
        );
        // The previous run is closed so it lets go of the agent port, then the
        // newly selected agent is started in a fresh terminal.
        assert.deepEqual(closed, [{ instanceId: "foundry-agent-run" }]);
        assert.deepEqual(sent, [
            buildAgentRunCommand(alpha.projectDir),
            buildAgentRunCommand(zeta.projectDir),
        ]);
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

test("reports when the previously selected agent keeps holding the agent port", async () => {
    let mounted = false;
    let launched = false;
    const session = {
        log() {},
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
                    return { canvases: [] };
                },
                async open() {
                    if (launched) throw new Error("must not start a second agent on a busy port");
                    mounted = true;
                },
                action: { async invoke() {} },
                async close() {
                    mounted = false;
                },
            },
        },
    };
    const alpha = { projectDir: resolve("workspace", "apps", "alpha"), manifestPath: "" };
    const zeta = { projectDir: resolve("workspace", "apps", "zeta"), manifestPath: "" };

    try {
        await launchAgentTerminal(session, alpha, {
            agentReachable: async () => false,
            terminalRunning: async () => mounted,
            sleep: async () => {},
            now: () => 1_000,
            environment: {},
        });
        launched = true;
        const result = await launchAgentTerminal(session, zeta, {
            agentReachable: async () => true,
            terminalRunning: async () => mounted,
            sleep: async () => {},
            now: () => 9_000,
            waitForPortRelease: async () => false,
            environment: {},
        });
        assert.equal(result.ok, false);
        assert.match(result.error, /still using the local agent port/);
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
