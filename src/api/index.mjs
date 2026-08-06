import { createAuthServices } from "./auth-services.mjs";
import { createCanvasServices } from "./canvas-services.mjs";
import { createServiceContext } from "./context.mjs";
import { createHostedAgentServices } from "./hosted-agent-services.mjs";
import { createInspectorServices } from "./inspector-services.mjs";
import { createResourceServices } from "./resource-services.mjs";
import { createSelectionServices } from "./selection-services.mjs";
import { createTelemetryServices } from "./telemetry-services.mjs";
import { NOOP_TELEMETRY } from "../telemetry/index.mjs";

// Assembles the flat method bag the API router dispatches into. Each group owns
// one domain and receives only the options it uses; groups with a dependency
// seam (auth, localInspector, pluginUpdate) default it internally so callers and
// tests can override just the seam they care about.
export function createRuntimeApiServices(instanceId, {
    session,
    inspectorUiDir,
    extensionDir,
    workspaceRootFn,
    waitForFoundrySkill,
    markPendingRefresh,
    auth,
    clearResourceCache,
    clearSavedSelection,
    saveSelection,
    pluginVersion = "",
    localInspector,
    pluginUpdate,
    telemetry = NOOP_TELEMETRY,
    createAgentOperations,
    deploymentOperations,
    clearPendingRefresh,
}) {
    const ctx = createServiceContext(instanceId);

    return {
        ...createCanvasServices({
            ctx,
            session,
            extensionDir,
            waitForFoundrySkill,
            markPendingRefresh,
            clearPendingRefresh,
            pluginVersion,
            telemetry,
            createAgentOperations,
            deploymentOperations,
            ...(pluginUpdate ? { pluginUpdate } : {}),
        }),
        ...createAuthServices({
            ...(auth ? { auth } : {}),
            ...(clearResourceCache ? { clearResourceCache } : {}),
            ...(clearSavedSelection ? { clearSavedSelection } : {}),
            telemetry,
        }),
        ...createSelectionServices({
            ctx,
            session,
            telemetry,
            ...(saveSelection ? { saveSelection } : {}),
        }),
        ...createResourceServices({ ctx, telemetry }),
        ...createHostedAgentServices({
            ctx,
            workspaceRootFn,
            createAgentOperations,
            ...(localInspector?.listAgents ? { listAgents: localInspector.listAgents } : {}),
        }),
        ...createInspectorServices({
            ctx,
            session,
            inspectorUiDir,
            workspaceRootFn,
            telemetry,
            ...(localInspector ? { localInspector } : {}),
        }),
        ...createTelemetryServices({ telemetry }),
    };
}
