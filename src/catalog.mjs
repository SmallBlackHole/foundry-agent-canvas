// Catalog data + chat-prompt templates for the Microsoft Foundry canvas.
// Kept separate from the wiring so the renderer/server can stay focused.

// Picking a model that already has a deployment in the selected project.
export const selectModelPrompt = (name) =>
    `Use ${name} in my Foundry agent`;

// Reusing a Foundry Toolbox that already exists in the selected project.
export const selectToolboxPrompt = (name) =>
    `Use the existing "${name}" Foundry Toolbox in my Foundry agent`;

// Selecting a skill that already exists in the project.
export const selectSkillPrompt = (name) =>
    `Use the "${name}" skill in my Foundry agent`;

// Selecting a guardrail (RAI policy) that already exists on the account.
export const selectGuardrailPrompt = (name) =>
    `Use the "${name}" guardrail in my Foundry agent`;

export const DEPLOY_PROMPT = "deploy it as a Foundry hosted agent";
export const MANAGED_DEPLOY_PROMPT =
    "Deploy my selected managed agent to Microsoft Foundry.";

// ---------------------------------------------------------------------------
// Provider colors (used by live deployment enrichment for the colored dot)
// ---------------------------------------------------------------------------

const PROVIDER_COLORS = {
    OpenAI: "#10a37f",
    Anthropic: "#d97757",
    DeepSeek: "#4d6bfe",
    Meta: "#0866ff",
    Microsoft: "#0078d4",
    "Mistral AI": "#fa5111",
    MistralAI: "#fa5111",
    Mistral: "#fa5111",
    xAI: "#111111",
    Cohere: "#39594d",
};

export function providerColor(provider) {
    return PROVIDER_COLORS[provider] || "#57606a";
}

// Mock fallbacks (empty/minimal) — used when live API calls fail.
export const deployments = [];
