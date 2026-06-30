// Foundry Agent Canvas — client SPA.
// Three client-side views (build / tools / models). Add & Deploy affordances
// POST a prompt to /api/send, which the extension forwards to the chat via
// session.send(). Catalog data comes from /api/tools and /api/models.

const state = {
    page: "build",
    agentName: "",
    project: { name: "" },
    model: { name: "", color: "#10a37f" },
    deployPrompt: "deploy it as a Foundry hosted agent",
    inspectPrompt: "start the Foundry agent locally so I can inspect it",
    // Live project data, lazily loaded when a dropdown first opens.
    // status: idle | loading | ready | error
    deploymentsState: { status: "idle", items: [], source: null, reason: null },
    connectionsState: { status: "idle", items: [], source: null, reason: null },
    toolboxesState: { status: "idle", items: [], reason: null },
    // Project picker state.
    identity: { signedIn: false, account: "", tenantId: "", subscriptionId: "", subscriptionName: "" },
    subsState: { status: "idle", items: [], reason: null },
    projState: { status: "idle", items: [], reason: null, sub: null },
    signin: { sessionId: null, timer: null, starting: false },
    cache: { tools: null, models: null },
    // "Initialize agent code" block (ephemeral UI state).
    init: {
        open: false,
        promptDirty: false, // true once the user edits the textarea by hand
        promptText: "",
        protocol: "Responses", // Responses | Invocations (drives the starter prompt)
        framework: "Microsoft Agent Framework", // SDK/framework phrase in the prompt
        idea: "", // purpose phrase; empty => "single-purpose"
    },
    // Collapsible "Add Project Resources" / "Deploy & Test" cards (open by default).
    folds: { resources: true, deploy: true },
    // Hosted-agent region availability for the selected project.
    // supported: true | false | null (null = unknown → don't block, fail open).
    hostedRegion: { status: "idle", location: "", supported: null, regions: [], docsUrl: "" },
};

const root = document.getElementById("root");
const toastEl = document.getElementById("toast");

let toastTimer = null;
function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2600);
}

async function getJSON(url) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
}

async function postJSON(url, body) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body || {}),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
}

// Run the non-LLM skills install via the backend and reflect status inline next
// to the "Install latest Foundry Skills" bubble. No chat turn.
async function installSkills() {
    const btn = document.getElementById("prepPrereqs");
    const status = document.getElementById("skillStatus");
    if (btn?.dataset.busy === "1") return;
    if (btn) {
        btn.dataset.busy = "1";
        btn.disabled = true;
    }
    if (status) {
        status.className = "init-skill-status is-loading";
        status.textContent = "Installing…";
    }
    try {
        const res = await fetch("/api/skills/install", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        const ok = !!data.ok;
        const msg = data.summary || (ok ? "Done" : "Install failed");
        if (status) {
            status.className = "init-skill-status " + (ok ? "is-ok" : "is-err");
            status.textContent = (ok ? "\u2713 " : "\u2717 ") + msg;
        }
        toast(ok ? "Foundry Skills ready \u2713" : "Skills install failed");
    } catch (err) {
        const isNetwork = err instanceof TypeError || /failed to fetch/i.test(err.message || "");
        const msg = isNetwork
            ? "Lost connection to the builder. Reopen the Foundry Agent Canvas, then try again."
            : "Could not install: " + err.message;
        if (status) {
            status.className = "init-skill-status is-err";
            status.textContent = "\u2717 " + msg;
        }
        toast(msg);
    } finally {
        if (btn) {
            btn.dataset.busy = "0";
            btn.disabled = false;
        }
    }
}

async function sendToChat(prompt) {
    try {
        const res = await fetch("/api/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt }),
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        toast("Sent to chat \u2713");
    } catch (err) {
        // A TypeError from fetch ("Failed to fetch") means the request never
        // reached the server — almost always because this panel's backing
        // server was torn down (e.g. the extension reloaded) and the iframe is
        // now pointing at a dead port. Tell the user how to recover instead of
        // surfacing the cryptic browser message.
        const isNetwork = err instanceof TypeError || /failed to fetch/i.test(err.message || "");
        toast(
            isNetwork
                ? "Lost connection to the builder. Reopen the Foundry Agent Canvas, then try again."
                : "Could not send: " + err.message,
        );
    }
}

// Append the selected Foundry project context to a chat prompt so the chat
// agent knows which project to target (name, subscription, and data-plane
// endpoint). Returns the prompt unchanged when no project is selected.
function withProjectContext(prompt) {
    const name = state.project?.name;
    if (!name) return prompt;
    const parts = [`project "${name}"`];
    const sub = state.identity?.subscriptionName;
    if (sub) parts.push(`in subscription "${sub}"`);
    const ep = state.project?.endpoint;
    if (ep) parts.push(`(endpoint: ${ep})`);
    return `${prompt}\n\nUse my selected Foundry ${parts.join(" ")}.`;
}

function clone(id) {
    return document.getElementById(id).content.firstElementChild.cloneNode(true);
}

// --------------------------------------------------------------- Build view
function renderBuild() {
    const node = clone("tpl-build");

    const projectName = state.project?.name || "Select a project";
    const projEl = node.querySelector("#projectName");
    if (projEl) projEl.textContent = projectName;
    const projDot = node.querySelector(".project-dot");
    if (projDot) projDot.classList.toggle("is-unset", !state.project?.name);
    const menuProj = node.querySelector("#menuProject");
    if (menuProj) menuProj.textContent = projectName;
    const toolMenuProj = node.querySelector("#toolMenuProject");
    if (toolMenuProj) toolMenuProj.textContent = projectName;
    const toolboxMenuProj = node.querySelector("#toolboxMenuProject");
    if (toolboxMenuProj) toolboxMenuProj.textContent = projectName;
    // Reseed the picker's selected sub/project so a re-clone keeps the selection.
    const pmProjValue = node.querySelector("#pmProjValue");
    if (pmProjValue && state.project?.name) pmProjValue.textContent = state.project.name;
    const pmSubValue = node.querySelector("#pmSubValue");
    if (pmSubValue && state.identity.subscriptionName) pmSubValue.textContent = state.identity.subscriptionName;

    root.replaceChildren(node);

    // Populate the dropdown lists from whatever live state we already have.
    renderDeployList();
    renderToolboxList();
    renderInit();
    renderFolds();
    renderRegionSupport();
}

// Apply a collapsible card's open/closed state to the DOM. Mirrors the
// "Initialize Agent Code" fold but generic for the resources/deploy cards.
function applyFold(blockId, open) {
    const block = document.getElementById(blockId);
    if (!block) return;
    block.setAttribute("data-open", String(open));
    const toggle = block.querySelector(".fold-toggle");
    if (toggle) toggle.setAttribute("aria-expanded", String(open));
    const panel = block.querySelector(".fold-panel");
    if (panel) panel.hidden = !open;
}

function renderFolds() {
    applyFold("resourcesBlock", state.folds.resources);
    applyFold("deployBlock", state.folds.deploy);
}

// Prettify an ARM region code for display, e.g. "eastus2" → "East US 2".
function prettyRegion(code) {
    const c = String(code || "");
    if (!c) return "";
    const map = {
        eastus2: "East US 2", northcentralus: "North Central US", swedencentral: "Sweden Central",
        canadacentral: "Canada Central", canadaeast: "Canada East", southeastasia: "Southeast Asia",
        polandcentral: "Poland Central", southafricanorth: "South Africa North", koreacentral: "Korea Central",
        southindia: "South India", brazilsouth: "Brazil South", westus: "West US", westus3: "West US 3",
        norwayeast: "Norway East", japaneast: "Japan East", francecentral: "France Central",
        germanywestcentral: "Germany West Central", switzerlandnorth: "Switzerland North",
        spaincentral: "Spain Central", australiaeast: "Australia East",
    };
    return map[c.toLowerCase()] || c;
}

// Reflect the current hosted-region check onto the Deploy button + warning
// banner. Safe to call even when the deploy DOM isn't mounted (other pages).
function renderRegionSupport() {
    const warn = document.getElementById("regionWarn");
    const btn = document.getElementById("deployBtn");
    const hr = state.hostedRegion;
    const blocked = hr.supported === false;
    if (btn) {
        btn.classList.toggle("is-blocked", blocked);
        btn.setAttribute("aria-disabled", String(blocked));
        btn.title = blocked
            ? "Hosted agents aren't supported in this project's region"
            : "";
    }
    if (warn) {
        warn.hidden = !blocked;
        if (blocked) {
            const head = document.getElementById("regionWarnHead");
            if (head) {
                const loc = prettyRegion(hr.location);
                head.textContent = loc
                    ? `Hosted agents aren't available in this project's region (${loc}).`
                    : "Hosted agents aren't available in this project's region.";
            }
            const link = document.getElementById("regionWarnLink");
            if (link && hr.docsUrl) link.href = hr.docsUrl;
        }
    }
}

// Fetch hosted-agent region support for the selected project and update the UI.
async function loadRegionSupport() {
    state.hostedRegion.status = "loading";
    try {
        const r = await getJSON("/api/region-support");
        if (r && r.ok) {
            state.hostedRegion = {
                status: "ready",
                location: r.location || "",
                supported: typeof r.supported === "boolean" ? r.supported : null,
                regions: Array.isArray(r.regions) ? r.regions : [],
                docsUrl: r.docsUrl || "",
            };
        } else {
            state.hostedRegion.status = "error";
            state.hostedRegion.supported = null; // fail open
        }
    } catch {
        state.hostedRegion.status = "error";
        state.hostedRegion.supported = null; // fail open
    }
    renderRegionSupport();
}

// Set the initial expand/fold state of the Build sections from whether the
// workspace is already scaffolded. Not initialized => focus on Initialize
// Agent Code (expanded, others folded). Initialized => fold Initialize Agent
// Code and surface Add Project Resources / Deploy & Test (expanded). Applied
// once on load; manual toggles afterward take over.
function applyInitDefaults(info) {
    const initialized = !!(info && info.initialized);
    state.init.open = !initialized;
    state.folds.resources = initialized;
    state.folds.deploy = initialized;
    renderInit();
    renderFolds();
}

// ----------------------------------------------------- Initialize agent code
// Starter prompt the developer can edit before sending. The purpose, protocol,
// framework, and deploy clause are driven by state.init so the bubble buttons
// (and AI-invoked canvas actions) can rewrite them.
const PROTOCOL_BLOG = "https://ankitbko.github.io/blog/2026/05/hosted-agents-part-1/";

// The "Responses vs Invocations" button points the agent at one local reference
// file (its absolute path comes from GET /api/protocol-ref) instead of inlining
// the whole comparison into the chat prompt. The file is bundled with the
// extension under references/responses-vs-invocations.md.
async function protocolRefPath() {
    try {
        const res = await fetch("/api/protocol-ref", { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        return typeof data.path === "string" ? data.path : "";
    } catch {
        return "";
    }
}

// Build + send the protocol-comparison prompt, pointing the agent at the bundled
// reference file rather than embedding its contents.
async function decideProtocol() {
    const path = await protocolRefPath();
    const fileClause = path
        ? `Read the reference file at:\n${path}\n(use your file-read tool for that one file only — do NOT fetch any URL or use web search).`
        : `Use the reference distilled from ${PROTOCOL_BLOG} (do NOT fetch the URL or use web search).`;
    sendToChat(
        "Briefly compare the Responses and Invocations protocols for Microsoft Foundry hosted " +
            "agents. " +
            fileClause +
            " Then reply with 3-5 short bullets plus a one-line recommendation for a single-purpose " +
            "Python agent, and immediately call the Foundry Agent Canvas's \"setProtocol\" action " +
            'once with "Responses" or "Invocations".',
    );
}

function initPromptText() {
    const proto = state.init.protocol === "Invocations" ? "Invocations" : "Responses";
    const fw = (state.init.framework || "Microsoft Agent Framework").trim();
    const purpose = (state.init.idea || "").trim() || "single-purpose";
    const text =
        "Create a " +
        purpose +
        " Python hosted agent using the " +
        proto +
        " protocol and " +
        fw +
        ". Once it's done, run it locally to make sure it runs successfully.";
    return text;
}

// Seed the textarea with the default prompt unless the user has edited it by
// hand (promptDirty).
function syncInitPrompt() {
    const ta = document.getElementById("initPrompt");
    if (!ta) return;
    if (state.init.promptDirty) {
        state.init.promptText = ta.value;
        return;
    }
    const text = initPromptText();
    state.init.promptText = text;
    ta.value = text;
}

// Re-seed the prompt from structured state (used by the bubble buttons and the
// agent-driven canvas actions) and make sure the section is expanded.
function rebuildInitPrompt(message) {
    state.init.promptDirty = false;
    state.init.open = true;
    renderInit();
    if (message) toast(message);
}

function setInitProtocol(protocol) {
    if (protocol !== "Responses" && protocol !== "Invocations") return;
    state.init.protocol = protocol;
    rebuildInitPrompt(protocol + " protocol selected \u2713");
}

// "Inspire me an idea" / agent-driven setAgentIdea: swap ONLY the purpose
// phrase in the current prompt, preserving the protocol, framework, and any
// other manual edits exactly as they appear in the textarea.
function setInitIdea(idea) {
    if (!idea || !idea.trim()) return;
    const phrase = idea.trim();
    state.init.idea = phrase;
    state.init.open = true;

    const ta = document.getElementById("initPrompt");
    const current = (ta ? ta.value : state.init.promptText) || initPromptText();
    const re = /Create a .+? Python hosted agent/;
    const next = re.test(current)
        ? current.replace(re, "Create a " + phrase + " Python hosted agent")
        : initPromptText();

    state.init.promptText = next;
    state.init.promptDirty = true; // we hand-merged; don't let a state rebuild clobber it
    if (ta) ta.value = next;
    renderInit();
    toast("Idea added \u2713");
}

function renderInit() {
    const block = document.getElementById("initBlock");
    if (!block) return;

    // Reflect collapsed/expanded.
    const toggle = document.getElementById("initToggle");
    const panel = document.getElementById("initPanel");
    block.setAttribute("data-open", String(state.init.open));
    if (toggle) toggle.setAttribute("aria-expanded", String(state.init.open));
    if (panel) panel.hidden = !state.init.open;
    if (!state.init.open) return;

    syncInitPrompt();
}
function menuMsg(text, variant) {
    const el = document.createElement("div");
    el.className = "menu-msg" + (variant ? " is-" + variant : "");
    if (variant === "loading") {
        const sp = document.createElement("span");
        sp.className = "menu-spinner";
        el.appendChild(sp);
    }
    const span = document.createElement("span");
    span.textContent = text;
    el.appendChild(span);
    return el;
}

// Error row with a Retry button.
function menuError(text, onRetry) {
    const el = document.createElement("div");
    el.className = "menu-msg is-error";
    const span = document.createElement("span");
    span.textContent = text;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "menu-retry";
    retry.textContent = "Retry";
    retry.addEventListener("click", (e) => {
        e.stopPropagation();
        onRetry();
    });
    el.append(span, retry);
    return el;
}

// Subtle note shown when we fall back to sample data (e.g. not signed in).
function sampleNote(reason) {
    const map = {
        not_signed_in: "Showing sample data \u2014 run az login to see live data",
        unauthorized: "Showing sample data \u2014 no access to this project",
        not_found: "Showing sample data \u2014 project not found",
        fetch_failed: "Showing sample data \u2014 couldn\u2019t reach Foundry",
    };
    const el = document.createElement("div");
    el.className = "menu-note";
    el.textContent = map[reason] || "Showing sample data";
    return el;
}

// Section 1 of the model dropdown: models already deployed in the project.
function renderDeployList() {
    const host = document.getElementById("deployList");
    if (!host) return;
    const st = state.deploymentsState;
    host.replaceChildren();

    if (st.status === "loading") return host.appendChild(menuMsg("Loading deployments\u2026", "loading"));
    if (st.status === "error") return host.appendChild(menuError("Couldn\u2019t load deployments", () => loadDeployments(true)));
    if (st.status === "ready" && st.items.length === 0) return host.appendChild(menuMsg("No model deployments in this project", "empty"));

    for (const m of st.items) {
        const item = document.createElement("button");
        item.className = "menu-item";
        item.type = "button";
        item.setAttribute("role", "menuitem");

        const dot = document.createElement("span");
        dot.className = "model-dot";
        dot.style.background = m.color || "#57606a";

        const name = document.createElement("span");
        name.className = "item-name";
        name.textContent = m.name;
        item.append(dot, name);

        item.addEventListener("click", () => {
            closeModelMenu();
            sendToChat(withProjectContext(m.prompt));
        });
        host.appendChild(item);
    }
    if (st.source === "mock") host.appendChild(sampleNote(st.reason));
}

// Section 1 of the tools dropdown: tool connections already in the project.
function renderToolList() {
    const host = document.getElementById("toolList");
    if (!host) return;
    const st = state.connectionsState;
    host.replaceChildren();

    if (st.status === "loading") return host.appendChild(menuMsg("Loading connections\u2026", "loading"));
    if (st.status === "error") return host.appendChild(menuError("Couldn\u2019t load connections", () => loadConnections(true)));
    if (st.status === "ready" && st.items.length === 0) return host.appendChild(menuMsg("No tool connections in this project", "empty"));

    for (const t of st.items) {
        const item = document.createElement("button");
        item.className = "menu-item";
        item.type = "button";
        item.setAttribute("role", "menuitem");

        if (t.iconSrc) {
            const img = document.createElement("img");
            img.className = "menu-ticon";
            img.src = t.iconSrc;
            img.alt = "";
            item.appendChild(img);
        } else {
            const dot = document.createElement("span");
            dot.className = "model-dot";
            dot.style.background = t.color || "#57606a";
            item.appendChild(dot);
        }

        const name = document.createElement("span");
        name.className = "item-name";
        name.textContent = t.name;
        item.appendChild(name);

        item.addEventListener("click", () => {
            closeToolMenu();
            sendToChat(withProjectContext(t.prompt));
        });
        host.appendChild(item);
    }
    if (st.source === "mock") host.appendChild(sampleNote(st.reason));
}

// Section of the tools dropdown that lists Foundry Toolboxes in the project.
// Toolboxes are visually distinct from individual tool connections: they get a
// dedicated stacked-box icon and a "Toolbox" tag plus the default version.
function renderToolboxList() {
    const host = document.getElementById("toolboxList");
    if (!host) return;
    const st = state.toolboxesState;
    host.replaceChildren();

    if (st.status === "loading") return host.appendChild(menuMsg("Loading toolboxes\u2026", "loading"));
    if (st.status === "error") return host.appendChild(menuError("Couldn\u2019t load toolboxes", () => loadToolboxes(true)));
    if (st.status === "ready" && st.items.length === 0) return host.appendChild(menuMsg("No toolboxes in this project", "empty"));

    for (const t of st.items) {
        const wrap = document.createElement("div");
        wrap.className = "toolbox-wrap";

        // Header row: chevron + icon + name; the whole row toggles the tools.
        const item = document.createElement("button");
        item.className = "menu-item menu-item--toolbox";
        item.type = "button";
        item.setAttribute("role", "menuitem");
        item.setAttribute("aria-expanded", String(!!t.expanded));

        const chev = document.createElement("span");
        chev.className = "toolbox-chev" + (t.expanded ? " is-open" : "");
        chev.setAttribute("aria-hidden", "true");
        chev.innerHTML =
            '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M9 6 7.6 7.4 12.2 12l-4.6 4.6L9 18l6-6-6-6Z"/></svg>';
        item.appendChild(chev);

        const icon = document.createElement("span");
        icon.className = "toolbox-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.innerHTML =
            '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" ' +
            'd="M21 8.5 12 13 3 8.5 12 4l9 4.5Zm-9 6.2 9-4.5v6L12 21l-9-4.8v-6l9 4.5Z"/></svg>';
        item.appendChild(icon);

        const name = document.createElement("span");
        name.className = "item-name";
        name.textContent = t.name;
        item.appendChild(name);

        // "Use" selects the toolbox (prompt-to-chat); clicking elsewhere expands.
        const use = document.createElement("span");
        use.className = "toolbox-use";
        use.textContent = "Use";
        use.addEventListener("click", (e) => {
            e.stopPropagation();
            closeToolMenu();
            sendToChat(withProjectContext(t.prompt));
        });
        item.appendChild(use);

        item.addEventListener("click", (e) => {
            // Stop the document-level outside-click handler: re-rendering below
            // detaches this row, so its closest(".tool-select") would be null
            // and the menu would wrongly close.
            e.stopPropagation();
            t.expanded = !t.expanded;
            if (t.expanded) loadToolboxTools(t);
            renderToolboxList();
        });
        wrap.appendChild(item);

        if (t.expanded) {
            const tools = document.createElement("div");
            tools.className = "toolbox-tools";
            if (t.toolsStatus === "loading") {
                tools.appendChild(menuMsg("Loading tools\u2026", "loading"));
            } else if (t.toolsStatus === "error") {
                tools.appendChild(menuMsg("Couldn\u2019t load tools", "empty"));
            } else if ((t.tools || []).length === 0) {
                tools.appendChild(menuMsg("No tools in this toolbox", "empty"));
            } else {
                for (const tool of t.tools) {
                    const row = document.createElement("div");
                    row.className = "toolbox-tool";
                    row.textContent = tool.name + (tool.type ? `  \u00b7 ${tool.type}` : "");
                    tools.appendChild(row);
                }
            }
            wrap.appendChild(tools);
        }
        host.appendChild(wrap);
    }
}

// Lazily fetch a toolbox's tools the first time it's expanded; cached per row.
async function loadToolboxTools(t) {
    if (t.toolsStatus === "ready" || t.toolsStatus === "loading") return;
    t.toolsStatus = "loading";
    renderToolboxList();
    try {
        const qs = "name=" + encodeURIComponent(t.name) + (t.version ? "&version=" + encodeURIComponent(t.version) : "");
        const data = await getJSON("/api/toolbox/tools?" + qs);
        t.tools = Array.isArray(data.items) ? data.items : [];
        t.toolsStatus = data.ok ? "ready" : "error";
    } catch {
        t.toolsStatus = "error";
    }
    renderToolboxList();
}
async function loadDeployments(force) {
    const st = state.deploymentsState;
    if (!force && (st.status === "loading" || st.status === "ready")) return;
    st.status = "loading";
    renderDeployList();
    try {
        const data = await getJSON("/api/deployments");
        st.items = Array.isArray(data.items) ? data.items : [];
        st.source = data.source || null;
        st.reason = data.reason || null;
        st.status = "ready";
    } catch (err) {
        st.status = "error";
        st.reason = err.message;
    }
    renderDeployList();
}

async function loadConnections(force) {
    const st = state.connectionsState;
    if (!force && (st.status === "loading" || st.status === "ready")) return;
    st.status = "loading";
    renderToolList();
    try {
        const data = await getJSON("/api/connections");
        st.items = Array.isArray(data.items) ? data.items : [];
        st.source = data.source || null;
        st.reason = data.reason || null;
        st.status = "ready";
    } catch (err) {
        st.status = "error";
        st.reason = err.message;
    }
    renderToolList();
}

async function loadToolboxes(force) {
    const st = state.toolboxesState;
    if (!force && (st.status === "loading" || st.status === "ready")) return;
    st.status = "loading";
    renderToolboxList();
    try {
        const data = await getJSON("/api/toolboxes");
        st.items = Array.isArray(data.items) ? data.items : [];
        st.reason = data.reason || null;
        st.status = "ready";
    } catch (err) {
        st.status = "error";
        st.reason = err.message;
    }
    renderToolboxList();
}

function closeModelMenu() {
    const menu = document.getElementById("modelMenu");
    const btn = document.getElementById("modelAdd");
    if (menu) menu.hidden = true;
    if (btn) btn.setAttribute("aria-expanded", "false");
}

function toggleModelMenu() {
    const menu = document.getElementById("modelMenu");
    const btn = document.getElementById("modelAdd");
    if (!menu) return;
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    if (btn) btn.setAttribute("aria-expanded", String(willOpen));
    if (willOpen) loadDeployments(false);
}

function closeToolMenu() {
    const menu = document.getElementById("toolMenu");
    const btn = document.getElementById("toolAdd");
    if (menu) menu.hidden = true;
    if (btn) btn.setAttribute("aria-expanded", "false");
}

function toggleToolMenu() {
    const menu = document.getElementById("toolMenu");
    const btn = document.getElementById("toolAdd");
    if (!menu) return;
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    if (btn) btn.setAttribute("aria-expanded", String(willOpen));
    if (willOpen) {
        loadToolboxes(false);
    }
}

// ------------------------------------------------------- Project picker panel
const NO_PROJECT_LABEL = "Select a project";

function setProjectLabels(name) {
    const display = name || NO_PROJECT_LABEL;
    state.project = { ...state.project, name: name || "" };
    for (const id of ["projectName", "menuProject", "toolMenuProject", "toolboxMenuProject", "pmProjValue"]) {
        const el = document.getElementById(id);
        if (el) el.textContent = display;
    }
    // Grey the status dot when no project is selected so the header doesn't
    // imply a connected project that doesn't belong to the chosen subscription.
    const dot = document.querySelector(".project-dot");
    if (dot) dot.classList.toggle("is-unset", !name);
}

function closeProjectMenu() {
    const menu = document.getElementById("projectMenu");
    const btn = document.getElementById("projectSwitch");
    if (menu) menu.hidden = true;
    if (btn) btn.setAttribute("aria-expanded", "false");
    // Clear any search filters so they don't linger on reopen.
    const subSearch = document.getElementById("pmSubSearch");
    const projSearch = document.getElementById("pmProjSearch");
    if (subSearch && subSearch.value) {
        subSearch.value = "";
        renderSubList();
    }
    if (projSearch && projSearch.value) {
        projSearch.value = "";
        renderProjList();
    }
    // Fold the sub/project lists so they don't stay expanded on reopen.
    setAccordion(null);
}

function toggleProjectMenu() {
    const menu = document.getElementById("projectMenu");
    const btn = document.getElementById("projectSwitch");
    if (!menu) return;
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    if (btn) btn.setAttribute("aria-expanded", String(willOpen));
    if (willOpen) {
        renderIdentity();
        // Preload lists if signed in.
        if (state.identity.signedIn) {
            loadSubscriptions(false);
            loadProjects(false);
        }
    }
}

function renderIdentity() {
    const nameEl = document.getElementById("pmAccount");
    const tenantEl = document.getElementById("pmTenant");
    const avatarEl = document.getElementById("pmAvatar");
    const authBtn = document.getElementById("pmAuthBtn");
    const subValue = document.getElementById("pmSubValue");
    const id = state.identity;
    if (nameEl) nameEl.textContent = id.signedIn ? id.account || "Signed in" : "Not signed in";
    if (tenantEl) tenantEl.textContent = id.signedIn && id.tenantId ? "Tenant " + id.tenantId : "";
    if (avatarEl) avatarEl.textContent = (id.account || "?").trim().charAt(0) || "?";
    if (authBtn) {
        authBtn.textContent = id.signedIn ? "Sign out" : "Sign in";
        authBtn.disabled = false;
    }
    if (subValue && id.subscriptionName) {
        subValue.textContent = id.subscriptionName;
    }
}

async function loadIdentity() {
    try {
        const r = await getJSON("/api/identity");
        if (r && r.ok) {
            state.identity = {
                signedIn: !!r.signedIn,
                account: r.account || "",
                tenantId: r.tenantId || "",
                subscriptionId: r.subscriptionId || "",
                subscriptionName: r.subscriptionName || "",
            };
        }
    } catch {
        /* keep prior identity */
    }
    renderIdentity();
}

// ---- Device-code sign-in ----
function renderDevice(info) {
    const wrap = document.getElementById("pmDevice");
    const body = document.getElementById("pmDeviceBody");
    if (!wrap || !body) return;
    body.replaceChildren();
    if (!info) {
        wrap.hidden = true;
        body.className = "pm-device-row";
        return;
    }
    wrap.hidden = false;

    if (info.kind === "starting") {
        body.className = "pm-device-row is-busy";
        const sp = document.createElement("span");
        sp.className = "menu-spinner";
        const t = document.createElement("span");
        t.className = "pm-dc-label";
        t.textContent = "Starting sign-in\u2026";
        body.append(sp, t);
        return;
    }
    if (info.kind === "interactive") {
        body.className = "pm-device-row";
        const label = document.createElement("span");
        label.className = "pm-dc-label";
        label.textContent =
            "A sign-in window has opened. Pick your account / finish sign-in there \u2014 it continues automatically.";
        const foot = document.createElement("div");
        foot.className = "pm-dc-foot";
        const wait = document.createElement("span");
        wait.className = "pm-dc-wait";
        const sp = document.createElement("span");
        sp.className = "menu-spinner";
        const wt = document.createElement("span");
        wt.textContent = "Waiting for sign-in\u2026";
        wait.append(sp, wt);
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "pm-dc-cancel";
        cancel.textContent = "Cancel";
        cancel.addEventListener("click", (e) => {
            e.stopPropagation();
            cancelSignIn();
        });
        foot.append(wait, cancel);
        body.append(label, foot);
        return;
    }
    if (info.kind === "error") {
        body.className = "pm-device-row";
        const t = document.createElement("span");
        t.className = "pm-dc-label";
        t.textContent = info.message || "Sign-in failed";
        body.append(t);
        return;
    }

    // kind === "code"
    body.className = "pm-device-row";
    const label = document.createElement("span");
    label.className = "pm-dc-label";
    label.textContent = "To sign in, open the link and enter this code:";

    const codeRow = document.createElement("div");
    codeRow.className = "pm-dc-code";
    const code = document.createElement("span");
    code.textContent = info.code;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "pm-dc-copy";
    copy.textContent = "Copy";
    copy.addEventListener("click", (e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(info.code).then(() => toast("Code copied \u2713")).catch(() => {});
    });
    codeRow.append(code, copy);

    const link = document.createElement("a");
    link.className = "pm-dc-link";
    link.href = info.url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = info.url;

    const foot = document.createElement("div");
    foot.className = "pm-dc-foot";
    const wait = document.createElement("span");
    wait.className = "pm-dc-wait";
    const sp = document.createElement("span");
    sp.className = "menu-spinner";
    const wt = document.createElement("span");
    wt.textContent = "Waiting for sign-in\u2026";
    wait.append(sp, wt);
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "pm-dc-cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", (e) => {
        e.stopPropagation();
        cancelSignIn();
    });
    foot.append(wait, cancel);

    body.append(label, codeRow, link, foot);
}

async function startSignIn() {
    if (state.signin.starting) return;
    state.signin.starting = true;
    const authBtn = document.getElementById("pmAuthBtn");
    if (authBtn) authBtn.disabled = true;
    renderDevice({ kind: "starting" });
    try {
        const r = await postJSON("/api/signin", {});
        if (!r.ok || !r.sessionId) {
            const msg =
                r.reason === "identity_missing"
                    ? "Sign-in unavailable: the @azure/identity package is missing. Run npm install."
                    : "Couldn\u2019t start sign-in. Please try again.";
            renderDevice({ kind: "error", message: msg });
            state.signin.starting = false;
            if (authBtn) authBtn.disabled = false;
            return;
        }
        state.signin.sessionId = r.sessionId;
        if (r.mode === "device" && r.code) {
            renderDevice({ kind: "code", code: r.code, url: r.url });
        } else {
            renderDevice({ kind: "interactive" });
        }
        state.signin.timer = setInterval(pollSignIn, 2500);
    } catch (err) {
        renderDevice({ kind: "error", message: "Sign-in error: " + err.message });
        state.signin.starting = false;
        if (authBtn) authBtn.disabled = false;
    }
}

async function pollSignIn() {
    const sid = state.signin.sessionId;
    if (!sid) return stopSignInPolling();
    try {
        const r = await getJSON("/api/signin/status?sessionId=" + encodeURIComponent(sid));
        if (r.status === "done") {
            stopSignInPolling();
            renderDevice(null);
            if (r.identity) {
                state.identity = {
                    signedIn: !!r.identity.signedIn,
                    account: r.identity.account || "",
                    tenantId: r.identity.tenantId || "",
                    subscriptionId: r.identity.subscriptionId || "",
                    subscriptionName: r.identity.subscriptionName || "",
                };
            }
            renderIdentity();
            toast("Signed in \u2713");
            await afterAuthChange();
        } else if (r.status === "error" || r.status === "cancelled") {
            stopSignInPolling();
            renderDevice(r.status === "cancelled" ? null : { kind: "error", message: r.error || "Sign-in failed" });
        } else if (r.status === "pending" && r.mode === "device" && r.code && state.signin.shownCode !== r.code) {
            // az fell back to a device code mid-flight — surface it once.
            state.signin.shownCode = r.code;
            renderDevice({ kind: "code", code: r.code, url: r.url || "https://microsoft.com/devicelogin" });
        }
    } catch {
        /* transient — keep polling */
    }
}

function stopSignInPolling() {
    if (state.signin.timer) clearInterval(state.signin.timer);
    state.signin.timer = null;
    state.signin.sessionId = null;
    state.signin.starting = false;
    state.signin.shownCode = null;
    const authBtn = document.getElementById("pmAuthBtn");
    if (authBtn) authBtn.disabled = false;
}

async function cancelSignIn() {
    const sid = state.signin.sessionId;
    stopSignInPolling();
    renderDevice(null);
    if (sid) {
        try {
            await postJSON("/api/signin/cancel", { sessionId: sid });
        } catch {
            /* ignore */
        }
    }
}

async function doSignOut() {
    const authBtn = document.getElementById("pmAuthBtn");
    if (authBtn) authBtn.disabled = true;
    try {
        await postJSON("/api/signout", {});
    } catch {
        /* ignore */
    }
    state.identity = { signedIn: false, account: "", tenantId: "", subscriptionId: "", subscriptionName: "" };
    state.subsState = { status: "idle", items: [], reason: null };
    state.projState = { status: "idle", items: [], reason: null, sub: null };
    renderIdentity();
    renderSubList();
    renderProjList();
    const subValue = document.getElementById("pmSubValue");
    if (subValue) subValue.textContent = "\u2014";
    // Re-point selectors at fallback sample data.
    resetSelectors();
    toast("Signed out");
    if (authBtn) authBtn.disabled = false;
}

// After sign-in: refresh subscriptions, auto-select default sub + first project.
async function afterAuthChange() {
    state.subsState = { status: "idle", items: [], reason: null };
    state.projState = { status: "idle", items: [], reason: null, sub: null };
    await loadSubscriptions(true);
    try {
        const b = await getJSON("/api/bootstrap");
        if (b && b.ok) {
            if (b.subscriptionId) state.identity.subscriptionId = b.subscriptionId;
            if (b.project && b.project.name) setProjectLabels(b.project.name);
            const sub = state.subsState.items.find((s) => s.id === b.subscriptionId);
            const subValue = document.getElementById("pmSubValue");
            if (sub) state.identity.subscriptionName = sub.name;
            if (subValue && sub) subValue.textContent = sub.name;
            resetSelectors();
            await loadProjects(true);
        }
    } catch {
        /* keep current selection */
    }
}

// Force the model/tool dropdowns to refetch for the new project.
function resetSelectors() {
    state.deploymentsState = { status: "idle", items: [], source: null, reason: null };
    state.toolboxesState = { status: "idle", items: [], reason: null };
    renderDeployList();
    renderToolboxList();
}

// ---- Subscriptions ----
async function loadSubscriptions(force) {
    const st = state.subsState;
    if (!force && (st.status === "loading" || st.status === "ready")) return;
    st.status = "loading";
    renderSubList();
    try {
        const data = await getJSON("/api/subscriptions");
        st.items = Array.isArray(data.items) ? data.items : [];
        st.reason = data.ok ? null : data.reason;
        st.status = data.ok ? "ready" : "error";
        const def = st.items.find((s) => s.isDefault);
        const subValue = document.getElementById("pmSubValue");
        if (subValue && def && (!subValue.textContent || subValue.textContent === "\u2014")) {
            subValue.textContent = def.name;
        }
    } catch (err) {
        st.status = "error";
        st.reason = err.message;
    }
    renderSubList();
}

function renderSubList() {
    const host = document.getElementById("pmSubList");
    if (!host) return;
    const search = document.getElementById("pmSubSearch");
    const q = (search ? search.value : "").trim().toLowerCase();
    const st = state.subsState;
    host.replaceChildren();
    if (st.status === "loading") return host.appendChild(menuMsg("Loading subscriptions\u2026", "loading"));
    if (st.status === "error") return host.appendChild(menuError("Couldn\u2019t load subscriptions", () => loadSubscriptions(true)));
    const items = st.items.filter((s) => !q || s.name.toLowerCase().includes(q) || s.id.includes(q));
    if (!items.length) return host.appendChild(menuMsg(st.items.length ? "No matches" : "No subscriptions", "empty"));
    for (const s of items) host.appendChild(makePickRow(s.name, s.id, state.identity.subscriptionId === s.id, () => selectSubscription(s)));
}

async function selectSubscription(s) {
    state.identity.subscriptionId = s.id;
    state.identity.subscriptionName = s.name;
    const subValue = document.getElementById("pmSubValue");
    if (subValue) subValue.textContent = s.name;
    renderSubList();
    try {
        await postJSON("/api/select-subscription", { subscriptionId: s.id, subscriptionName: s.name });
    } catch {
        /* ignore */
    }
    // Reset + reload projects for the new subscription, then expand it.
    state.projState = { status: "idle", items: [], reason: null, sub: null };
    setAccordion("proj");
    loadProjects(true);
}

// ---- Projects ----
async function loadProjects(force) {
    const sub = state.identity.subscriptionId;
    const st = state.projState;
    if (!sub) {
        st.status = "error";
        st.reason = "no_subscription";
        return renderProjList();
    }
    if (!force && st.sub === sub && (st.status === "loading" || st.status === "ready")) return;
    st.status = "loading";
    st.sub = sub;
    renderProjList();
    try {
        const data = await getJSON("/api/projects?sub=" + encodeURIComponent(sub));
        st.items = Array.isArray(data.items) ? data.items : [];
        st.reason = data.ok ? null : data.reason;
        st.status = data.ok ? "ready" : "error";
        // Keep the header project consistent with the selected subscription:
        // if the currently displayed project isn't one of this subscription's
        // projects, clear it so we never show a project/subscription mismatch.
        if (st.status === "ready") {
            const cur = state.project?.name;
            if (cur && !st.items.some((p) => p.name === cur)) setProjectLabels("");
        }
    } catch (err) {
        st.status = "error";
        st.reason = err.message;
    }
    renderProjList();
}

function renderProjList() {
    const host = document.getElementById("pmProjList");
    if (!host) return;
    const search = document.getElementById("pmProjSearch");
    const q = (search ? search.value : "").trim().toLowerCase();
    const st = state.projState;
    host.replaceChildren();
    if (!state.identity.signedIn) return host.appendChild(menuMsg("Sign in to list projects", "empty"));
    if (st.status === "loading") return host.appendChild(menuMsg("Loading projects\u2026", "loading"));
    if (st.status === "error") return host.appendChild(menuError("Couldn\u2019t load projects", () => loadProjects(true)));
    const items = st.items.filter(
        (p) => !q || p.name.toLowerCase().includes(q) || (p.account || "").toLowerCase().includes(q),
    );
    if (!items.length) return host.appendChild(menuMsg(st.items.length ? "No matches" : "No projects in this subscription", "empty"));
    for (const p of items) {
        const sub = [p.account, p.rg, p.location].filter(Boolean).join(" \u00b7 ");
        host.appendChild(makePickRow(p.name, sub, state.project?.name === p.name, () => selectProject(p)));
    }
}

async function selectProject(p) {
    try {
        await postJSON("/api/select-project", {
            endpoint: p.endpoint,
            name: p.name,
            location: p.location || "",
            subscriptionId: state.identity.subscriptionId,
            subscriptionName: state.identity.subscriptionName,
        });
    } catch {
        /* ignore — still update locally */
    }
    setProjectLabels(p.name);
    state.project.endpoint = p.endpoint || "";
    closeProjectMenu();
    resetSelectors();
    toast("Project: " + p.name);
    // Re-evaluate hosted-agent region support for the newly selected project.
    loadRegionSupport();
}

// Generic search-list row.
function makePickRow(name, sub, active, onClick) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "pm-row" + (active ? " is-active" : "");
    const text = document.createElement("span");
    text.className = "pm-row-text";
    const nm = document.createElement("span");
    nm.className = "pm-row-name";
    nm.textContent = name;
    text.appendChild(nm);
    if (sub) {
        const sb = document.createElement("span");
        sb.className = "pm-row-sub";
        sb.textContent = sub;
        text.appendChild(sb);
    }
    row.appendChild(text);
    if (active) {
        const check = document.createElement("span");
        check.className = "item-check";
        check.textContent = "\u2713";
        row.appendChild(check);
    }
    row.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick();
    });
    return row;
}

// Accordion: only one body (sub|proj) expanded at a time.
function setAccordion(which) {
    const map = { sub: ["pmSubAcc", "pmSubBody"], proj: ["pmProjAcc", "pmProjBody"] };
    for (const key of Object.keys(map)) {
        const [accId, bodyId] = map[key];
        const acc = document.getElementById(accId);
        const body = document.getElementById(bodyId);
        const open = key === which;
        if (acc) acc.setAttribute("aria-expanded", String(open));
        if (body) body.hidden = !open;
    }
}

function toggleAccordion(which) {
    const map = { sub: "pmSubBody", proj: "pmProjBody" };
    const body = document.getElementById(map[which]);
    const isOpen = body && !body.hidden;
    setAccordion(isOpen ? null : which);
    if (!isOpen) {
        if (which === "sub") loadSubscriptions(false);
        if (which === "proj") loadProjects(false);
    }
}

// ------------------------------------------------------------- Catalog views
function tileLabel(item, kind) {
    if (kind === "tools") return item.icon || item.name.slice(0, 2).toUpperCase();
    return (item.provider || item.name).trim().charAt(0).toUpperCase();
}

function makeCard(item, kind, featured) {
    const card = document.createElement("div");
    card.className = "tcard" + (featured ? " is-featured" : "");

    const top = document.createElement("div");
    top.className = "tcard-top";

    if (item.iconSrc) {
        const img = document.createElement("img");
        img.className = "tile tile-img " + (kind === "models" ? "is-round" : "is-square");
        img.src = item.iconSrc;
        img.alt = (item.provider || item.name) + " icon";
        img.width = 36;
        img.height = 36;
        img.loading = "lazy";
        top.appendChild(img);
    } else {
        const tile = document.createElement("span");
        tile.className = "tile";
        tile.style.background = item.color || "#57606a";
        tile.textContent = tileLabel(item, kind);
        top.appendChild(tile);
    }

    const meta = document.createElement("div");
    const name = document.createElement("div");
    name.className = "tcard-name";
    name.textContent = item.name;
    const sub = document.createElement("div");
    sub.className = "tcard-meta";
    sub.textContent = kind === "tools" ? item.category : item.provider;
    meta.append(name, sub);
    top.appendChild(meta);
    card.appendChild(top);

    const blurb = document.createElement("p");
    blurb.className = "tcard-blurb";
    blurb.textContent = item.blurb || "";
    card.appendChild(blurb);

    const actions = document.createElement("div");
    actions.className = "tcard-actions";
    const add = document.createElement("button");
    add.className = "add-pill";
    add.type = "button";
    add.textContent = kind === "tools" ? "Add tool" : "Add model";
    if (kind === "tools") {
        // Tools are added into a Foundry Toolbox. Let the developer pick which
        // toolbox to add into (or create a new one). The add itself is performed
        // directly against the Foundry data-plane API (see openToolboxPicker),
        // falling back to a chat prompt only when a connection is required.
        add.setAttribute("aria-haspopup", "menu");
        add.addEventListener("click", (e) => {
            e.stopPropagation();
            // Work IQ is a family of Microsoft 365 MCP sub-tools — let the
            // developer pick which ones before choosing a toolbox.
            if (item.id === "workiq") {
                openWorkIQDialog(add, item);
                return;
            }
            openToolboxPicker(add, item);
        });
    } else {
        add.addEventListener("click", () => sendToChat(withProjectContext(item.prompt)));
    }
    actions.appendChild(add);
    card.appendChild(actions);

    return card;
}

// Client-side prompt builders for adding a catalog tool into a toolbox. These
// mirror the toolbox flow but are built at click time because they depend on
// the developer's chosen target toolbox.
function addToolToToolboxPrompt(toolName, toolboxName) {
    return (
        `Add the ${toolName} tool to my existing "${toolboxName}" Foundry Toolbox, ` +
        "then make sure my Foundry agent uses that toolbox"
    );
}
function addToolToNewToolboxPrompt(toolName) {
    return (
        `Create a new Foundry Toolbox containing the ${toolName} tool, ` +
        "then make sure my Foundry agent uses that toolbox"
    );
}

// Auto-generate a toolbox name for a catalog tool, e.g. "toolbox-web-search-0627".
function newToolboxName(toolItem) {
    const slug =
        (toolItem.id || toolItem.name || "tool")
            .toString()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 24) || "tool";
    const d = new Date();
    const mmdd = String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
    return `toolbox-${slug}-${mmdd}`;
}

// True for fetch failures caused by this panel's backing server being gone.
function isDeadServer(err) {
    return err instanceof TypeError || /failed to fetch/i.test(err?.message || "");
}

// Add a catalog tool into an EXISTING toolbox via the data-plane API. Connection-
// backed tools we can't wire automatically (reason 'needs_connection') and any
// hard error fall back to the chat prompt so the developer is never blocked.
async function apiAddToolToToolbox(toolItem, toolboxName) {
    toast(`Adding ${toolItem.name} to ${toolboxName}\u2026`);
    try {
        const r = await postJSON("/api/toolbox/add-tool", {
            toolbox: toolboxName,
            toolId: toolItem.id,
            toolName: toolItem.name,
        });
        if (r.ok) {
            toast(
                r.already
                    ? `${toolItem.name} is already in ${toolboxName}`
                    : `Added ${toolItem.name} to ${toolboxName}${r.version ? ` \u00b7 v${r.version}` : ""} \u2713`,
            );
            await loadToolboxes(true);
            return;
        }
        if (r.reason === "needs_connection") {
            sendToChat(withProjectContext(addToolToToolboxPrompt(toolItem.name, toolboxName)));
            return;
        }
        throw new Error(r.detail || r.reason || "add failed");
    } catch (err) {
        if (isDeadServer(err)) {
            toast("Lost connection to the builder. Reopen the Foundry Agent Canvas, then try again.");
            return;
        }
        sendToChat(withProjectContext(addToolToToolboxPrompt(toolItem.name, toolboxName)));
    }
}

// Create a NEW toolbox (auto-named) containing just the catalog tool, via the
// API. Same connection/error fallback to the chat prompt.
async function apiCreateToolboxWithTool(toolItem) {
    const name = newToolboxName(toolItem);
    toast(`Creating ${name}\u2026`);
    try {
        const r = await postJSON("/api/toolbox/create-with-tool", {
            name,
            toolId: toolItem.id,
            toolName: toolItem.name,
        });
        if (r.ok) {
            toast(`Created ${name} with ${toolItem.name}${r.version ? ` \u00b7 v${r.version}` : ""} \u2713`);
            await loadToolboxes(true);
            return;
        }
        if (r.reason === "needs_connection") {
            sendToChat(withProjectContext(addToolToNewToolboxPrompt(toolItem.name)));
            return;
        }
        throw new Error(r.detail || r.reason || "create failed");
    } catch (err) {
        if (isDeadServer(err)) {
            toast("Lost connection to the builder. Reopen the Foundry Agent Canvas, then try again.");
            return;
        }
        sendToChat(withProjectContext(addToolToNewToolboxPrompt(toolItem.name)));
    }
}

// Remove any open catalog toolbox picker popover.
function closeToolboxPicker() {
    const open = document.querySelector(".toolbox-picker");
    if (open) open.remove();
    document.removeEventListener("click", closeToolboxPicker);
}

// "Add tool" → pick a target Foundry Toolbox. Reads the existing toolbox list
// (read-only) and performs the add directly via the data-plane API. If the
// project has no toolbox yet, skip the picker and create a new one for this tool.
async function openToolboxPicker(anchorBtn, toolItem, handlers) {
    closeToolboxPicker();
    const onExisting = handlers?.onExisting || apiAddToolToToolbox;
    const onNew = handlers?.onNew || apiCreateToolboxWithTool;

    // Load toolboxes if we don't already have them.
    if (state.toolboxesState.status !== "ready") {
        anchorBtn.disabled = true;
        const prev = anchorBtn.textContent;
        anchorBtn.textContent = "Loading\u2026";
        await loadToolboxes(true);
        anchorBtn.disabled = false;
        anchorBtn.textContent = prev;
    }

    const toolboxes = state.toolboxesState.items || [];

    // No toolbox available → create a new toolbox for this tool.
    if (toolboxes.length === 0) {
        onNew(toolItem);
        return;
    }

    const menu = document.createElement("div");
    menu.className = "model-menu toolbox-picker";
    menu.setAttribute("role", "menu");

    const head = document.createElement("div");
    head.className = "menu-section";
    const label = document.createElement("div");
    label.className = "menu-label toolbox-picker-label";
    label.textContent = `Add ${toolItem.name} to a toolbox`;
    head.appendChild(label);

    // Scrollable container so a long toolbox list doesn't overflow the panel.
    const list = document.createElement("div");
    list.className = "toolbox-picker-list";
    for (const tb of toolboxes) {
        const row = document.createElement("button");
        row.className = "menu-item";
        row.type = "button";
        row.setAttribute("role", "menuitem");
        const icon = document.createElement("span");
        icon.className = "toolbox-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.innerHTML =
            '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" ' +
            'd="M21 8.5 12 13 3 8.5 12 4l9 4.5Zm-9 6.2 9-4.5v6L12 21l-9-4.8v-6l9 4.5Z"/></svg>';
        row.appendChild(icon);
        const nm = document.createElement("span");
        nm.className = "item-name";
        nm.textContent = tb.name;
        row.appendChild(nm);
        row.addEventListener("click", (e) => {
            e.stopPropagation();
            closeToolboxPicker();
            onExisting(toolItem, tb.name);
        });
        list.appendChild(row);
    }
    head.appendChild(list);
    menu.appendChild(head);

    // Always offer a "new toolbox" escape hatch.
    const sep = document.createElement("div");
    sep.className = "menu-sep";
    menu.appendChild(sep);
    const newRow = document.createElement("button");
    newRow.className = "menu-item";
    newRow.type = "button";
    newRow.setAttribute("role", "menuitem");
    const plus = document.createElement("span");
    plus.className = "toolbox-picker-plus";
    plus.textContent = "+";
    newRow.appendChild(plus);
    const newName = document.createElement("span");
    newName.className = "item-name";
    newName.textContent = "Add to a new toolbox";
    newRow.appendChild(newName);
    newRow.addEventListener("click", (e) => {
        e.stopPropagation();
        closeToolboxPicker();
        onNew(toolItem);
    });
    menu.appendChild(newRow);

    // Anchor the popover to the button.
    const host = anchorBtn.closest(".tcard-actions") || anchorBtn.parentElement;
    host.style.position = "relative";
    host.appendChild(menu);

    // Close on the next outside click.
    setTimeout(() => document.addEventListener("click", closeToolboxPicker), 0);
}

// ── Work IQ sub-tool picker ─────────────────────────────────────────────────
// Clicking Work IQ opens this dialog so the developer can pick which Microsoft
// 365 MCP sub-tools to add. Selected variants are then added to a toolbox (the
// backend creates the secret-free OBO connection for each automatically).
function closeWorkIQDialog() {
    const open = document.querySelector(".wiq-overlay");
    if (open) open.remove();
}

async function openWorkIQDialog(anchorBtn, toolItem) {
    closeWorkIQDialog();

    const overlay = document.createElement("div");
    overlay.className = "wiq-overlay";
    const panel = document.createElement("div");
    panel.className = "wiq-dialog";
    overlay.appendChild(panel);

    const title = document.createElement("div");
    title.className = "wiq-title";
    title.textContent = "Add Work IQ tools";
    const sub = document.createElement("div");
    sub.className = "wiq-sub";
    sub.textContent = "Pick the Microsoft 365 tools to add. A connection is created for each automatically.";
    panel.append(title, sub);

    const listWrap = document.createElement("div");
    listWrap.className = "wiq-list";
    listWrap.innerHTML = '<div class="wiq-loading"><span class="menu-spinner"></span> Loading Work IQ tools\u2026</div>';
    panel.appendChild(listWrap);

    const footer = document.createElement("div");
    footer.className = "wiq-footer";
    const cancel = document.createElement("button");
    cancel.className = "wiq-btn wiq-btn-ghost";
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", closeWorkIQDialog);
    const addBtn = document.createElement("button");
    addBtn.className = "wiq-btn wiq-btn-primary";
    addBtn.type = "button";
    addBtn.textContent = "Add";
    addBtn.disabled = true;
    footer.append(cancel, addBtn);
    panel.appendChild(footer);

    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) closeWorkIQDialog();
    });

    let variants = [];
    try {
        const r = await getJSON("/api/workiq/variants");
        variants = (r && r.data) || [];
    } catch {
        variants = [];
    }
    // Dialog may have been dismissed while loading.
    if (!document.body.contains(overlay)) return;

    if (!variants.length) {
        listWrap.innerHTML = '<div class="wiq-empty">Couldn\u2019t load Work IQ tools. Close and try again.</div>';
        return;
    }

    listWrap.innerHTML = "";
    const checks = new Map();
    const refreshAdd = () => {
        addBtn.disabled = ![...checks.values()].some((c) => c.cb.checked);
    };
    for (const v of variants) {
        const row = document.createElement("label");
        row.className = "wiq-row";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = v.entityId;
        const nm = document.createElement("span");
        nm.className = "wiq-row-name";
        nm.textContent = v.title;
        row.append(cb, nm);
        listWrap.appendChild(row);
        checks.set(v.entityId, { cb, title: v.title });
        cb.addEventListener("change", refreshAdd);
    }

    addBtn.addEventListener("click", () => {
        const selected = [...checks.entries()].filter(([, c]) => c.cb.checked);
        if (!selected.length) return;
        const variantIds = selected.map(([id]) => id);
        const titles = selected.map(([, c]) => c.title);
        closeWorkIQDialog();
        // Now choose a target toolbox (existing or new), then add + create
        // connections via the Work IQ API routes.
        openToolboxPicker(anchorBtn, toolItem, {
            onExisting: (ti, name) => apiAddWorkIQToolsToToolbox(ti, name, variantIds, titles),
            onNew: (ti) => apiCreateToolboxWithWorkIQTools(ti, variantIds, titles),
        });
    });
}

// Prompt fallback when the API can't create the connection (e.g. project ARM id
// couldn't be resolved) — hand the work to the chat agent instead.
function workIqPrompt(titles, toolboxName) {
    const list = titles.join(", ");
    if (toolboxName) {
        return (
            `Add these Work IQ tools to my "${toolboxName}" Foundry Toolbox: ${list}. ` +
            "Create the required Work IQ connections in Foundry, then make sure my Foundry agent uses that toolbox."
        );
    }
    return (
        `Create a new Foundry Toolbox with these Work IQ tools: ${list}. ` +
        "Create the required Work IQ connections in Foundry, then make sure my Foundry agent uses that toolbox."
    );
}

function summarizeWorkIQResults(results, toolboxName, version) {
    const rs = results || [];
    const added = rs.filter((r) => r.ok && !r.already).length;
    const already = rs.filter((r) => r.ok && r.already).length;
    const created = rs.filter((r) => r.created).length;
    const bits = [];
    if (added) bits.push(`Added ${added} Work IQ tool${added > 1 ? "s" : ""}`);
    if (already) bits.push(`${already} already present`);
    let msg = bits.join(" \u00b7 ") || "No changes";
    if (toolboxName) msg += ` \u2192 ${toolboxName}`;
    if (version) msg += ` \u00b7 v${version}`;
    if (created) msg += ` (${created} connection${created > 1 ? "s" : ""} created)`;
    return `${msg} \u2713`;
}

async function apiAddWorkIQToolsToToolbox(toolItem, toolboxName, variantIds, titles) {
    const n = variantIds.length;
    toast(`Adding ${n} Work IQ tool${n > 1 ? "s" : ""} to ${toolboxName}\u2026`);
    try {
        const r = await postJSON("/api/workiq/add-tools", { toolbox: toolboxName, variantIds });
        if (r.ok) {
            toast(summarizeWorkIQResults(r.results, toolboxName, r.version));
            await loadToolboxes(true);
            return;
        }
        if (r.reason === "needs_connection" || r.reason === "no_project") {
            sendToChat(withProjectContext(workIqPrompt(titles, toolboxName)));
            return;
        }
        throw new Error(r.detail || r.reason || "add failed");
    } catch (err) {
        if (isDeadServer(err)) {
            toast("Lost connection to the builder. Reopen the Foundry Agent Canvas, then try again.");
            return;
        }
        sendToChat(withProjectContext(workIqPrompt(titles, toolboxName)));
    }
}

async function apiCreateToolboxWithWorkIQTools(toolItem, variantIds, titles) {
    const name = newToolboxName(toolItem);
    toast(`Creating ${name}\u2026`);
    try {
        const r = await postJSON("/api/workiq/create-with-tools", { name, variantIds });
        if (r.ok) {
            toast(summarizeWorkIQResults(r.results, name, r.version));
            await loadToolboxes(true);
            return;
        }
        if (r.reason === "needs_connection" || r.reason === "no_project") {
            sendToChat(withProjectContext(workIqPrompt(titles, "")));
            return;
        }
        throw new Error(r.detail || r.reason || "create failed");
    } catch (err) {
        if (isDeadServer(err)) {
            toast("Lost connection to the builder. Reopen the Foundry Agent Canvas, then try again.");
            return;
        }
        sendToChat(withProjectContext(workIqPrompt(titles, "")));
    }
}

async function renderCatalog(kind) {
    const node = clone("tpl-catalog");
    const isTools = kind === "tools";

    node.querySelector("#catalogTitle").textContent = isTools ? "Add a tool" : "Add a model";
    node.querySelector("#catalogSub").textContent = isTools
        ? "Connect your Foundry agent to external systems and actions."
        : "Choose a model to power your Foundry agent.";
    node.querySelector("#recoLabel").textContent = isTools
        ? "Microsoft Foundry built-in tools"
        : "Most popular";
    node.querySelector("#moreLabel").textContent = isTools ? "More tools" : "More models";

    root.replaceChildren(node);

    let list = state.cache[kind];
    if (!list) {
        try {
            const data = await getJSON(isTools ? "/api/tools" : "/api/models");
            list = isTools ? data.tools : data.models;
            state.cache[kind] = list;
        } catch (err) {
            toast("Failed to load: " + err.message);
            return;
        }
    }

    const recoGrid = node.querySelector("#recoGrid");
    const moreGrid = node.querySelector("#moreGrid");
    recoGrid.replaceChildren();
    moreGrid.replaceChildren();

    for (const item of list) {
        if (item.recommended) recoGrid.appendChild(makeCard(item, kind, !!item.featured));
        else moreGrid.appendChild(makeCard(item, kind, false));
    }
}

// ------------------------------------------------------------------- Router
function render(page) {
    state.page = page;
    if (page === "tools" || page === "models") renderCatalog(page);
    else renderBuild();
}

// ----------------------------------------------------------- Event handling
// Delegated clicks within the main area.
root.addEventListener("click", (e) => {
    const nav = e.target.closest("[data-nav]");
    if (nav) {
        render(nav.getAttribute("data-nav"));
        return;
    }
    if (e.target.closest("#initToggle")) {
        state.init.open = !state.init.open;
        renderInit();
        return;
    }
    if (e.target.closest("#resourcesToggle")) {
        state.folds.resources = !state.folds.resources;
        applyFold("resourcesBlock", state.folds.resources);
        return;
    }
    if (e.target.closest("#deployToggle")) {
        state.folds.deploy = !state.folds.deploy;
        applyFold("deployBlock", state.folds.deploy);
        return;
    }
    if (e.target.closest("#initStart")) {
        const ta = document.getElementById("initPrompt");
        const text = (ta ? ta.value : state.init.promptText).trim();
        if (text) sendToChat(withProjectContext(text));
        return;
    }
    if (e.target.closest("#initReset")) {
        state.init.promptDirty = false;
        syncInitPrompt();
        return;
    }
    if (e.target.closest("#prepPrereqs")) {
        installSkills();
        return;
    }
    if (e.target.closest("#inspireIdea")) {
        sendToChat(
            "Suggest one creative but practical single-purpose agent I could build as a Microsoft " +
                "Foundry hosted agent. Answer from your own knowledge only — do NOT use web search, " +
                "web fetch, or any tools except the canvas action. Reply with ONE short sentence " +
                "(no preamble, no lists, no extra explanation), then immediately call the Foundry " +
                'Agent Canvas\'s "setAgentIdea" action once with a short 2-4 word phrase that fits ' +
                '"Create a ___ Python hosted agent" (for example "meeting-notes-summarizing" or ' +
                '"invoice-parsing").',
        );
        return;
    }
    if (e.target.closest("#decideProtocol")) {
        decideProtocol();
        return;
    }
    if (e.target.closest("#modelAdd")) {
        toggleModelMenu();
        return;
    }
    if (e.target.closest("#deployRefresh")) {
        loadDeployments(true);
        return;
    }
    if (e.target.closest("#toolAdd")) {
        toggleToolMenu();
        return;
    }
    if (e.target.closest("#toolboxRefresh")) {
        loadToolboxes(true);
        return;
    }
    if (e.target.closest("#projectSwitch")) {
        toggleProjectMenu();
        return;
    }
    if (e.target.closest("#pmAuthBtn")) {
        if (state.identity.signedIn) doSignOut();
        else startSignIn();
        return;
    }
    const acc = e.target.closest(".pm-acc");
    if (acc) {
        toggleAccordion(acc.getAttribute("data-acc"));
        return;
    }
    // Clicks inside the project panel shouldn't fall through to data-soon etc.
    if (e.target.closest(".project-menu")) return;
    const soon = e.target.closest("[data-soon]");
    if (soon) {
        if (soon.classList.contains("toggle")) {
            const on = soon.getAttribute("aria-checked") === "true";
            soon.setAttribute("aria-checked", String(!on));
        }
        toast(soon.getAttribute("data-soon") + " \u2014 coming soon");
        return;
    }
    const chipX = e.target.closest(".chip-x");
    if (chipX) {
        chipX.closest(".chip").remove();
        return;
    }
    if (e.target.closest("#deployBtn")) {
        if (state.hostedRegion.supported === false) {
            const loc = prettyRegion(state.hostedRegion.location);
            toast(
                loc
                    ? `Hosted agents aren't supported in ${loc} — pick a project in a supported region`
                    : "Hosted agents aren't supported in this project's region",
            );
            return;
        }
        sendToChat(withProjectContext(state.deployPrompt));
        return;
    }
    if (e.target.closest("#inspectBtn")) {
        launchInspector(e.target.closest("#inspectBtn"));
    }
});

// ----------------------------------------------- Local Agent Inspector embed
async function launchInspector(btn) {
    const view = document.getElementById("inspectorView");
    const frame = document.getElementById("inspectorFrame");
    const statusEl = document.getElementById("inspectorStatus");
    const waitingEl = document.getElementById("inspectorWaiting");
    if (!view || !frame) return;

    // Ask the chat agent to start the Foundry agent locally so it is running
    // and ready to be inspected. Fire-and-forget so it doesn't block opening
    // the inspector view below.
    sendToChat(state.inspectPrompt);

    const label = btn ? btn.innerHTML : "";
    if (btn) {
        btn.disabled = true;
        btn.textContent = "Starting\u2026";
    }
    statusEl.hidden = true;

    try {
        const data = await getJSON("/api/inspect/start");
        if (data && data.ok && data.url) {
            // Show the inspector view immediately with a waiting overlay — the
            // iframe src is set below but the agent may not be up yet.
            view.hidden = false;
            if (waitingEl) waitingEl.hidden = false;
            frame.src = "";

            // Poll until the agent is reachable, then load the frame.
            const POLL_INTERVAL_MS = 2000;
            const POLL_TIMEOUT_MS = 120_000;
            const deadline = Date.now() + POLL_TIMEOUT_MS;

            const poll = async () => {
                if (Date.now() > deadline) {
                    if (waitingEl) waitingEl.hidden = true;
                    statusEl.textContent = "Agent did not start within 2 minutes. Check the terminal for errors.";
                    statusEl.hidden = false;
                    frame.src = data.url; // load anyway so user sees the inspector error
                    return;
                }
                try {
                    const r = await getJSON("/api/inspect/ready");
                    if (r && r.ready) {
                        if (waitingEl) waitingEl.hidden = true;
                        frame.src = data.url;
                        return;
                    }
                } catch {
                    /* network error — keep polling */
                }
                setTimeout(poll, POLL_INTERVAL_MS);
            };
            setTimeout(poll, POLL_INTERVAL_MS);
        } else {
            const msg = (data && data.error) || "Inspector not ready.";
            statusEl.textContent = msg;
            statusEl.hidden = false;
            view.hidden = false;
            toast(msg);
        }
    } catch (err) {
        toast("Could not start inspector: " + err.message);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = label;
        }
    }
}

function closeInspector() {
    const view = document.getElementById("inspectorView");
    const frame = document.getElementById("inspectorFrame");
    const waitingEl = document.getElementById("inspectorWaiting");
    if (view) view.hidden = true;
    if (frame) frame.src = "";
    if (waitingEl) waitingEl.hidden = true;
}

document.addEventListener("click", (e) => {
    if (e.target.closest("#inspectorBack")) closeInspector();
});

// Close the model dropdown when clicking anywhere outside of it.
document.addEventListener("click", (e) => {
    if (!e.target.closest(".model-select")) closeModelMenu();
    if (!e.target.closest(".tool-select")) closeToolMenu();
    if (!e.target.closest(".project-switch")) closeProjectMenu();
});

// Live search inside the picker panel (delegated — panel is re-cloned per render).
root.addEventListener("input", (e) => {
    if (e.target.id === "pmSubSearch") renderSubList();
    else if (e.target.id === "pmProjSearch") renderProjList();
    else if (e.target.id === "initPrompt") {
        state.init.promptDirty = true;
        state.init.promptText = e.target.value;
    }
});

// ------------------------------------------------------- Init + live updates
async function init() {
    try {
        const s = await getJSON("/api/state");
        if (s.agentName) state.agentName = s.agentName;
        if (s.project) state.project = s.project;
        if (s.model) state.model = s.model;
        if (s.deployPrompt) state.deployPrompt = s.deployPrompt;
        if (s.inspectPrompt) state.inspectPrompt = s.inspectPrompt;
        render(s.page || "build");
    } catch {
        render("build");
    }

    // Seed the Build sections' expand/fold state from whether the workspace is
    // already scaffolded (azure.yaml / agent.yaml). Non-fatal: on failure we
    // keep the static defaults.
    try {
        const pi = await getJSON("/api/project-init");
        if (pi && pi.ok) applyInitDefaults(pi);
    } catch {
        /* keep static fold defaults */
    }

    // Resolve the default selection (az default subscription + first project)
    // and the signed-in identity. Falls back to the parsed project name.
    try {
        const b = await getJSON("/api/bootstrap");
        if (b && b.ok) {
            if (b.identity) {
                state.identity = {
                    signedIn: !!b.identity.signedIn,
                    account: b.identity.account || "",
                    tenantId: b.identity.tenantId || "",
                    subscriptionId: b.identity.subscriptionId || "",
                    subscriptionName: b.identity.subscriptionName || "",
                };
            }
            if (b.project && b.project.name) {
                setProjectLabels(b.project.name);
                state.project.endpoint = b.project.endpoint || "";
            } else if (state.identity.signedIn) {
                // Signed in but no project resolved in the selected
                // subscription — show a neutral placeholder consistent with
                // the (empty) project list rather than a stale default.
                setProjectLabels("");
            }
            renderIdentity();
        } else {
            const p = await getJSON("/api/project");
            if (p && p.name) setProjectLabels(p.name);
        }
    } catch {
        try {
            const p = await getJSON("/api/project");
            if (p && p.name) setProjectLabels(p.name);
        } catch {
            /* keep default project label */
        }
    }

    // Evaluate hosted-agent region support for the resolved project so the
    // Deploy button/warning are correct on first paint. Non-fatal.
    try {
        await loadRegionSupport();
    } catch {
        /* fail open — leave Deploy enabled */
    }

    // Optional: let an agent-invoked navigate() action reflect in the open iframe.
    try {
        const es = new EventSource("/events");
        es.addEventListener("message", (ev) => {
            try {
                const msg = JSON.parse(ev.data);
                if (msg.type === "navigate" && msg.page) render(msg.page);
                else if (msg.type === "setProtocol" && msg.protocol) setInitProtocol(msg.protocol);
                else if (msg.type === "setIdea" && msg.idea) setInitIdea(msg.idea);
            } catch {
                /* ignore malformed frames */
            }
        });
    } catch {
        /* SSE unsupported — non-fatal */
    }
}

init();
