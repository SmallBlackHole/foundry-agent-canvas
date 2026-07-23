// Launches the Foundry hosted agent locally in the Copilot App's integrated
// terminal (the host-provided "terminal" canvas) and reuses an already-running
// terminal/agent so repeated "Inspect locally" clicks don't spawn duplicates
// or collide on the agent's port.

import { isAbsolute } from "node:path";

import { isAgentReachable } from "./inspector.mjs";

// Stable instance id for our agent terminal so re-opening focuses the same
// panel instead of creating a new one each click.
const TERMINAL_CANVAS_ID = "terminal";
const TERMINAL_INSTANCE_ID = "foundry-agent-run";
const TERMINAL_TITLE = "Foundry agent (local)";

// Short window that only collapses rapid duplicate clicks so we don't stack the
// run command onto a launch we issued moments ago. It is intentionally small:
// the host gives us no reliable "process exited" signal, so we can't tell
// "still starting" from "crashed". Re-sending the command after this window is
// safe either way — a still-running azd doesn't read stdin (the line is ignored
// while it keeps running), and a crashed one drops back to a shell prompt so the
// line re-runs and restarts it. A deliberate retry click therefore recovers a
// crashed agent within a few seconds instead of waiting out a long timer.
const RELAUNCH_DEBOUNCE_MS = 4_000;

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
 * @param {object} dependencies - Optional test dependencies.
 * @returns {Promise<{ok: boolean, status?: string, error?: string}>}
 *   status is one of: reused | already-running | starting | restarted | launched.
 */
export async function launchAgentTerminal(
    session,
    project = {},
    { agentReachable = isAgentReachable, now = Date.now } = {},
) {
    if (!session?.rpc?.canvas?.open) {
        return { ok: false, error: "Integrated terminal is not available in this host." };
    }

    const [ready, isOpen, extensionId] = await Promise.all([
        agentReachable(),
        terminalIsOpen(session),
        resolveTerminalExtensionId(session),
    ]);

    // Agent already answering on AGENT_PORT — never re-run the command (that
    // would collide on the port). Just reuse whatever is already running.
    if (ready) {
        const status = isOpen ? "reused" : "already-running";
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

        if (isOpen) {
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
            // Terminal exists but the agent isn't up and we didn't just launch:
            // (re)run the command in place. Restarts a crashed run; a still-
            // starting run simply ignores the extra stdin line.
            await session.rpc.canvas.action.invoke({
                instanceId: TERMINAL_INSTANCE_ID,
                actionName: "send_terminal_input",
                input: { input: command, append_newline: true },
            });
            commandSentAt = now();
            lastCommand = command;
            logTerminal(session, `re-ran agent command from ${project.projectDir}`);
            return { ok: true, status: "restarted" };
        }

        // No terminal yet: open one and run the command. Keep focus on the
        // builder/inspector canvas (focus:false) so the inspector stays visible.
        await session.rpc.canvas.open(
            openParams(extensionId, {
                command,
                title: TERMINAL_TITLE,
                placement: { focus: false },
            }),
        );
        commandSentAt = now();
        lastCommand = command;
        logTerminal(session, `opened terminal and launched agent from ${project.projectDir}`);
        return { ok: true, status: "launched" };
    } catch (err) {
        const error = String(err?.message ?? err);
        logTerminal(session, `failed to launch agent terminal: ${error}`, "error");
        return { ok: false, error };
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
