import {
    selectProject,
    selectSubscription,
} from "../../public/selection-state.js";
import {
    HOSTED_AGENT_REGIONS,
    HOSTED_AGENT_REGIONS_DOC,
    isHostedAgentRegionSupported,
    listProjects,
    listSubscriptions,
} from "../foundry/foundry.mjs";
import { enrichProjectLocation, saveSelection } from "../state.mjs";
import {
    TELEMETRY_FAILURE_CODE,
    TELEMETRY_OPERATION,
    TELEMETRY_OUTCOME,
    TELEMETRY_RESOURCE_KIND,
    TELEMETRY_SOURCE,
} from "../../public/telemetry-constants.js";
import { normalizeFailureCode } from "../telemetry/schema.mjs";
import { runTelemetryOperation } from "../telemetry/operations.mjs";

function listResult(result) {
    return result.ok
        ? { ok: true, items: result.data }
        : { ok: false, reason: result.reason, items: [] };
}

export function createSelectionServices({
    ctx,
    session,
    telemetry,
    saveSelection: persistSelection = saveSelection,
    now = Date.now,
}) {
    const { getEntry, getSelection } = ctx;
    const reportedRegionWarnings = new Set();

    // One warning per project+region for the life of this canvas instance. The
    // key is dropped again when logging throws so a failed write can retry.
    async function reportUnsupportedRegion(selection, location) {
        const project = selection.project;
        const key = `${project?.endpoint || project?.name || ""}|${location}`;
        if (!key || reportedRegionWarnings.has(key)) return;

        reportedRegionWarnings.add(key);
        const region = location ? ` (${location})` : "";
        try {
            await session.log(
                `Hosted agents aren't available in this project's region${region}. `
                    + "Select a project in a supported region before deploying.",
                { level: "warning" },
            );
        } catch {
            reportedRegionWarnings.delete(key);
        }
    }

    return {
        async listSubscriptions() {
            return runTelemetryOperation(telemetry, {
                operation: TELEMETRY_OPERATION.LOAD_RESOURCES,
                source: TELEMETRY_SOURCE.UI,
                resourceKind: TELEMETRY_RESOURCE_KIND.SUBSCRIPTION,
                now,
            }, async () => listResult(await listSubscriptions()));
        },
        async listProjects({ url }) {
            const subscriptionId = url.searchParams.get("sub")
                || getSelection().subscription.id;
            return runTelemetryOperation(telemetry, {
                operation: TELEMETRY_OPERATION.LOAD_RESOURCES,
                source: TELEMETRY_SOURCE.UI,
                resourceKind: TELEMETRY_RESOURCE_KIND.PROJECT,
                now,
            }, async () => listResult(await listProjects(subscriptionId)));
        },
        async selectSubscription({ body }) {
            let persisted = false;
            return runTelemetryOperation(telemetry, {
                operation: TELEMETRY_OPERATION.SELECT_SUBSCRIPTION,
                source: TELEMETRY_SOURCE.UI,
                resourceKind: TELEMETRY_RESOURCE_KIND.SUBSCRIPTION,
                now,
                classify: () => persisted
                    ? { outcome: TELEMETRY_OUTCOME.SUCCEEDED }
                    : {
                        outcome: TELEMETRY_OUTCOME.FAILED,
                        failureCode: TELEMETRY_FAILURE_CODE.PERSISTENCE_FAILED,
                    },
            }, async () => {
                const selection = selectSubscription(getSelection(), {
                    id: body.subscriptionId,
                    name: typeof body.subscriptionName === "string" ? body.subscriptionName : "",
                });
                const entry = getEntry();
                if (entry) entry.state.selection = selection;
                persisted = persistSelection(selection) !== false;
                return { ok: true, selection };
            });
        },
        async selectProject({ body }) {
            let persisted = false;
            return runTelemetryOperation(telemetry, {
                operation: TELEMETRY_OPERATION.SELECT_PROJECT,
                source: TELEMETRY_SOURCE.UI,
                resourceKind: TELEMETRY_RESOURCE_KIND.PROJECT,
                now,
                classify: () => persisted
                    ? { outcome: TELEMETRY_OUTCOME.SUCCEEDED }
                    : {
                        outcome: TELEMETRY_OUTCOME.FAILED,
                        failureCode: TELEMETRY_FAILURE_CODE.PERSISTENCE_FAILED,
                    },
            }, async () => {
                const current = getSelection();
                const subscription = {
                    id: typeof body.subscriptionId === "string"
                        ? body.subscriptionId.trim()
                        : current.subscription.id,
                    name: typeof body.subscriptionName === "string"
                        ? body.subscriptionName.trim()
                        : current.subscription.name,
                };
                const selection = selectProject(current, {
                    subscriptionId: subscription.id,
                    name: typeof body.name === "string" ? body.name : "",
                    endpoint: body.endpoint,
                    location: typeof body.location === "string" ? body.location : "",
                    resourceGroup: typeof body.resourceGroup === "string" ? body.resourceGroup : "",
                    accountName: typeof body.accountName === "string" ? body.accountName : "",
                }, subscription);
                const entry = getEntry();
                if (entry) entry.state.selection = selection;
                persisted = persistSelection(selection) !== false;
                return { ok: true, selection };
            });
        },
        async getRegionSupport() {
            const entry = getEntry();
            const selection = getSelection();
            if (!selection.project?.endpoint) {
                return {
                    ok: true,
                    location: "",
                    supported: null,
                    regions: HOSTED_AGENT_REGIONS,
                    docsUrl: HOSTED_AGENT_REGIONS_DOC,
                };
            }
            let location = selection.project.location;
            if (!location) {
                try {
                    location = await enrichProjectLocation(entry);
                } catch {
                    location = "";
                }
            }
            const supported = isHostedAgentRegionSupported(location);
            if (supported === false) {
                await reportUnsupportedRegion(selection, location);
            }
            return {
                ok: true,
                location,
                supported,
                regions: HOSTED_AGENT_REGIONS,
                docsUrl: HOSTED_AGENT_REGIONS_DOC,
            };
        },
    };
}
