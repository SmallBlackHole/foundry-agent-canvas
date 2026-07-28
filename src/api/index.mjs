import { createAuthServices } from "./auth-services.mjs";
import { createCanvasServices } from "./canvas-services.mjs";
import { createServiceContext } from "./context.mjs";
import { createHostedAgentServices } from "./hosted-agent-services.mjs";
import { createInspectorServices } from "./inspector-services.mjs";
import { createResourceServices } from "./resource-services.mjs";
import { createSelectionServices } from "./selection-services.mjs";

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
    pluginVersion = "",
    localInspector,
    pluginUpdate,
}) {
    const ctx = createServiceContext(instanceId);

    return {
        ...createCanvasServices({
            ctx,
            session,
            extensionDir,
            waitForFoundrySkill,
            markPendingRefresh,
            pluginVersion,
            ...(pluginUpdate ? { pluginUpdate } : {}),
        }),
        ...createAuthServices({
            ...(auth ? { auth } : {}),
            ...(clearResourceCache ? { clearResourceCache } : {}),
            ...(clearSavedSelection ? { clearSavedSelection } : {}),
        }),
        ...createSelectionServices({ ctx, session }),
        ...createResourceServices({ ctx }),
        ...createHostedAgentServices({
            ctx,
            workspaceRootFn,
            ...(localInspector?.listAgents ? { listAgents: localInspector.listAgents } : {}),
        }),
        ...createInspectorServices({
            ctx,
            session,
            inspectorUiDir,
            workspaceRootFn,
            ...(localInspector ? { localInspector } : {}),
        }),
    };
}
