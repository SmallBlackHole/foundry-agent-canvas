export const MICROSOFT_FOUNDRY_CANVAS_ID = "agent-builder";
export const MICROSOFT_FOUNDRY_CANVAS_INSTANCE_ID = "foundry-agent-builder";
export const GITHUB_COPILOT_APP_AGENT = "github_copilot_app_agent";

export function isGitHubCopilotAppEnvironment(env = process.env) {
    return env.AI_AGENT === GITHUB_COPILOT_APP_AGENT;
}

export const MICROSOFT_FOUNDRY_CANVAS_HANDOFF_MESSAGE = `
**The Microsoft Foundry canvas is ready.**

1. Sign in and select a subscription and Foundry project.
2. Expand **Create new hosted agents** if it is collapsed.
3. Choose or edit a starter prompt.
4. Click **Start** to continue.
`.trim();

export const MICROSOFT_FOUNDRY_CANVAS_SYSTEM_MESSAGE = `
Microsoft Foundry canvas routing:
- Apply the rest of this routing only when canvas "${MICROSOFT_FOUNDRY_CANVAS_ID}" is registered and open_canvas is available. Treat that capability as authoritative over assistant-profile or host labels; a GitHub Copilot CLI profile must not by itself prevent this routing. If either capability is unavailable, ignore the rest of this routing and follow the normal workflow.
- Apply only when the current prompt clearly asks to create, build, design, set up, or scaffold a Microsoft Foundry agent. Exclude deployment-only requests, generic Azure/Foundry questions, unrelated mentions, discussion of this canvas or extension, and explicit canvas opt-outs such as "skip the canvas" or "use the CLI".
- For a matching prompt, this is a mandatory gate before file inspection or task work. A concrete purpose must describe what the agent will do or produce; qualifiers such as basic, simple, sample, or hello world are not a purpose. For example, "create a basic foundry agent" has no concrete purpose. If one is given, use the exact original user prompt verbatim as idea without summarizing, rewriting, or correcting it: open canvas "${MICROSOFT_FOUNDRY_CANVAS_ID}" with instanceId "${MICROSOFT_FOUNDRY_CANVAS_INSTANCE_ID}" and input { idea }, or if already open invoke action "setAgentIdea" with input { idea }. Otherwise open without idea, or leave it untouched if already open so Inspire me/Hello world remain available.
- Then stop and respond with the following Markdown exactly:
${MICROSOFT_FOUNDRY_CANVAS_HANDOFF_MESSAGE}
Resume after the canvas sends the starter prompt back to chat; do not repeat this gate for the same request.
- If intent is ambiguous or the canvas tool fails, do not claim it opened.
`.trim();
