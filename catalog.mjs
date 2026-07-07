// Catalog data + chat-prompt templates for the Foundry Agent Canvas canvas.
// Kept separate from the wiring so the renderer/server can stay focused.

// Picking a model that already has a deployment in the selected project.
export const selectModelPrompt = (name) =>
    `Use ${name} in my Foundry agent`;

// Reusing a tool that already has a connection in the selected project.
export const selectToolPrompt = (name) =>
    `Use the existing ${name} tool connection in my Foundry agent`;

// Reusing a Foundry Toolbox that already exists in the selected project.
export const selectToolboxPrompt = (name) =>
    `Use the existing "${name}" Foundry Toolbox in my Foundry agent`;

export const DEPLOY_PROMPT = "deploy it as a Foundry hosted agent";
export const INSPECT_PROMPT =
    "start the Foundry agent locally so I can inspect it. " +
    "Open the terminal, then re-focus the agent-builder canvas that's already open.";

// Currently selected Foundry project — empty until the user picks one.
export const project = { name: "" };

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

// Best-effort tool icon resolver: match a connection's name / toolEntityId /
// type against known tool-icon slugs. Order matters — specific before generic.
const TOOL_ICON_KEYWORDS = [
    ["github", "tool-icons/github.svg", "#181717"],
    ["intercom", "tool-icons/intercom.svg", "#1F8DED"],
    ["elasticsearch", "tool-icons/elasticsearch.svg", "#00BFB3"],
    ["databricks", "tool-icons/databricks-genie.svg", "#FF3621"],
    ["genie", "tool-icons/databricks-genie.svg", "#FF3621"],
    ["infobip", "tool-icons/infobip-whatsapp.svg", "#E94B36"],
    ["lovable", "tool-icons/lovable.svg", "#F0309A"],
    ["lseg", "tool-icons/lseg.svg", "#0019A5"],
    ["marketnode", "tool-icons/marketnode.svg", "#0A6ED1"],
    ["merge", "tool-icons/merge-agent-handler.svg", "#6e40c9"],
    ["workiq", "tool-icons/workiq.svg", "#0a7c5a"],
    ["m365", "tool-icons/workiq.svg", "#0a7c5a"],
    ["bing", "tool-icons/web-search.svg", "#0a6ed1"],
    ["web-search", "tool-icons/web-search.svg", "#0a6ed1"],
    ["websearch", "tool-icons/web-search.svg", "#0a6ed1"],
    ["aisearch", "tool-icons/azure-ai-search.svg", "#0078d4"],
    ["cognitivesearch", "tool-icons/azure-ai-search.svg", "#0078d4"],
    ["ai-search", "tool-icons/azure-ai-search.svg", "#0078d4"],
    ["fabric", "tool-icons/fabric-iq.svg", "#117865"],
    ["onelake", "tool-icons/fabric-iq.svg", "#117865"],
    ["browser", "tool-icons/browser-automation.svg", "#d9480f"],
    ["playwright", "tool-icons/browser-automation.svg", "#d9480f"],
    ["code-interpreter", "tool-icons/code-interpreter.svg", "#1f883d"],
    ["codeinterpreter", "tool-icons/code-interpreter.svg", "#1f883d"],
    ["file", "tool-icons/file-search.svg", "#8661c5"],
];
export function toolIconFor(haystack) {
    const h = String(haystack || "").toLowerCase();
    for (const [kw, iconSrc, color] of TOOL_ICON_KEYWORDS) {
        if (h.includes(kw)) return { iconSrc, color };
    }
    return { iconSrc: null, color: "#57606a" };
}

// Mock fallbacks (empty/minimal) — used when live API calls fail.
export const deployments = [];

export const toolConnections = [
    {
        id: "github",
        name: "GitHub",
        category: "MCP: Remote · Microsoft · Developer Tools",
        iconSrc: "tool-icons/github.svg",
        color: "#181717",
        prompt: selectToolPrompt("GitHub"),
    },
];
