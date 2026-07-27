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

import { isAbsolute } from "node:path";

import { MICROSOFT_FOUNDRY_CANVAS_ID } from "./agent-canvas-system-message.mjs";
import { isAgentReachable } from "./inspector.mjs";

// Stable instance id for our agent terminal so re-opening focuses the same
// panel instead of creating a new one each click.
const TERMINAL_CANVAS_ID = "terminal";
const TERMINAL_INSTANCE_ID = "foundry-agent-run";
const TERMINAL_TITLE = "Foundry agent (local)";

// How long to give the host to mount a freshly focused terminal before we give
// up on sending the run command. Mounting is normally well under a second; the
// budget mostly covers slow shell profiles.
const MOUNT_TIMEOUT_MS = 8_000;
const MOUNT_POLL_INTERVAL_MS = 250;

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

// Cached extension id of the host terminal canvas (resolved once via list()).
// `undefined` = not yet resolved; string ("" allowed) = resolved.
let terminalExtensionId;

function logTerminal(session, msg, level = "info") {
    try {
        session?.log?.(`[agent-terminal] ${msg}`, { level });
    } catch {
        /* ignore logging failures */
    }
}

// Whether our agent terminal canvas instance is currently open.
async function terminalIsOpen(session) {
    try {
        const { openCanvases } = await session.rpc.canvas.listOpen();
        return (openCanvases || []).some(
            (c) => c.instanceId === TERMINAL_INSTANCE_ID && c.canvasId === TERMINAL_CANVAS_ID,
        );
    } catch {
        return false;
    }
}

// Resolve (and cache) the terminal canvas provider id so open() can disambiguate
// if more than one provider registers a "terminal" canvas. Absence is tolerated:
// canvasId is usually unique, so open() still works without it.
async function resolveTerminalExtensionId(session) {
    if (terminalExtensionId !== undefined) return terminalExtensionId;
    try {
        const { canvases } = await session.rpc.canvas.list();
        const term = (canvases || []).find((c) => c.canvasId === TERMINAL_CANVAS_ID);
        terminalExtensionId = term?.extensionId || "";
    } catch {
        terminalExtensionId = "";
    }
    return terminalExtensionId;
}

function openParams(extensionId, input) {
    const params = { canvasId: TERMINAL_CANVAS_ID, instanceId: TERMINAL_INSTANCE_ID, input };
    if (extensionId) params.extensionId = extensionId;
    return params;
}

async function sendRunCommand(session, command) {
    await session.rpc.canvas.action.invoke({
        instanceId: TERMINAL_INSTANCE_ID,
        actionName: "send_terminal_input",
        input: { input: command, append_newline: true },
    });
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

export function buildAgentRunCommand(projectDir, platform = process.platform) {
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
    return `azd --cwd ${cwd} ai agent run --no-inspector`;
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
 *   status is one of: reused | already-running | starting | restarted | launched.
 */
export async function launchAgentTerminal(
    session,
    project = {},
    {
        agentReachable = isAgentReachable,
        now = Date.now,
        terminalRunning = isAgentTerminalRunning,
        sleep = defaultSleep,
        builderInstanceId = "",
    } = {},
) {
    if (!session?.rpc?.canvas?.open) {
        return { ok: false, error: "Integrated terminal is not available in this host." };
    }

    const [ready, mounted, extensionId] = await Promise.all([
        agentReachable(),
        // Mount state, not `listOpen`: a terminal the host never mounted is
        // reported as open but cannot accept input, and treating it as usable
        // would leave every retry sending commands into the void.
        terminalRunning(session),
        resolveTerminalExtensionId(session),
    ]);

    // Agent already answering on AGENT_PORT — never re-run the command (that
    // would collide on the port). Just reuse whatever is already running.
    if (ready) {
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

    // Agent not up yet.
    try {
        const command = buildAgentRunCommand(project.projectDir);
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

        if (mounted) {
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
        await sendRunCommand(session, command);
        commandSentAt = now();
        lastCommand = command;
        logTerminal(session, `opened terminal and launched agent from ${project.projectDir}`);
        // Focusing the terminal took the user off the inspector, so put them
        // back. Cosmetic, and never allowed to fail the launch.
        await restoreBuilderFocus(session, builderInstanceId);
        return { ok: true, status: "launched" };
    } catch (err) {
        const error = String(err?.message ?? err);
        logTerminal(session, `failed to launch agent terminal: ${error}`, "error");
        return { ok: false, error };
    }
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
    if (!session?.rpc?.canvas?.action?.invoke) return false;
    try {
        await session.rpc.canvas.action.invoke({
            instanceId: TERMINAL_INSTANCE_ID,
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
    if (!session?.rpc?.canvas?.close) return;
    try {
        if (!(await terminalIsOpen(session))) return;
        await session.rpc.canvas.close({ instanceId: TERMINAL_INSTANCE_ID });
        logTerminal(session, "closed agent terminal");
    } catch (err) {
        logTerminal(session, `close agent terminal failed: ${String(err?.message ?? err)}`, "warn");
    }
}
