import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { parse } from "yaml";

const AGENT_MANIFESTS = new Set(["agent.yaml", "agent.yml"]);
const AZURE_MANIFESTS = new Set(["azure.yaml", "azure.yml"]);
const SKIPPED_DIRECTORIES = new Set([".git", ".pnpm-store", "dist", "node_modules"]);

function workspaceResult(hasAzure = false, hasAgent = false, manifestPath = "") {
    return { hasAzure, hasAgent, manifestPath };
}

export function hasHostedAgentService(manifest) {
    const services = manifest && typeof manifest === "object" ? manifest.services : null;
    if (!services || typeof services !== "object" || Array.isArray(services)) return false;
    return Object.values(services).some(
        (service) =>
            service &&
            typeof service === "object" &&
            String(service.host || "").trim().toLowerCase() === "azure.ai.agent",
    );
}

async function azureManifestHasHostedAgent(file) {
    try {
        return hasHostedAgentService(parse(await readFile(file, "utf8")));
    } catch {
        return false;
    }
}

export async function inspectHostedAgentWorkspace(workspaceRoot) {
    if (!workspaceRoot) return workspaceResult();

    const pending = [workspaceRoot];
    let agentManifest = "";
    let azureManifest = "";

    for (let index = 0; index < pending.length; index += 1) {
        const dir = pending[index];
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const name = entry.name.toLowerCase();
            const file = join(dir, entry.name);
            if (!agentManifest && AGENT_MANIFESTS.has(name)) {
                agentManifest = file;
            }
            if (AZURE_MANIFESTS.has(name)) {
                azureManifest ||= file;
                if (await azureManifestHasHostedAgent(file)) {
                    return workspaceResult(true, true, file);
                }
            }
        }

        if (agentManifest && azureManifest) {
            return workspaceResult(true, true, agentManifest);
        }

        for (const entry of entries) {
            const name = entry.name.toLowerCase();
            if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(name)) {
                pending.push(join(dir, entry.name));
            }
        }
    }

    return workspaceResult(!!azureManifest, !!agentManifest, agentManifest);
}

export async function findHostedAgentManifest(workspaceRoot) {
    return (await inspectHostedAgentWorkspace(workspaceRoot)).manifestPath;
}
