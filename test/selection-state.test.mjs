import assert from "node:assert/strict";
import test from "node:test";

import {
    emptySelection,
    normalizeSelection,
    selectProject,
    selectSubscription,
    serializeSelection,
} from "../public/selection-state.js";
import { applyInput, defaultState } from "../src/state.mjs";

const SUBSCRIPTION_A = {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Subscription A",
};
const SUBSCRIPTION_B = {
    id: "00000000-0000-0000-0000-000000000002",
    name: "Subscription B",
};
const PROJECT_A = {
    subscriptionId: SUBSCRIPTION_A.id,
    name: "project-a",
    endpoint: "https://account-a.services.ai.azure.com/api/projects/project-a",
    location: "eastus2",
    resourceGroup: "rg-a",
    accountName: "account-a",
};

test("normalizes the legacy flat persistence shape at one boundary", () => {
    const selection = normalizeSelection({
        subscriptionId: ` ${SUBSCRIPTION_A.id} `,
        subscriptionName: " Subscription A ",
        projectEndpoint: " https://account-a.services.ai.azure.com/api/projects/project-a/ ",
        projectName: "",
        projectLocation: " eastus2 ",
        projectRg: " rg-a ",
        projectAccount: "",
    });

    assert.deepEqual(selection, {
        subscription: SUBSCRIPTION_A,
        project: PROJECT_A,
    });
    assert.deepEqual(serializeSelection(selection), {
        subscriptionId: SUBSCRIPTION_A.id,
        subscriptionName: SUBSCRIPTION_A.name,
        projectEndpoint: PROJECT_A.endpoint,
        projectName: PROJECT_A.name,
        projectLocation: PROJECT_A.location,
        projectRg: PROJECT_A.resourceGroup,
        projectAccount: PROJECT_A.accountName,
    });
});

test("changing subscriptions atomically clears a project from the previous subscription", () => {
    const selected = selectProject(
        selectSubscription(emptySelection(), SUBSCRIPTION_A),
        PROJECT_A,
    );

    assert.deepEqual(selectSubscription(selected, SUBSCRIPTION_A), selected);
    assert.deepEqual(selectSubscription(selected, SUBSCRIPTION_B), {
        subscription: SUBSCRIPTION_B,
        project: null,
    });
});

test("selecting a project updates every project field and its owning subscription", () => {
    const selection = selectProject(emptySelection(), {
        subscriptionId: SUBSCRIPTION_B.id,
        name: " project-b ",
        endpoint: " https://account-b.services.ai.azure.com/api/projects/project-b ",
        location: " westus ",
        rg: " rg-b ",
        account: " account-b ",
    }, SUBSCRIPTION_B);

    assert.deepEqual(selection, {
        subscription: SUBSCRIPTION_B,
        project: {
            subscriptionId: SUBSCRIPTION_B.id,
            name: "project-b",
            endpoint: "https://account-b.services.ai.azure.com/api/projects/project-b",
            location: "westus",
            resourceGroup: "rg-b",
            accountName: "account-b",
        },
    });
    assert.deepEqual(selectProject(selection, null), {
        subscription: SUBSCRIPTION_B,
        project: null,
    });
});

test("normalization rejects a project owned by a different subscription", () => {
    assert.deepEqual(normalizeSelection({
        subscription: SUBSCRIPTION_B,
        project: PROJECT_A,
    }), {
        subscription: SUBSCRIPTION_B,
        project: null,
    });
});

test("canvas input updates the provider's canonical project atomically", () => {
    const state = applyInput(defaultState(), {
        projectEndpoint: PROJECT_A.endpoint,
        projectName: "Input project",
    });

    assert.deepEqual(state.selection, {
        subscription: { id: "", name: "" },
        project: {
            ...PROJECT_A,
            subscriptionId: "",
            name: "Input project",
            location: "",
            resourceGroup: "",
        },
    });
    assert.equal("projectEndpoint" in state, false);
    assert.equal("projectLocation" in state, false);
    assert.equal("subscriptionId" in state, false);
});
