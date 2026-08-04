export const MANAGED_AGENT_ACTIONS = Object.freeze(["create", "deploy", "update"]);

const MANAGED_POC_SLASH_COMMAND = "/microsoft-foundry-managed-poc";
const ACTION_MARKER_PREFIX = "<foundry-canvas-managed-action:";

const ACTION_CONTEXT = Object.freeze({
    create:
        "Use West US 2 (westus2) and the private-preview azure.ai.agents azd extension flow. " +
        "Author declarative instructions and skills, deploy the managed agent remotely, " +
        "and smoke invoke the deployed agent. Do not ask for or perform a local run.",
    deploy:
        "Use West US 2 (westus2) and the private-preview azure.ai.agents azd extension flow. " +
        "Preserve the managed agent's declarative instructions and skills, deploy it remotely, " +
        "and smoke invoke the deployed agent. Do not ask for or perform a local run.",
});

function actionMarker(action) {
    return `${ACTION_MARKER_PREFIX}${action}>`;
}

export function markManagedAgentPrompt(prompt, action) {
    if (!MANAGED_AGENT_ACTIONS.includes(action)) return prompt;
    return `${prompt}\n\n${actionMarker(action)}`;
}

export function managedAgentPromptHook(prompt) {
    for (const action of MANAGED_AGENT_ACTIONS) {
        const suffix = `\n\n${actionMarker(action)}`;
        if (!prompt.endsWith(suffix)) continue;

        const userPrompt = prompt.slice(0, -suffix.length);
        return {
            modifiedPrompt: `${MANAGED_POC_SLASH_COMMAND}\n\n${userPrompt}`,
            ...(ACTION_CONTEXT[action] ? { additionalContext: ACTION_CONTEXT[action] } : {}),
        };
    }
    return undefined;
}
