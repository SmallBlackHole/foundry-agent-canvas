(function () {
    "use strict";

    const MOCK_PARAM_KEYS = ["skillStatus", "signedIn", "project", "az", "azd"];
    const STATUS_OPTIONS = [
        ["missing", "not installed"],
        ["outdated", "outdated"],
        ["latest", "latest installed"],
        ["unknown", "check failed"],
    ];

    const originalFetch = window.fetch.bind(window);

    function withMockParams(input) {
        const raw = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
        if (!raw) return input;
        const next = new URL(raw, window.location.origin);
        if (next.origin !== window.location.origin || !next.pathname.startsWith("/api/")) return input;

        const pageParams = new URLSearchParams(window.location.search);
        if (!MOCK_PARAM_KEYS.some((key) => pageParams.has(key))) return input;
        for (const key of MOCK_PARAM_KEYS) {
            if (pageParams.has(key)) next.searchParams.set(key, pageParams.get(key));
        }

        if (input instanceof Request) return new Request(next, input);
        if (input instanceof URL) return next;
        return next.pathname + next.search;
    }

    window.fetch = function previewFetch(input, init) {
        return originalFetch(withMockParams(input), init);
    };

    function boolValue(params, key) {
        return params.get(key) !== "false";
    }

    function config() {
        const params = new URLSearchParams(window.location.search);
        const signedIn = boolValue(params, "signedIn");
        return {
            skillStatus: params.get("skillStatus") || "missing",
            signedIn,
            project: signedIn && boolValue(params, "project"),
            az: boolValue(params, "az"),
            azd: boolValue(params, "azd"),
        };
    }

    function setParam(key, value) {
        const params = new URLSearchParams(window.location.search);
        params.set(key, String(value));
        if (key === "signedIn" && value === false) params.set("project", "false");
        if (key === "project" && value === true) params.set("signedIn", "true");
        window.location.search = params.toString();
    }

    function checkbox(key, label, checked) {
        const wrap = document.createElement("label");
        wrap.className = "preview-mock-check";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = checked;
        input.dataset.mockKey = key;
        const span = document.createElement("span");
        span.textContent = label;
        wrap.append(input, span);
        return wrap;
    }

    function section(label, children) {
        const node = document.createElement("div");
        node.className = "preview-mock-section";
        const head = document.createElement("div");
        head.className = "preview-mock-label";
        head.textContent = label;
        node.append(head, ...children);
        return node;
    }

    function renderPanel() {
        const cfg = config();
        let panel = document.getElementById("previewMockPanel");
        if (!panel) {
            panel = document.createElement("aside");
            panel.id = "previewMockPanel";
            panel.className = "preview-mock";
            document.body.appendChild(panel);
        }
        panel.classList.toggle("is-collapsed", localStorage.getItem("previewMockCollapsed") === "true");

        panel.replaceChildren();

        const header = document.createElement("div");
        header.className = "preview-mock-header";

        const title = document.createElement("div");
        title.className = "preview-mock-title";
        const titleIcon = document.createElement("span");
        titleIcon.className = "preview-mock-icon";
        titleIcon.innerHTML =
            '<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">' +
            '<path fill="currentColor" d="M10.7 1.3a1 1 0 0 1 0 1.4l-.8.8 2.6 2.6a2 2 0 0 1 0 2.8l-4.6 4.6a3 3 0 0 1-4.2 0l-1.2-1.2a3 3 0 0 1 0-4.2l4.6-4.6 1.2 1.2-4.6 4.6a1.3 1.3 0 0 0 0 1.8l1.2 1.2a1.3 1.3 0 0 0 1.8 0l4.6-4.6a.3.3 0 0 0 0-.4L8.7 4.7l-.8.8a1 1 0 0 1-1.4-1.4l2.8-2.8a1 1 0 0 1 1.4 0Z"/>' +
            '<path fill="currentColor" d="M4.4 8.8 7.2 6l2.8 2.8-2.8 2.8a1.6 1.6 0 0 1-2.3 0l-.5-.5a1.6 1.6 0 0 1 0-2.3Z"/>' +
            '</svg>';
        const titleText = document.createElement("span");
        titleText.textContent = "Canvas mock";
        title.append(titleIcon, titleText);

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "preview-mock-toggle";
        toggle.setAttribute("aria-controls", "previewMockBody");
        toggle.setAttribute("aria-expanded", String(!panel.classList.contains("is-collapsed")));
        toggle.title = panel.classList.contains("is-collapsed") ? "Expand mock settings" : "Collapse mock settings";
        toggle.innerHTML =
            '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
            '<path fill="currentColor" d="M4.2 6.2 8 10l3.8-3.8 1.1 1.1L8 12.2 3.1 7.3l1.1-1.1Z"/>' +
            '</svg>';
        toggle.addEventListener("click", () => {
            const collapsed = panel.classList.toggle("is-collapsed");
            localStorage.setItem("previewMockCollapsed", String(collapsed));
            toggle.setAttribute("aria-expanded", String(!collapsed));
            toggle.title = collapsed ? "Expand mock settings" : "Collapse mock settings";
        });

        header.append(title, toggle);

        const body = document.createElement("div");
        body.id = "previewMockBody";
        body.className = "preview-mock-body";

        const statusSelect = document.createElement("select");
        statusSelect.className = "preview-mock-select";
        statusSelect.dataset.mockKey = "skillStatus";
        for (const [value, label] of STATUS_OPTIONS) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = label;
            option.selected = cfg.skillStatus === value;
            statusSelect.appendChild(option);
        }

        const summary = document.createElement("div");
        summary.className = "preview-mock-summary";
        summary.textContent =
            `skillStatus=${cfg.skillStatus}, signedIn=${cfg.signedIn}, ` +
            `project=${cfg.project}, az=${cfg.az}, azd=${cfg.azd}`;

        const hint = document.createElement("div");
        hint.className = "preview-mock-hint";
        hint.textContent = "Changing a control reloads the page.";

        body.append(
            section("Session", [
                checkbox("signedIn", "Signed in", cfg.signedIn),
                checkbox("project", "Foundry project selected", cfg.project),
            ]),
            section("Foundry Skills", [statusSelect]),
            section("Local tools", [
                checkbox("az", "Azure CLI available", cfg.az),
                checkbox("azd", "Azure Developer CLI available", cfg.azd),
            ]),
            summary,
            hint,
        );

        panel.append(header, body);

        body.onchange = (event) => {
            const target = event.target;
            if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
            const key = target.dataset.mockKey;
            if (!key) return;
            setParam(key, target instanceof HTMLInputElement ? target.checked : target.value);
        };
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", renderPanel, { once: true });
    } else {
        renderPanel();
    }
})();
