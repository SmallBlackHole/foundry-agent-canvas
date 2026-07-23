import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { parse } from "yaml";

const AGENT_MANIFESTS = new Set(["agent.yaml", "agent.yml"]);
const AZURE_MANIFESTS = new Set(["azure.yaml", "azure.yml"]);
const SKIPPED_DIRECTORIES = new Set([".git", ".pnpm-store", "dist", "node_modules"]);

function workspaceResult(hasAzure = false, hasAgent = false, manifestPath = "") {
    return { hasAzure, hasAgent, manifestPath };
}

function cleanName(value) {
    const name = typeof value === "string" ? value.trim() : "";
    return name && !name.includes("${") ? name : "";
}

function uniqueCandidates(candidates) {
    const seen = new Set();
    return candidates.filter((candidate) => {
        const key = candidate.agentName.toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function hostedAgentCandidates(manifest, manifestPath) {
    const services = manifest && typeof manifest === "object" ? manifest.services : null;
    if (!services || typeof services !== "object" || Array.isArray(services)) return [];
    return Object.entries(services)
        .filter(
            ([, service]) =>
                service &&
                typeof service === "object" &&
                String(service.host || "").trim().toLowerCase() === "azure.ai.agent",
        )
        .map(([serviceKey, service]) => {
            const configuredName = cleanName(service.name);
            return {
                agentName: configuredName || serviceKey,
                manifestPath,
                serviceKey,
                source: configuredName ? "azure_service_name" : "azure_service_key",
            };
        })
        .filter((candidate) => candidate.agentName);
}

export function hasHostedAgentService(manifest) {
    return hostedAgentCandidates(manifest, "").length > 0;
}

async function readManifest(file) {
    try {
        return parse(await readFile(file, "utf8"));
    } catch {
        return null;
    }
}

async function scanHostedAgentWorkspace(workspaceRoot) {
    if (!workspaceRoot) {
        return {
            ...workspaceResult(),
            agentCandidates: [],
            azureCandidates: [],
            hostedAzureProjects: [],
        };
    }
    const pending = [workspaceRoot];
    let agentManifest = "";
    let azureManifest = "";
    let hostedAzureManifest = "";
    const agentCandidates = [];
    const azureCandidates = [];
    const hostedAzureProjects = [];

    for (let index = 0; index < pending.length; index += 1) {
        const dir = pending[index];
        let entries;
        try {
            entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
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
            if (AGENT_MANIFESTS.has(name)) {
                const manifest = await readManifest(file);
                const agentName = cleanName(manifest?.name);
                if (agentName) {
                    agentCandidates.push({
                        agentName,
                        manifestPath: file,
                        serviceKey: "",
                        source: "agent_manifest_name",
                    });
                }
            }
            if (AZURE_MANIFESTS.has(name)) {
                azureManifest ||= file;
                const candidates = hostedAgentCandidates(await readManifest(file), file);
                if (candidates.length) {
                    hostedAzureManifest ||= file;
                    azureCandidates.push(...candidates);
                    if (!hostedAzureProjects.some((project) => project.projectDir === dir)) {
                        hostedAzureProjects.push({
                            projectDir: dir,
                            manifestPath: file,
                            services: candidates.map(({ agentName, serviceKey }) => ({
                                agentName,
                                serviceKey,
                            })),
                        });
                    }
                }
            }
        }

        for (const entry of entries) {
            const name = entry.name.toLowerCase();
            if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(name)) {
                pending.push(join(dir, entry.name));
            }
        }
    }

    return {
        hasAzure: !!azureManifest,
        hasAgent: azureCandidates.length > 0 || !!agentManifest,
        manifestPath: hostedAzureManifest || agentManifest,
        agentCandidates: uniqueCandidates(agentCandidates),
        azureCandidates: uniqueCandidates(azureCandidates),
        hostedAzureProjects,
    };
}

export async function inspectHostedAgentWorkspace(workspaceRoot) {
    const result = await scanHostedAgentWorkspace(workspaceRoot);
    return workspaceResult(result.hasAzure, result.hasAgent, result.manifestPath);
}

export async function resolveHostedAgentName(workspaceRoot, explicitName = "") {
    const selectedName = cleanName(explicitName);
    if (selectedName) {
        return {
            agentName: selectedName,
            ambiguous: false,
            candidates: [selectedName],
            manifestPath: "",
            serviceKey: "",
            source: "canvas_input",
        };
    }

    const result = await scanHostedAgentWorkspace(workspaceRoot);
    // azure.yaml is the active azd project contract. Legacy agent manifests
    // only participate when no hosted Azure service is present.
    const candidates = result.azureCandidates.length ? result.azureCandidates : result.agentCandidates;
    if (candidates.length !== 1) {
        return {
            agentName: "",
            ambiguous: candidates.length > 1,
            candidates: candidates.map((candidate) => candidate.agentName),
            manifestPath: result.manifestPath,
            serviceKey: "",
            source: "",
        };
    }
    const [candidate] = candidates;
    return {
        agentName: candidate.agentName,
        ambiguous: false,
        candidates: [candidate.agentName],
        manifestPath: candidate.manifestPath,
        serviceKey: candidate.serviceKey,
        source: candidate.source,
    };
}

export async function resolveHostedAgentProject(workspaceRoot) {
    const result = await scanHostedAgentWorkspace(workspaceRoot);
    const projects = result.hostedAzureProjects;
    const selected = projects[0];
    return {
        projectDir: selected?.projectDir || "",
        manifestPath: selected?.manifestPath || "",
        projects,
    };
}

export async function findHostedAgentManifest(workspaceRoot) {
    return (await inspectHostedAgentWorkspace(workspaceRoot)).manifestPath;
}
