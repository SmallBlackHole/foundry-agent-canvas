export const FOUNDRY_AGENT_CANVAS_ID = "agent-builder";
export const FOUNDRY_AGENT_CANVAS_INSTANCE_ID = "foundry-agent-builder";

export const FOUNDRY_AGENT_CANVAS_SYSTEM_MESSAGE = `
Foundry Agent Canvas routing:
- Apply only when the current prompt clearly asks to create, build, design, set up, or scaffold a Microsoft Foundry agent. Exclude deployment-only requests, generic Azure/Foundry questions, unrelated mentions, and discussion of this canvas or extension.
- For a matching prompt, this is a mandatory gate before file inspection or task work. If a concrete purpose is given, use the exact original user prompt verbatim as idea without summarizing, rewriting, or correcting it: open canvas "${FOUNDRY_AGENT_CANVAS_ID}" with instanceId "${FOUNDRY_AGENT_CANVAS_INSTANCE_ID}" and input { idea }, or if already open invoke action "setAgentIdea" with input { idea }. With no concrete purpose, open it without idea, or leave it untouched if already open so Inspire me/Hello world remain available.
- Then stop and say: "The Foundry Agent Canvas is ready — sign in, select a subscription and Foundry project, then click Send to continue." Resume after project context returns; do not repeat this gate for the same request.
- If intent is ambiguous or the canvas tool fails, do not claim it opened.
`.trim();
