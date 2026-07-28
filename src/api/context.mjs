import { emptySelection } from "../../public/selection-state.js";
import { servers } from "../state.mjs";

// Shared accessors every service group needs. The canvas instance is looked up
// on each call rather than captured, because `servers` entries are created and
// replaced over an instance's lifetime.
export function createServiceContext(instanceId) {
    const getEntry = () => servers.get(instanceId);
    const getSelection = () => getEntry()?.state.selection ?? emptySelection();
    const getEndpoint = () => getSelection().project?.endpoint || "";
    return { instanceId, getEntry, getSelection, getEndpoint };
}
