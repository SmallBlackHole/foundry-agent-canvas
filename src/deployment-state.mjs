import { pushFrame } from "./server-utils.mjs";

export async function refreshDeploymentState(entry, inspectDeployment, { push = pushFrame } = {}) {
    const deployment = await inspectDeployment();
    push(entry, { type: "deploymentState", deployment });
    return deployment;
}
