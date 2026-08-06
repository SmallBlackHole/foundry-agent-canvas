import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HOSTED_AGENT_REGIONS_SOURCE =
    "https://raw.githubusercontent.com/MicrosoftDocs/azure-ai-docs/main/"
    + "articles/foundry/agents/concepts/hosted-agents.md";

const TARGET = new URL("../src/foundry/foundry.mjs", import.meta.url);
const START_MARKER = "// BEGIN HOSTED_AGENT_REGIONS";
const END_MARKER = "// END HOSTED_AGENT_REGIONS";

export function parseHostedAgentRegions(markdown) {
    const section = String(markdown).match(
        /^### Region availability\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m,
    )?.[1];
    if (!section) throw new Error("Microsoft Learn region availability section was not found");

    const regions = [...section.matchAll(/^- ([^\r\n]+)$/gm)]
        .map((match) => match[1].trim().toLowerCase().replace(/[\s_]+/g, ""))
        .filter(Boolean);
    const unique = [...new Set(regions)].sort();
    if (unique.length < 10) {
        throw new Error(`Microsoft Learn returned only ${unique.length} hosted-agent regions`);
    }
    return unique;
}

export function renderHostedAgentRegions(regions, syncedAt, newline = "\n") {
    const entries = regions.map((region) => `    "${region}",`).join(newline);
    return `${START_MARKER}${newline}`
        + `// Last synced: ${syncedAt}.${newline}`
        + `export const HOSTED_AGENT_REGIONS = [${newline}`
        + `${entries}${newline}`
        + `];${newline}`
        + END_MARKER;
}

export function updateHostedAgentRegions(source, regions, syncedAt) {
    const start = source.indexOf(START_MARKER);
    const end = source.indexOf(END_MARKER, start);
    if (start < 0 || end < 0) throw new Error("Hosted-agent region sync markers were not found");

    const currentBlock = source.slice(start, end + END_MARKER.length);
    const currentRegions = [...currentBlock.matchAll(/^\s+"([^"]+)",$/gm)]
        .map((match) => match[1]);
    if (JSON.stringify(currentRegions) === JSON.stringify(regions)) return source;

    const newline = source.includes("\r\n") ? "\r\n" : "\n";
    return source.slice(0, start)
        + renderHostedAgentRegions(regions, syncedAt, newline)
        + source.slice(end + END_MARKER.length);
}

export async function syncHostedAgentRegions({
    fetchImpl = globalThis.fetch,
    target = TARGET,
    syncedAt = new Date().toISOString().slice(0, 10),
} = {}) {
    const response = await fetchImpl(HOSTED_AGENT_REGIONS_SOURCE, {
        headers: { Accept: "text/markdown" },
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch Microsoft Learn source: HTTP ${response.status}`);
    }

    const regions = parseHostedAgentRegions(await response.text());
    const source = await readFile(target, "utf8");
    const updated = updateHostedAgentRegions(source, regions, syncedAt);
    if (updated === source) return { changed: false, regions };

    await writeFile(target, updated);
    return { changed: true, regions };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    const result = await syncHostedAgentRegions();
    process.stdout.write(
        result.changed
            ? `Updated ${result.regions.length} hosted-agent regions.\n`
            : `${result.regions.length} hosted-agent regions are already current.\n`,
    );
}
