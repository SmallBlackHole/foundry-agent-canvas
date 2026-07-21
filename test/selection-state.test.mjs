import assert from "node:assert/strict";
import test from "node:test";

import {
    emptySelection,
    normalizeSelection,
    selectProject,
    selectSubscription,
    serializeSelection,
} from "../public/selection-state.js";
import {
    applyInput,
    bootstrapInstance,
    defaultState,
    enrichProjectLocation,
} from "../src/state.mjs";

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
const PROJECT_B = {
    subscriptionId: SUBSCRIPTION_B.id,
    name: "project-b",
    endpoint: "https://account-b.services.ai.azure.com/api/projects/project-b",
    location: "westus",
    resourceGroup: "rg-b",
    accountName: "account-b",
};

function selected(subscription, project) {
    return selectProject(
        selectSubscription(emptySelection(), subscription),
        project,
        subscription,
    );
}

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
            accountName: "",
        },
    });
    assert.equal("projectEndpoint" in state, false);
    assert.equal("projectLocation" in state, false);
    assert.equal("subscriptionId" in state, false);
});

test("canvas input drops project metadata and ownership when the endpoint changes", () => {
    const state = {
        ...defaultState(),
        selection: selected(SUBSCRIPTION_A, PROJECT_A),
    };

    applyInput(state, {
        projectEndpoint: `${PROJECT_B.endpoint}/`,
    });

    assert.deepEqual(state.selection, {
        subscription: { id: "", name: "" },
        project: {
            subscriptionId: "",
            name: PROJECT_B.name,
            endpoint: PROJECT_B.endpoint,
            location: "",
            resourceGroup: "",
            accountName: "",
        },
    });
});

test("canvas input keeps project metadata when the normalized endpoint is unchanged", () => {
    const state = {
        ...defaultState(),
        selection: selected(SUBSCRIPTION_A, PROJECT_A),
    };

    applyInput(state, {
        projectEndpoint: `${PROJECT_A.endpoint}/`,
        projectName: "Renamed project",
    });

    assert.deepEqual(state.selection, {
        subscription: SUBSCRIPTION_A,
        project: {
            ...PROJECT_A,
            name: "Renamed project",
        },
    });
});

test("bootstrap preserves explicit input while signed out", async () => {
    const inputSelection = selectProject(emptySelection(), {
        endpoint: PROJECT_A.endpoint,
        name: "Input project",
    });
    const entry = {
        state: {
            ...defaultState(),
            selection: inputSelection,
        },
    };

    const result = await bootstrapInstance(entry, {
        getIdentity: async () => ({ signedIn: false, account: "", tenantId: "" }),
        loadSelection: () => {
            throw new Error("signed-out bootstrap must not read persisted selection");
        },
    });

    assert.deepEqual(entry.state.selection, inputSelection);
    assert.deepEqual(result.selection, inputSelection);
    assert.equal(result.resolved, true);
});

test("failed default project discovery preserves input and does not persist subscription-only state", async () => {
    const inputSelection = selectProject(emptySelection(), {
        endpoint: PROJECT_A.endpoint,
        name: "Input project",
    });
    const entry = {
        state: {
            ...defaultState(),
            selection: inputSelection,
        },
    };
    const persisted = [];

    await bootstrapInstance(entry, {
        getIdentity: async () => ({ signedIn: true, account: "user@example.com", tenantId: "tenant" }),
        loadSelection: () => null,
        listSubscriptions: async () => ({ ok: true, data: [{ ...SUBSCRIPTION_B, isDefault: true }] }),
        listProjects: async () => ({ ok: false, reason: "fetch_failed" }),
        saveSelection: (selection) => persisted.push(selection),
    });

    assert.deepEqual(entry.state.selection, inputSelection);
    assert.deepEqual(persisted, []);
});

test("saved subscription-only state retries project discovery on later bootstrap", async () => {
    const saved = selectSubscription(emptySelection(), SUBSCRIPTION_B);
    const inputSelection = selectProject(emptySelection(), {
        endpoint: PROJECT_A.endpoint,
        name: "Input project",
    });
    const entry = {
        state: {
            ...defaultState(),
            selection: inputSelection,
        },
    };
    const persisted = [];
    let attempts = 0;
    const dependencies = {
        getIdentity: async () => ({ signedIn: true, account: "user@example.com", tenantId: "tenant" }),
        loadSelection: () => saved,
        listSubscriptions: async () => {
            throw new Error("saved subscription should be reused");
        },
        listProjects: async () => {
            attempts += 1;
            return attempts === 1
                ? { ok: false, reason: "fetch_failed" }
                : { ok: true, data: [PROJECT_B] };
        },
        saveSelection: (selection) => persisted.push(selection),
    };

    await bootstrapInstance(entry, dependencies);
    assert.deepEqual(entry.state.selection, inputSelection);
    assert.deepEqual(persisted, []);

    await bootstrapInstance(entry, dependencies);
    assert.equal(attempts, 2);
    assert.deepEqual(entry.state.selection, selected(SUBSCRIPTION_B, PROJECT_B));
    assert.deepEqual(persisted, [selected(SUBSCRIPTION_B, PROJECT_B)]);
});

test("stale region resolution cannot overwrite a newer selection", async () => {
    const entry = {
        state: {
            ...defaultState(),
            selection: selected(SUBSCRIPTION_A, { ...PROJECT_A, location: "" }),
        },
    };
    const persisted = [];
    let release;
    const pendingLocation = new Promise((resolve) => {
        release = resolve;
    });
    const enrichment = enrichProjectLocation(
        entry,
        async () => pendingLocation,
        (selection) => persisted.push(selection),
    );

    const nextSelection = selected(SUBSCRIPTION_B, PROJECT_B);
    entry.state.selection = nextSelection;
    release("eastus2");

    assert.equal(await enrichment, "");
    assert.deepEqual(entry.state.selection, nextSelection);
    assert.deepEqual(persisted, []);
});

test("region resolution enriches and persists the current matching selection", async () => {
    const entry = {
        state: {
            ...defaultState(),
            selection: selected(SUBSCRIPTION_A, { ...PROJECT_A, location: "" }),
        },
    };
    const persisted = [];

    const location = await enrichProjectLocation(
        entry,
        async (endpoint, subscriptionId) => {
            assert.equal(endpoint, PROJECT_A.endpoint);
            assert.equal(subscriptionId, SUBSCRIPTION_A.id);
            return "eastus2";
        },
        (selection) => persisted.push(selection),
    );

    assert.equal(location, "eastus2");
    assert.equal(entry.state.selection.project.location, "eastus2");
    assert.deepEqual(persisted, [entry.state.selection]);
});
