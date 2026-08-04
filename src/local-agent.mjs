import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { parse } from "yaml";

const AGENT_MANIFESTS = new Set(["agent.yaml", "agent.yml"]);
const AZURE_MANIFESTS = new Set(["azure.yaml", "azure.yml"]);
const SKIPPED_DIRECTORIES = new Set([".git", ".pnpm-store", "dist", "node_modules"]);

export const HOSTED_AGENT_TYPE = "hosted";
export const MANAGED_AGENT_TYPE = "managed";

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

function promptAgentConfig(service) {
    if (!service || typeof service !== "object" || Array.isArray(service)) return null;
    const config = service.config && typeof service.config === "object"
        ? service.config
        : service;
    return config.promptAgent || config.prompt_agent || null;
}

function serviceAgentType(service) {
    // The private-preview scaffold writes kind: prompt to agent.yaml but only
    // azure.yaml's config.promptAgent distinguishes it from other prompt-agent
    // formats. Deployment later maps that config to the GHCP harness API.
    return promptAgentConfig(service)
        ? MANAGED_AGENT_TYPE
        : HOSTED_AGENT_TYPE;
}

function hostedAgentCandidates(manifest, manifestPath, projectDir = "") {
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
                projectDir,
                serviceKey,
                source: configuredName ? "azure_service_name" : "azure_service_key",
                agentType: serviceAgentType(service),
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
            agentAzureProjects: [],
        };
    }
    const pending = [workspaceRoot];
    let agentManifest = "";
    let azureManifest = "";
    let hostedAzureManifest = "";
    const agentCandidates = [];
    const azureCandidates = [];
    const agentAzureProjects = [];

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
                const definition = manifest?.template && typeof manifest.template === "object"
                    ? manifest.template
                    : manifest;
                const agentName = cleanName(definition?.name);
                if (agentName) {
                    agentCandidates.push({
                        agentName,
                        manifestPath: file,
                        // agent.yaml alone is not enough to distinguish the
                        // private-preview managed format. Preserve the legacy
                        // hosted-compatible fallback until azure.yaml supplies
                        // config.promptAgent.
                        projectDir: "",
                        serviceKey: "",
                        source: "agent_manifest_name",
                        agentType: HOSTED_AGENT_TYPE,
                    });
                }
            }
            if (AZURE_MANIFESTS.has(name)) {
                azureManifest ||= file;
                const candidates = hostedAgentCandidates(await readManifest(file), file, dir);
                if (candidates.length) {
                    hostedAzureManifest ||= file;
                    azureCandidates.push(...candidates);
                    if (!agentAzureProjects.some((project) => project.projectDir === dir)) {
                        agentAzureProjects.push({
                            projectDir: dir,
                            manifestPath: file,
                            services: candidates.map(({ agentName, serviceKey, agentType }) => ({
                                agentName,
                                serviceKey,
                                agentType,
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
        agentAzureProjects,
    };
}

export async function inspectHostedAgentWorkspace(workspaceRoot) {
    const result = await scanHostedAgentWorkspace(workspaceRoot);
    return workspaceResult(result.hasAzure, result.hasAgent, result.manifestPath);
}

// The agents a workspace offers, in scan order (root first, then by depth
// and folder name). Prefer azure.yaml entries because they identify runnable azd
// projects, but retain agent manifests for agents that have not been deployed yet.
function hostedAgentList(result) {
    const candidates = uniqueCandidates([...result.azureCandidates, ...result.agentCandidates]);
    return candidates.map(({ agentName, manifestPath, projectDir, serviceKey, source, agentType }) => ({
        agentName,
        manifestPath,
        projectDir,
        serviceKey,
        source,
        agentType: agentType || HOSTED_AGENT_TYPE,
    }));
}

export async function discoverHostedAgentWorkspace(workspaceRoot) {
    const result = await scanHostedAgentWorkspace(workspaceRoot);
    return {
        ...workspaceResult(result.hasAzure, result.hasAgent, result.manifestPath),
        agents: hostedAgentList(result),
    };
}

export async function listHostedAgents(workspaceRoot) {
    return (await discoverHostedAgentWorkspace(workspaceRoot)).agents;
}

export async function resolveHostedAgentName(workspaceRoot, explicitName = "") {
    const selectedName = cleanName(explicitName);
    const result = await scanHostedAgentWorkspace(workspaceRoot);
    if (selectedName) {
        const match = hostedAgentList(result).find(
            (candidate) => candidate.agentName.toLowerCase() === selectedName.toLowerCase(),
        );
        if (match) {
            return {
                agentName: match.agentName,
                ambiguous: false,
                candidates: [match.agentName],
                manifestPath: match.manifestPath,
                projectDir: match.projectDir,
                serviceKey: match.serviceKey,
                source: match.source,
                agentType: match.agentType,
            };
        }
        return {
            agentName: selectedName,
            ambiguous: false,
            candidates: [selectedName],
            manifestPath: "",
            projectDir: "",
            serviceKey: "",
            source: "canvas_input",
            agentType: HOSTED_AGENT_TYPE,
        };
    }

    const candidates = hostedAgentList(result);
    if (!candidates.length) {
        return {
            agentName: "",
            ambiguous: false,
            candidates: [],
            manifestPath: result.manifestPath,
            projectDir: "",
            serviceKey: "",
            source: "",
            agentType: "",
        };
    }
    // Several hosted agents is a normal workspace layout, so fall back to the
    // first one. `ambiguous` stays as a signal that the canvas should let the
    // user pick a different agent.
    const [candidate] = candidates;
    return {
        agentName: candidate.agentName,
        ambiguous: candidates.length > 1,
        candidates: candidates.map((item) => item.agentName),
        manifestPath: candidate.manifestPath,
        projectDir: candidate.projectDir,
        serviceKey: candidate.serviceKey,
        source: candidate.source,
        agentType: candidate.agentType,
    };
}

// The azd project the inspector should run. `agentName` selects the project that
// declares that hosted agent; without a match the first project is used.
export async function resolveHostedAgentProject(workspaceRoot, agentName = "") {
    const result = await scanHostedAgentWorkspace(workspaceRoot);
    const allProjects = result.agentAzureProjects;
    const projects = allProjects
        .map((project) => ({
            ...project,
            services: project.services.filter(
                (service) => service.agentType !== MANAGED_AGENT_TYPE,
            ),
        }))
        .filter((project) => project.services.length > 0);
    const wanted = cleanName(agentName).toLowerCase();
    const selectedService = wanted
        ? allProjects
            .flatMap((project) => project.services)
            .find((service) => service.agentName.toLowerCase() === wanted)
        : null;
    if (selectedService?.agentType === MANAGED_AGENT_TYPE) {
        return {
            projectDir: "",
            manifestPath: "",
            projects,
        };
    }
    const match = wanted
        ? projects.find((project) =>
            project.services.some((service) => service.agentName.toLowerCase() === wanted))
        : null;
    const selected = match || projects[0];
    return {
        projectDir: selected?.projectDir || "",
        manifestPath: selected?.manifestPath || "",
        projects,
    };
}

export async function findHostedAgentManifest(workspaceRoot) {
    return (await inspectHostedAgentWorkspace(workspaceRoot)).manifestPath;
}
