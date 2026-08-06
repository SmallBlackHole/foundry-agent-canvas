import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { applyInput, defaultState } from "../src/state.mjs";

// The canvas input schema uses `additionalProperties: false`, so the SDK rejects
// any open input carrying a property the schema does not declare — before open()
// ever runs. Single-view navigation was removed, but persisted/rehydrated canvas
// inputs can still include page:"build". `page` must therefore stay declared as a
// deprecated, ignored compatibility property so those inputs keep validating.
test("canvas input schema retains page as a deprecated compatibility property", async () => {
    const source = await readFile(new URL("../extension.mjs", import.meta.url), "utf8");

    // The strict constraint that makes an undeclared `page` a hard validation error.
    assert.match(source, /additionalProperties: false/);

    // `page` stays declared as an optional string pinned to its only valid value.
    assert.match(source, /page: \{\s*type: "string",\s*enum: \["build"\]/);

    // Documented as deprecated/ignored so nobody re-wires navigation onto it.
    assert.match(source, /page: \{[\s\S]*?[Dd]eprecated and ignored/);

    // The removed navigation abstraction must not come back with it.
    assert.doesNotMatch(source, /name: "navigate"/);
    assert.doesNotMatch(source, /pushNavigate/);
});

test("applyInput accepts but ignores a compatibility page input", () => {
    const state = applyInput(defaultState(), {
        page: "build",
        agentName: "Compat",
        idea: "compare each query result with yesterday and email the analysis",
    });
    assert.equal("page" in state, false);
    assert.equal(state.agentName, "Compat");
    assert.equal(state.initPrompt, "compare each query result with yesterday and email the analysis");
    assert.deepEqual(state.selection, {
        subscription: { id: "", name: "" },
        project: null,
    });
});

test("canvas input schema declares the optional idea used to prefill a clear task", async () => {
    const [extensionSource, appSource] = await Promise.all([
        readFile(new URL("../extension.mjs", import.meta.url), "utf8"),
        readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    ]);

    assert.match(extensionSource, /idea: \{\s*type: "string"/);
    assert.match(extensionSource, /Exact original user prompt when it describes what the agent will do or produce/);
    const initSource = appSource.slice(appSource.indexOf("async function init()"));
    const defaultsIndex = initSource.indexOf("applyInitDefaults(projectInit);");
    const modeIndex = initSource.indexOf(
        "if (initialCreatePrompt) showNewAgent(initialCreatePrompt);",
    );
    const fallbackRenderIndex = initSource.indexOf("else render();");
    assert.match(initSource, /let initialCreatePrompt = "";/);
    assert.match(initSource, /initialCreatePrompt = initialState\.initPrompt;/);
    assert.ok(defaultsIndex >= 0);
    assert.ok(defaultsIndex < modeIndex);
    assert.ok(modeIndex < fallbackRenderIndex);
});
