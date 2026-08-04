import assert from "node:assert/strict";
import test from "node:test";

import { initialBuildSections } from "../src/build-sections.mjs";

test("existing hosted agent opens build and deploy sections", () => {
    assert.deepEqual(initialBuildSections({ hasAgent: true }), {
        initOpen: false,
        resourcesOpen: true,
        deployOpen: true,
    });
});

test("no hosted agent keeps the create-first experience", () => {
    assert.deepEqual(initialBuildSections({ hasAgent: false, hasAzure: true }), {
        initOpen: true,
        resourcesOpen: false,
        deployOpen: false,
    });
});

test("existing managed agent uses the same build-first section layout", () => {
    assert.deepEqual(initialBuildSections({ agentType: "managed" }), {
        initOpen: false,
        resourcesOpen: true,
        deployOpen: true,
    });
});
