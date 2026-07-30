// Launches the Foundry hosted agent locally in the Copilot App's integrated
// terminal (the host-provided "terminal" canvas) and reuses an already-running
// terminal/agent so repeated "Inspect locally" clicks don't spawn duplicates
// or collide on the agent's port.
//
// Two host behaviors drive the launch sequence below, both verified against
// the running app:
//   1. The terminal panel is mounted lazily. Opening it with `focus: false`
//      leaves a canvas that `listOpen` reports as open but whose shell never
//      starts, so nothing runs and `send_terminal_input` is silently dropped.
//      Only bringing the panel to the foreground actually starts the shell.
//   2. The `command` passed to `canvas.open` races the shell's own startup
//      (profile scripts, clink/oh-my-posh banners) and is frequently swallowed.
// So we focus the terminal to mount it, wait for the shell, send the run
// command as terminal input, then hand focus back to the builder canvas.

import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import {
    GITHUB_COPILOT_APP_AGENT,
    MICROSOFT_FOUNDRY_CANVAS_ID,
    isGitHubCopilotAppEnvironment,
} from "./agent-canvas-system-message.mjs";
import { isAgentReachable } from "./inspector.mjs";

const TERMINAL_CANVAS_ID = "terminal";
const TERMINAL_INSTANCE_ID_PREFIX = "foundry-agent-run";
const TERMINAL_TITLE = "Foundry agent (local)";

// How long to give the host to mount a freshly focused terminal before we give
// up on sending the run command. Mounting is normally well under a second; the
// budget mostly covers slow shell profiles.
const MOUNT_TIMEOUT_MS = 8_000;
const MOUNT_POLL_INTERVAL_MS = 250;
const SHELL_PROBE_ATTEMPTS = 8;
const SHELL_PROBE_INTERVAL_MS = 100;

// Short window that only collapses rapid duplicate clicks so we don't stack the
// run command onto a launch we issued moments ago. It is intentionally small:
// the host gives us no reliable "process exited" signal, so we can't tell
// "still starting" from "crashed". Re-sending the command after this window is
// safe either way — a still-running azd doesn't read stdin (the line is ignored
// while it keeps running), and a crashed one drops back to a shell prompt so the
// line re-runs and restarts it. A deliberate retry click therefore recovers a
// crashed agent within a few seconds instead of waiting out a long timer.
const RELAUNCH_DEBOUNCE_MS = 4_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Timestamp (ms) of the last time we issued the run command into the terminal.
let commandSentAt = 0;
let lastCommand = "";
// azd project directory of the agent we last launched. Lets a later click on a
// different hosted agent recognise that the process listening on the agent port
// belongs to the previous selection.
let lastProjectDir = "";
let terminalShell = "";
let launchQueue = Promise.resolve();
let terminalInstanceId = "";

// Provider ids are session-scoped and may change when the host reconnects.
const terminalExtensionIds = new WeakMap();

function logTerminal(session, msg, level = "info") {
    try {
        session?.log?.(`[agent-terminal] ${msg}`, { level });
    } catch {
        /* ignore logging failures */
    }
}

function allocateTerminalInstanceId(uuid = randomUUID) {
    terminalInstanceId = `${TERMINAL_INSTANCE_ID_PREFIX}-${uuid()}`;
    return terminalInstanceId;
}

function isOwnedTerminalCanvas(canvas, extensionId) {
    return canvas?.canvasId === TERMINAL_CANVAS_ID
        && (!extensionId || canvas.extensionId === extensionId);
}

async function terminalOwnership(session, extensionId) {
    try {
        const { openCanvases } = await session.rpc.canvas.listOpen();
        const canvas = (openCanvases || []).find((c) => c.instanceId === terminalInstanceId);
        if (!canvas) return "available";
        return isOwnedTerminalCanvas(canvas, extensionId) ? "owned" : "conflict";
    } catch {
        return "unknown";
    }
}

async function ensureTerminalInstanceId(session, extensionId, uuid = randomUUID) {
    if (!terminalInstanceId) allocateTerminalInstanceId(uuid);
    if (await terminalOwnership(session, extensionId) !== "conflict") return terminalInstanceId;

    const conflictedId = terminalInstanceId;
    const replacementId = allocateTerminalInstanceId(uuid);
    logTerminal(
        session,
        `canvas instance ${conflictedId} belongs to another provider; using ${replacementId}`,
        "warn",
    );
    return replacementId;
}

// Whether our tracked terminal canvas is open and still owned by its provider.
async function terminalIsOpen(session, extensionId) {
    return terminalInstanceId
        ? await terminalOwnership(session, extensionId) === "owned"
        : false;
}

// Resolve (and cache) the terminal canvas provider id so open() can disambiguate
// if more than one provider registers a "terminal" canvas. Absence is tolerated:
// canvasId is usually unique, so open() still works without it.
async function resolveTerminalExtensionId(session) {
    if (terminalExtensionIds.has(session)) return terminalExtensionIds.get(session);
    let extensionId = "";
    try {
        const { canvases } = await session.rpc.canvas.list();
        const term = (canvases || []).find((c) => c.canvasId === TERMINAL_CANVAS_ID);
        extensionId = term?.extensionId || "";
    } catch {}
    terminalExtensionIds.set(session, extensionId);
    return extensionId;
}

function openParams(extensionId, input) {
    const params = { canvasId: TERMINAL_CANVAS_ID, instanceId: terminalInstanceId, input };
    if (extensionId) params.extensionId = extensionId;
    return params;
}

async function sendRunCommand(session, command) {
    await session.rpc.canvas.action.invoke({
        instanceId: terminalInstanceId,
        actionName: "send_terminal_input",
        input: { input: command, append_newline: true },
    });
}

function shellProbeMarker(token) {
    return `__FA_${token}__`;
}

export function buildShellProbe(platform, token) {
    if (!/^[a-z0-9]+$/i.test(token)) throw new Error("Invalid shell probe token.");
    const marker = shellProbeMarker(token);
    if (platform === "win32") {
        return `echo ${marker}$($PSVersionTable.PSEdition)%COMSPEC%`;
    }
    if (platform === "darwin" || platform === "linux") {
        return `printf '${marker}%s\\n' "$BASH_VERSION"`;
    }
    return "";
}

export function parseShellProbe(output, platform, token) {
    const marker = shellProbeMarker(token);
    const result = String(output || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .map((line) =>
            line.startsWith("\"") && line.endsWith("\"") ? line.slice(1, -1) : line)
        .find((line) => line.startsWith(marker));
    if (!result) return "";

    const value = result.slice(marker.length);
    if (platform === "win32") {
        if (/^(Desktop|Core)%COMSPEC%$/.test(value)) return "powershell";
        if (
            value.startsWith("$($PSVersionTable.PSEdition)")
            && /[\\/]cmd\.exe$/i.test(value)
        ) return "cmd";
        return "";
    }
    if ((platform === "darwin" || platform === "linux") && value) return "bash";
    return "";
}

async function detectMountedTerminalShell(
    session,
    {
        platform,
        sleep,
        token = randomUUID().slice(0, 8),
        attempts = SHELL_PROBE_ATTEMPTS,
        intervalMs = SHELL_PROBE_INTERVAL_MS,
    },
) {
    const probe = buildShellProbe(platform, token);
    if (!probe) return "";
    try {
        await sendRunCommand(session, probe);
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            const result = await session.rpc.canvas.action.invoke({
                instanceId: terminalInstanceId,
                actionName: "read_terminal_output",
                input: { mode: "since_last_input", tail_lines: 20 },
            });
            const shell = parseShellProbe(
                result?.result?.output ?? result?.output,
                platform,
                token,
            );
            if (shell) return shell;
            await sleep(intervalMs);
        }
    } catch {
        return "";
    }
    return "";
}

// Poll until the host reports a live shell, so the run command is only sent to a
// terminal that can actually receive it.
async function waitForTerminalMount(
    session,
    { terminalRunning, sleep, timeoutMs = MOUNT_TIMEOUT_MS, intervalMs = MOUNT_POLL_INTERVAL_MS },
) {
    const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (await terminalRunning(session)) return true;
        await sleep(intervalMs);
    }
    return false;
}

// Return the user to the builder canvas after focusing the terminal mounted it.
// Best-effort: a failure here only leaves the terminal in the foreground.
async function restoreBuilderFocus(session, builderInstanceId) {
    if (!builderInstanceId) return;
    try {
        await session.rpc.canvas.open({
            canvasId: MICROSOFT_FOUNDRY_CANVAS_ID,
            instanceId: builderInstanceId,
        });
        logTerminal(session, "returned focus to the builder canvas");
    } catch (err) {
        logTerminal(
            session,
            `could not return focus to the builder canvas: ${String(err?.message ?? err)}`,
            "warn",
        );
    }
}

function quotePosixArgument(value) {
    return `'${String(value).replace(/'/g, "'\"'\"'")}'`;
}

function quoteWindowsArgument(value) {
    const text = String(value);
    if (text.includes("\"")) {
        throw new Error("Windows command arguments cannot contain a double quote.");
    }
    return `"${text}"`;
}

function quotePowerShellArgument(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

export function buildAgentRunCommand(
    projectDir,
    platform = process.platform,
    { environment = process.env, shell = "" } = {},
) {
    if (!projectDir || !isAbsolute(projectDir)) {
        throw new Error("The hosted agent project directory must be an absolute path.");
    }
    const cwd = platform === "win32"
        ? quoteWindowsArgument(projectDir)
        : quotePosixArgument(projectDir);
    // `--cwd` gives azd the project containing azure.yaml without depending on
    // the integrated terminal's shell or current directory. Keep the older
    // `--no-inspector` alias for compatibility with azure.ai.agents beta.4;
    // newer extension versions still accept it.
    const command = `azd --cwd ${cwd} ai agent run --no-inspector`;
    if (!isGitHubCopilotAppEnvironment(environment)) return command;

    if (shell === "bash" && (platform === "darwin" || platform === "linux")) {
        return `AI_AGENT=${quotePosixArgument(GITHUB_COPILOT_APP_AGENT)} ${command}`;
    }
    if (shell === "cmd" && platform === "win32") {
        return `cmd.exe /d /s /c "set "AI_AGENT=${GITHUB_COPILOT_APP_AGENT}" && ${command}"`;
    }
    if (shell === "powershell" && platform === "win32") {
        const invocation =
            `& azd --cwd ${quotePowerShellArgument(projectDir)} ai agent run --no-inspector`;
        return `$env:AI_AGENT='${GITHUB_COPILOT_APP_AGENT}'; ${invocation}`;
    }
    return command;
}

// Only one agent can own the agent port, so switching hosted agents means
// waiting for the previous run to let go of it before starting the new one.
async function waitForAgentPortRelease(agentReachable, { attempts = 16, delayMs = 250 } = {}) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (!(await agentReachable())) return true;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return false;
}

/**
 * Ensure the Foundry hosted agent is running locally in the integrated terminal,
 * reusing an existing terminal/agent when possible.
 *
 * @param {object} session - The joined Copilot session (must expose `rpc.canvas`).
 * @param {object} project - Hosted-agent project selected from the workspace.
 * @param {object} dependencies - Optional test dependencies plus the id of the
 *   builder canvas instance that focus is handed back to.
 * @returns {Promise<{ok: boolean, status?: string, error?: string}>}
 *   status is one of: reused | already-running | starting | restarted | launched | switched.
 */
async function launchAgentTerminalOnce(
    session,
    project = {},
    {
        agentReachable = isAgentReachable,
        now = Date.now,
        terminalRunning = isAgentTerminalRunning,
        sleep = defaultSleep,
        builderInstanceId = "",
        waitForPortRelease = waitForAgentPortRelease,
        environment = process.env,
        platform = process.platform,
        shellProbeToken = "",
        instanceIdFactory = randomUUID,
    } = {},
) {
    if (!session?.rpc?.canvas?.open) {
        return { ok: false, error: "Integrated terminal is not available in this host." };
    }

    const extensionId = await resolveTerminalExtensionId(session);
    await ensureTerminalInstanceId(session, extensionId, instanceIdFactory);
    const [ready, mounted] = await Promise.all([
        agentReachable(),
        // Mount state, not `listOpen`: a terminal the host never mounted is
        // reported as open but cannot accept input, and treating it as usable
        // would leave every retry sending commands into the void.
        terminalRunning(session),
    ]);

    // A different hosted agent than the one we last launched: the running agent
    // owns the port, so it has to stop before the newly selected one can start.
    const previousProjectDir = lastProjectDir;
    const switching = !!(
        project.projectDir
        && previousProjectDir
        && project.projectDir !== previousProjectDir
    );

    // Agent already answering on AGENT_PORT — never re-run the command (that
    // would collide on the port). Just reuse whatever is already running.
    if (ready && !switching) {
        const status = mounted ? "reused" : "already-running";
        logTerminal(session, `agent already running — ${status}`);
        return { ok: true, status };
    }

    if (!project.projectDir) {
        return {
            ok: false,
            error:
                "No runnable Foundry hosted agent project was found. "
                + "Add an azure.yaml service with host: azure.ai.agent, then try Inspect locally again.",
        };
    }

    // Agent not up yet, or up for a different hosted agent.
    try {
        logTerminal(
            session,
            `selected hosted agent project: ${project.manifestPath || project.projectDir}`,
        );
        if (project.projects?.length > 1) {
            logTerminal(
                session,
                `found ${project.projects.length} hosted agent projects; using `
                    + `${project.manifestPath || project.projectDir}`,
                "warn",
            );
        }

        if (switching) {
            logTerminal(
                session,
                `hosted agent changed from ${previousProjectDir} to ${project.projectDir}`
                    + " — stopping the previously selected agent",
            );
            // Closing the terminal canvas stops the previous `azd` run and frees
            // the agent port for the newly selected agent.
            await closeAgentTerminal(session);
            if (ready && !(await waitForPortRelease(agentReachable))) {
                return {
                    ok: false,
                    error:
                        "The previously selected agent is still using the local agent port. "
                        + "Stop it in the Foundry agent terminal, then try Inspect locally again.",
                };
            }
        } else if (mounted) {
            const command = buildAgentRunCommand(project.projectDir, platform, {
                environment,
                shell: terminalShell,
            });
            const recentlySent =
                lastCommand === command
                && commandSentAt
                && now() - commandSentAt < RELAUNCH_DEBOUNCE_MS;
            if (recentlySent) {
                // We issued the run command moments ago; let it come up rather
                // than stacking another one on a rapid repeat click.
                logTerminal(session, "terminal open and agent just launched — waiting");
                return { ok: true, status: "starting" };
            }
            // Terminal is live but the agent isn't up and we didn't just launch:
            // (re)run the command in place. Restarts a crashed run; a still-
            // starting run simply ignores the extra stdin line.
            await sendRunCommand(session, command);
            commandSentAt = now();
            lastCommand = command;
            lastProjectDir = project.projectDir;
            logTerminal(session, `re-ran agent command from ${project.projectDir}`);
            return { ok: true, status: "restarted" };
        }

        // No live terminal. Focus it so the host mounts it, and deliberately
        // pass no `command` — see the two host behaviors at the top of the file.
        await session.rpc.canvas.open(
            openParams(extensionId, {
                title: TERMINAL_TITLE,
                placement: { focus: true },
            }),
        );
        if (!(await waitForTerminalMount(session, { terminalRunning, sleep }))) {
            logTerminal(session, "agent terminal did not start after being focused", "error");
            return {
                ok: false,
                error: `The "${TERMINAL_TITLE}" terminal did not start. Open it and run the `
                    + "agent there, then try Inspect locally again.",
            };
        }
        if (isGitHubCopilotAppEnvironment(environment)) {
            terminalShell = await detectMountedTerminalShell(session, {
                platform,
                sleep,
                ...(shellProbeToken ? { token: shellProbeToken } : {}),
            });
            logTerminal(
                session,
                terminalShell
                    ? `detected integrated terminal shell: ${terminalShell}`
                    : "integrated terminal shell was not recognized; launching without App attribution",
                terminalShell ? "info" : "warn",
            );
        }
        const command = buildAgentRunCommand(project.projectDir, platform, {
            environment,
            shell: terminalShell,
        });
        await sendRunCommand(session, command);
        commandSentAt = now();
        lastCommand = command;
        lastProjectDir = project.projectDir;
        logTerminal(session, `opened terminal and launched agent from ${project.projectDir}`);
        // Focusing the terminal took the user off the inspector, so put them
        // back. Cosmetic, and never allowed to fail the launch.
        await restoreBuilderFocus(session, builderInstanceId);
        return { ok: true, status: switching ? "switched" : "launched" };
    } catch (err) {
        const error = String(err?.message ?? err);
        logTerminal(session, `failed to launch agent terminal: ${error}`, "error");
        return { ok: false, error };
    }
}

// Serialize clicks so a second request cannot send an unattributed command while
// the first request is still mounting and probing the dedicated terminal.
export function launchAgentTerminal(session, project = {}, dependencies = {}) {
    const launch = launchQueue.then(() => launchAgentTerminalOnce(session, project, dependencies));
    launchQueue = launch.catch(() => {});
    return launch;
}

/**
 * Whether the agent terminal canvas has actually been mounted by the host and
 * is running a shell.
 *
 * This is stronger than `terminalIsOpen()`: the host creates the terminal panel
 * lazily, so a canvas can be "open" (listed by `listOpen`) while its shell has
 * never started — in which case nothing runs and `send_terminal_input` is
 * silently dropped. `read_terminal_output` is the only signal that
 * distinguishes the two: it throws when the terminal is not running.
 * `mode: "screen"` is used because it is a pure read that does not disturb the
 * `since_last_input` cursor.
 *
 * @param {object} session - The joined Copilot session (must expose `rpc.canvas`).
 * @returns {Promise<boolean>}
 */
export async function isAgentTerminalRunning(session) {
    if (
        !session?.rpc?.canvas?.action?.invoke
        || !session?.rpc?.canvas?.listOpen
    ) return false;
    try {
        const extensionId = await resolveTerminalExtensionId(session);
        await ensureTerminalInstanceId(session, extensionId);
        if (!(await terminalIsOpen(session, extensionId))) return false;
        await session.rpc.canvas.action.invoke({
            instanceId: terminalInstanceId,
            actionName: "read_terminal_output",
            input: { mode: "screen", tail_lines: 1 },
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * Close the agent terminal canvas (which stops the local `azd` agent process,
 * freeing the agent port) and reset launch state so a later click starts
 * cleanly. Call this when the last builder canvas closes. Best-effort: only
 * closes when the terminal is actually open, and swallows close errors.
 *
 * @param {object} session - The joined Copilot session (must expose `rpc.canvas`).
 */
export async function closeAgentTerminal(session) {
    // Reset regardless so a future launch doesn't think it "just launched".
    commandSentAt = 0;
    lastCommand = "";
    lastProjectDir = "";
    terminalShell = "";
    if (!session?.rpc?.canvas?.close) return;
    try {
        const extensionId = await resolveTerminalExtensionId(session);
        const ownership = await terminalOwnership(session, extensionId);
        if (ownership === "available" || ownership === "conflict") {
            terminalInstanceId = "";
            return;
        }
        if (ownership !== "owned") return;
        await session.rpc.canvas.close({ instanceId: terminalInstanceId });
        terminalInstanceId = "";
        logTerminal(session, "closed agent terminal");
    } catch (err) {
        logTerminal(session, `close agent terminal failed: ${String(err?.message ?? err)}`, "warn");
    }
}
