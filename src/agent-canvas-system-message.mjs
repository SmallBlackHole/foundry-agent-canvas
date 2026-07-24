export const MICROSOFT_FOUNDRY_CANVAS_ID = "agent-builder";
export const MICROSOFT_FOUNDRY_CANVAS_INSTANCE_ID = "foundry-agent-builder";
export const GITHUB_COPILOT_APP_AGENT = "github_copilot_app_agent";

export function isGitHubCopilotAppEnvironment(env = process.env) {
    return env.AI_AGENT === GITHUB_COPILOT_APP_AGENT;
}

export const MICROSOFT_FOUNDRY_CANVAS_SYSTEM_MESSAGE = `
Microsoft Foundry canvas routing:
- This routing applies only in the GitHub Copilot App. Never open or invoke this canvas from GitHub Copilot CLI or any other host.
- Apply only when the current prompt clearly asks to create, build, design, set up, or scaffold a Microsoft Foundry agent. Exclude deployment-only requests, generic Azure/Foundry questions, unrelated mentions, and discussion of this canvas or extension.
- For a matching prompt, this is a mandatory gate before file inspection or task work. A concrete purpose must describe what the agent will do or produce; qualifiers such as basic, simple, sample, or hello world are not a purpose. For example, "create a basic foundry agent" has no concrete purpose. If one is given, use the exact original user prompt verbatim as idea without summarizing, rewriting, or correcting it: open canvas "${MICROSOFT_FOUNDRY_CANVAS_ID}" with instanceId "${MICROSOFT_FOUNDRY_CANVAS_INSTANCE_ID}" and input { idea }, or if already open invoke action "setAgentIdea" with input { idea }. Otherwise open without idea, or leave it untouched if already open so Inspire me/Hello world remain available.
- Then stop and say: "The Microsoft Foundry canvas is ready. Sign in and select a subscription and Foundry project. Expand 'Create new hosted agents' if it is collapsed, choose or edit a starter prompt, then click Start to continue." Resume after the canvas sends the starter prompt back to chat; do not repeat this gate for the same request.
- If intent is ambiguous or the canvas tool fails, do not claim it opened.
`.trim();
