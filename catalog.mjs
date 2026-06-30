// Catalog data + chat-prompt templates for the Foundry Agent Canvas canvas.
// Kept separate from the wiring so the renderer/server can stay focused.

// "Prompt to chat" templates. Clicking an Add/Deploy affordance in the iframe
// posts the resulting string to /api/send, which calls session.send({ prompt }).
export const toolPrompt = (name) =>
    `Add a ${name} tool to my Foundry agent and create the tool connection in Foundry`;

export const modelPrompt = (name) =>
    `Add the ${name} model to my Foundry agent and deploy model if it does not exist in this project`;

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
export const INSPECT_PROMPT = "start the Foundry agent locally so I can inspect it";

// ---------------------------------------------------------------------------
// Initialize agent code
// ---------------------------------------------------------------------------
// Fixed starter prompt the developer can edit before sending from the canvas.
export const INIT_PROMPT =
    "Create a single-purpose Python hosted agent using the Responses protocol. Once it's done, run it locally to make sure it runs successfully.";

// Currently selected Foundry project — empty until the user picks one.
export const project = { name: "" };

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
// `recommended: true` items render in the top "Foundry built-in" section.
// WorkIQ is the featured hero recommendation.
const TOOLS = [
    {
        id: "workiq",
        name: "WorkIQ",
        category: "Built-in · Microsoft Foundry · Preview",
        icon: "WIQ",
        iconSrc: "tool-icons/workiq.svg",
        color: "#0a7c5a",
        recommended: true,
        featured: true,
        blurb:
            "Ground your agent in Microsoft 365 work context — securely reason over emails, meetings, files & chats with built-in, permission-aware governance.",
    },
    {
        id: "web-search",
        name: "Web search",
        category: "Built-in · Microsoft Foundry",
        icon: "B",
        iconSrc: "tool-icons/web-search.svg",
        color: "#0a6ed1",
        recommended: true,
        blurb: "Search the Internet for sources related to the prompt.",
    },
    {
        id: "code-interpreter",
        name: "Code Interpreter",
        category: "Built-in · Microsoft Foundry",
        icon: "{ }",
        iconSrc: "tool-icons/code-interpreter.svg",
        color: "#1f883d",
        recommended: true,
        blurb: "Enable agents to write and run Python code in a sandboxed environment.",
    },
    {
        id: "file-search",
        name: "File Search",
        category: "Built-in · Microsoft Foundry",
        icon: "FS",
        iconSrc: "tool-icons/file-search.svg",
        color: "#8661c5",
        recommended: true,
        blurb: "Augment agents with knowledge from outside its model.",
    },
    {
        id: "azure-ai-search",
        name: "Azure AI Search",
        category: "Built-in · Microsoft Foundry",
        icon: "AS",
        iconSrc: "tool-icons/azure-ai-search.svg",
        color: "#0078d4",
        recommended: true,
        blurb: "Use an existing Azure AI Search index to ground agents in your data.",
    },
    {
        id: "fabric-iq",
        name: "Fabric IQ (OneLake Catalog)",
        category: "Built-in · Microsoft Foundry · Preview",
        icon: "FB",
        iconSrc: "tool-icons/fabric-iq.svg",
        color: "#117865",
        recommended: true,
        blurb: "Ground your agent in Microsoft Fabric OneLake Catalog data.",
    },
    {
        id: "browser-automation",
        name: "Browser Automation",
        category: "Built-in · Microsoft Foundry · Preview",
        icon: "🖥",
        iconSrc: "tool-icons/browser-automation.svg",
        color: "#d9480f",
        recommended: true,
        blurb: "Enable your agent to browse and interact with the web.",
    },
    // "More tools" — MCP server catalog (mocked).
    {
        id: "databricks-genie",
        name: "Azure Databricks Genie",
        category: "MCP: Remote · Microsoft · Productivity",
        icon: "DB",
        iconSrc: "tool-icons/databricks-genie.svg",
        color: "#FF3621",
        blurb: "Azure Databricks Genie MCP server lets AI agents converse with your Databricks data.",
    },
    {
        id: "elasticsearch",
        name: "Elasticsearch",
        category: "MCP: Remote · Partner · Databases",
        icon: "ES",
        iconSrc: "tool-icons/elasticsearch.svg",
        color: "#00BFB3",
        blurb: "Search, retrieve, and analyze Elasticsearch data in real time.",
    },
    {
        id: "github",
        name: "GitHub",
        category: "MCP: Remote · Microsoft · Developer Tools",
        icon: "GH",
        iconSrc: "tool-icons/github.svg",
        color: "#181717",
        blurb: "Access GitHub repositories, issues, and pull requests.",
    },
    {
        id: "infobip-whatsapp",
        name: "Infobip WhatsApp MCP server",
        category: "MCP: Remote · Partner · Customer Service",
        icon: "IB",
        iconSrc: "tool-icons/infobip-whatsapp.svg",
        color: "#E94B36",
        blurb: "Infobip WhatsApp MCP server enables seamless integration with WhatsApp messaging.",
    },
    {
        id: "intercom",
        name: "Intercom MCP Server",
        category: "MCP: Remote · Partner · Customer Service",
        icon: "IC",
        iconSrc: "tool-icons/intercom.svg",
        color: "#1F8DED",
        blurb: "Secure, read-only access to Intercom conversations and contacts.",
    },
    {
        id: "lovable",
        name: "Lovable",
        category: "MCP: Remote · Partner · Developer Tools",
        icon: "LV",
        iconSrc: "tool-icons/lovable.svg",
        color: "#F0309A",
        blurb: "The official MCP server for Lovable, the AI-powered app builder.",
    },
    {
        id: "lseg",
        name: "LSEG Data and Analytics",
        category: "MCP: Remote · Partner · Finance",
        icon: "LS",
        iconSrc: "tool-icons/lseg.svg",
        color: "#0019A5",
        blurb: "This MCP server exposes LSEG analytics and market data.",
    },
    {
        id: "marketnode",
        name: "Marketnode MCP Server",
        category: "MCP: Remote · Partner · Finance",
        icon: "MN",
        iconSrc: "tool-icons/marketnode.svg",
        color: "#0A6ED1",
        blurb: "AI-powered document data extraction and workflow automation.",
    },
    {
        id: "merge-agent-handler",
        name: "Merge Agent Handler",
        category: "MCP: Remote · Partner · Integration",
        icon: "MR",
        iconSrc: "tool-icons/merge-agent-handler.svg",
        color: "#6e40c9",
        blurb: "Merge Agent Handler is an MCP gateway that sits between agents and tools.",
    },
];

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------
// `recommended: true` items render in the top "Most popular" section.
const MODELS = [
    {
        id: "gpt-5.5",
        name: "gpt-5.5",
        provider: "OpenAI",
        color: "#10a37f",
        recommended: true,
        blurb: "Frontier reasoning and agentic performance.",
    },
    {
        id: "gpt-5.4",
        name: "gpt-5.4",
        provider: "OpenAI",
        color: "#10a37f",
        recommended: true,
        blurb: "Fast, capable general-purpose frontier model.",
    },
    {
        id: "gpt-5",
        name: "gpt-5",
        provider: "OpenAI",
        color: "#10a37f",
        recommended: true,
        blurb: "Flagship multimodal model for broad workloads.",
    },
    {
        id: "gpt-5-mini",
        name: "gpt-5-mini",
        provider: "OpenAI",
        color: "#10a37f",
        blurb: "Cost-efficient GPT-5 tier for high volume.",
    },
    {
        id: "gpt-5-nano",
        name: "gpt-5-nano",
        provider: "OpenAI",
        color: "#10a37f",
        blurb: "Lowest-latency GPT-5 tier.",
    },
    {
        id: "gpt-4.1",
        name: "gpt-4.1",
        provider: "OpenAI",
        color: "#10a37f",
        blurb: "Strong coding and long-context performance.",
    },
    {
        id: "gpt-4o",
        name: "gpt-4o",
        provider: "OpenAI",
        color: "#10a37f",
        blurb: "Multimodal omni model (text, vision, audio).",
    },
    {
        id: "o4-mini",
        name: "o4-mini",
        provider: "OpenAI",
        color: "#10a37f",
        blurb: "Efficient reasoning model.",
    },
    {
        id: "o3",
        name: "o3",
        provider: "OpenAI",
        color: "#10a37f",
        blurb: "Deep step-by-step reasoning model.",
    },
    {
        id: "claude-sonnet-4.6",
        name: "Claude Sonnet 4.6",
        provider: "Anthropic",
        color: "#d97757",
        blurb: "Balanced reasoning and speed.",
    },
    {
        id: "claude-opus-4.5",
        name: "Claude Opus 4.5",
        provider: "Anthropic",
        color: "#d97757",
        blurb: "Most capable Claude model.",
    },
    {
        id: "deepseek-r1",
        name: "DeepSeek-R1",
        provider: "DeepSeek",
        color: "#4d6bfe",
        blurb: "Open reasoning model.",
    },
    {
        id: "deepseek-v3",
        name: "DeepSeek-V3",
        provider: "DeepSeek",
        color: "#4d6bfe",
        blurb: "Open general-purpose model.",
    },
    {
        id: "llama-4",
        name: "Llama 4",
        provider: "Meta",
        color: "#0866ff",
        blurb: "Open multimodal model.",
    },
    {
        id: "llama-3.3-70b",
        name: "Llama 3.3 70B",
        provider: "Meta",
        color: "#0866ff",
        blurb: "Open 70B instruction-tuned model.",
    },
    {
        id: "phi-4",
        name: "Phi-4",
        provider: "Microsoft",
        color: "#0078d4",
        blurb: "Small, high-quality language model.",
    },
    {
        id: "mistral-large",
        name: "Mistral Large",
        provider: "Mistral AI",
        color: "#fa5111",
        blurb: "Flagship open-weight model.",
    },
    {
        id: "grok-4",
        name: "Grok 4",
        provider: "xAI",
        color: "#111111",
        blurb: "Frontier model from xAI.",
    },
    {
        id: "cohere-command-r-plus",
        name: "Command R+",
        provider: "Cohere",
        color: "#39594d",
        blurb: "Retrieval-augmented generation optimized model.",
    },
];

// Map a model provider to its brand avatar icon (served from public/model-icons).
// Icons sourced from the Skylight ai-mlstudio avatar logo set.
const PROVIDER_ICONS = {
    OpenAI: "model-icons/openai.svg",
    Anthropic: "model-icons/anthropic.svg",
    DeepSeek: "model-icons/deepseek.svg",
    Meta: "model-icons/meta.svg",
    Microsoft: "model-icons/ms.svg",
    "Mistral AI": "model-icons/mistralai.svg",
    xAI: "model-icons/xai.svg",
    Cohere: "model-icons/cohere.svg",
};

// Provider brand color, used for the small dot when no icon resolves.
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

// Enrichment helpers for *live* project data (deployments / connections) so the
// model+tool dropdowns reuse the same brand icons as the catalogs.
export function providerIcon(provider) {
    return PROVIDER_ICONS[provider] || null;
}
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

// Attach the chat prompt to every catalog entry so the client only has to echo
// it back to /api/send (prompts stay defined server-side).
export const tools = TOOLS.map((t) => ({ ...t, prompt: toolPrompt(t.name) }));
export const models = MODELS.map((m) => ({
    ...m,
    prompt: modelPrompt(m.name),
    iconSrc: PROVIDER_ICONS[m.provider] || null,
}));

// No mock model deployments — show nothing until a real project is signed into.
const DEPLOYED_MODEL_IDS = [];
export const deployments = DEPLOYED_MODEL_IDS.map((id) => MODELS.find((m) => m.id === id))
    .filter(Boolean)
    .map((m) => ({ ...m, prompt: selectModelPrompt(m.name), iconSrc: PROVIDER_ICONS[m.provider] || null }));

// Tools that already have a connection in the selected Foundry project (mocked).
const CONNECTED_TOOL_IDS = ["github"];
export const toolConnections = CONNECTED_TOOL_IDS.map((id) => TOOLS.find((t) => t.id === id))
    .filter(Boolean)
    .map((t) => ({ ...t, prompt: selectToolPrompt(t.name) }));
