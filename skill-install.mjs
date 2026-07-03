import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

function parseTarEntries(decompressed, pathFilter) {
    const entries = [];
    let offset = 0;
    let longName = "";
    while (offset + 512 <= decompressed.length) {
        const header = decompressed.subarray(offset, offset + 512);
        if (header.every((b) => b === 0)) {
            offset += 512;
            if (offset + 512 <= decompressed.length && decompressed.subarray(offset, offset + 512).every((b) => b === 0)) break;
            continue;
        }
        let name = longName || header.subarray(0, 100).toString("utf-8").replace(/\0.*$/, "");
        longName = "";
        const sizeStr = header.subarray(124, 136).toString("utf-8").replace(/\0.*$/, "").trim();
        const size = parseInt(sizeStr, 8) || 0;
        const typeflag = String.fromCharCode(header[156]);
        if (typeflag === "L") {
            longName = decompressed.subarray(offset + 512, offset + 512 + size).toString("utf-8").replace(/\0+$/, "");
            offset += 512 + Math.ceil(size / 512) * 512;
            continue;
        }
        const prefix = header.subarray(345, 500).toString("utf-8").replace(/\0.*$/, "");
        if (prefix) name = prefix + "/" + name;
        const dataBlocks = Math.ceil(size / 512) * 512;
        if (typeflag === "0" || typeflag === "\0" || typeflag === "") {
            const slashIdx = name.indexOf("/");
            const relativePath = slashIdx >= 0 ? name.slice(slashIdx + 1) : name;
            if (relativePath.startsWith(pathFilter)) {
                const localPath = relativePath.slice(pathFilter.length);
                if (localPath) {
                    entries.push({
                        path: localPath,
                        data: Buffer.from(decompressed.subarray(offset + 512, offset + 512 + size)),
                    });
                }
            }
        }
        offset += 512 + dataBlocks;
    }
    return entries;
}

/**
 * Download a skill subtree from a GitHub repo tarball and write it to disk.
 *
 * @param {object} opts
 * @param {string} opts.tarballUrl  - GitHub archive URL (e.g. .../archive/refs/heads/main.tar.gz)
 * @param {string} opts.pathPrefix  - Path prefix to extract from the archive (e.g. "skills/microsoft-foundry/")
 * @param {string} opts.targetDir   - Local directory to write extracted files into
 * @param {string} opts.lockFile    - Path to .skill-lock.json
 * @param {string} opts.skillName   - Skill name key in the lock file
 * @param {string} opts.source      - Source repo identifier (e.g. "microsoft/azure-skills")
 * @param {number} [opts.timeoutMs] - Fetch timeout in milliseconds (default 60000)
 * @returns {Promise<{ok: boolean, count?: number, error?: string}>}
 */
export async function installSkillFromGitHub(opts) {
    const {
        tarballUrl,
        pathPrefix,
        targetDir,
        lockFile,
        skillName,
        source,
        timeoutMs = 60_000,
    } = opts;

    if (typeof fetch !== "function") {
        return { ok: false, error: "fetch is not available — Node.js 18+ required." };
    }

    let buf;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(tarballUrl, { signal: controller.signal });
        if (!res.ok) return { ok: false, error: `GitHub returned HTTP ${res.status}` };
        buf = Buffer.from(await res.arrayBuffer());
    } catch (err) {
        if (err?.name === "AbortError") return { ok: false, error: "Download timed out." };
        return { ok: false, error: String(err?.message ?? err) };
    } finally {
        clearTimeout(timer);
    }

    let entries;
    try {
        const decompressed = gunzipSync(buf);
        entries = parseTarEntries(decompressed, pathPrefix);
    } catch (err) {
        return { ok: false, error: `Archive extraction failed: ${err?.message ?? err}` };
    }

    if (!entries.length) return { ok: false, error: "No skill files found in the archive." };

    for (const entry of entries) {
        const target = join(targetDir, ...entry.path.split("/"));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, entry.data);
    }

    // Update lock file (merge into existing)
    let data = { version: 3, skills: {} };
    try {
        if (existsSync(lockFile)) {
            data = JSON.parse(readFileSync(lockFile, "utf-8"));
            if (!data || typeof data !== "object") data = { version: 3, skills: {} };
            if (!data.skills || typeof data.skills !== "object") data.skills = {};
        }
    } catch {
        data = { version: 3, skills: {} };
    }
    data.skills[skillName] = {
        source,
        sourceType: "github",
        sourceUrl: `https://github.com/${source}.git`,
        skillPath: `skills/${skillName}/SKILL.md`,
        updatedAt: new Date().toISOString(),
    };
    mkdirSync(dirname(lockFile), { recursive: true });
    writeFileSync(lockFile, JSON.stringify(data, null, 2) + "\n", "utf-8");

    return { ok: true, count: entries.length };
}
