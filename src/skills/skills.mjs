import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { installSkillFromGitHub } from "./skill-install.mjs";
import { compareVersions } from "../version-compare.mjs";

const USER_HOME = homedir();
const SKILLS_SOURCE = "microsoft/azure-skills";
const SKILLS_SKILL = "microsoft-foundry";
const SKILLS_TARBALL_URL = `https://github.com/${SKILLS_SOURCE}/archive/refs/heads/main.tar.gz`;
const SKILLS_TAR_PREFIX = "skills/microsoft-foundry/";
const SKILLS_INSTALL_TIMEOUT_MS = 60_000;
const USER_AGENTS_DIR = join(USER_HOME, ".agents");
const USER_SKILLS_DIR = join(USER_AGENTS_DIR, "skills");
const USER_SKILL_DIR = join(USER_SKILLS_DIR, SKILLS_SKILL);
const USER_SKILL_FILE = join(USER_SKILL_DIR, "SKILL.md");
const USER_SKILL_LOCK_FILE = join(USER_AGENTS_DIR, ".skill-lock.json");
const SKILLS_REMOTE_SKILL_PATH = ".github/plugins/azure-skills/skills/microsoft-foundry/SKILL.md";
const SKILLS_REMOTE_CHECK_TIMEOUT_MS = 10_000;
const SKILLS_CHECK_TTL_MS = 5 * 60_000;
let ensureFoundrySkillPromise = null;
let lastEnsureFoundrySkillResult = null;
let lastEnsureFoundrySkillCompletedAt = 0;

export async function installFoundrySkill() {
    const result = await installSkillFromGitHub({
        tarballUrl: SKILLS_TARBALL_URL,
        pathPrefix: SKILLS_TAR_PREFIX,
        targetDir: USER_SKILL_DIR,
        lockFile: USER_SKILL_LOCK_FILE,
        skillName: SKILLS_SKILL,
        source: SKILLS_SOURCE,
        timeoutMs: SKILLS_INSTALL_TIMEOUT_MS,
    });
    if (!result.ok) {
        return {
            ok: false,
            code: -1,
            summary: result.error,
            scope: "user",
            installPath: USER_SKILL_DIR,
        };
    }
    const version = skillVersionFromText(
        existsSync(USER_SKILL_FILE) ? readFileSync(USER_SKILL_FILE, "utf-8") : ""
    );
    return {
        ok: true,
        code: 0,
        summary: `Foundry Skills installed (${result.count} files).`,
        scope: "user",
        installPath: USER_SKILL_DIR,
        installedVersion: version,
    };
}

function readFoundrySkillLockEntry() {
    try {
        if (!existsSync(USER_SKILL_LOCK_FILE)) return null;
        const data = JSON.parse(readFileSync(USER_SKILL_LOCK_FILE, "utf-8"));
        const entry = data?.skills?.[SKILLS_SKILL];
        return entry && typeof entry === "object" ? entry : null;
    } catch {
        return null;
    }
}

function skillVersionFromText(text) {
    const source = String(text || "");
    const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const versionScope = frontmatter ? frontmatter[1] : source.slice(0, 2000);
    const m = versionScope.match(/^\s*version:\s*["']?([^"'\r\n]+)["']?\s*$/m);
    return m ? m[1].trim() : "";
}

function readInstalledFoundrySkill() {
    const lock = readFoundrySkillLockEntry();
    let installed = existsSync(USER_SKILL_FILE) || !!lock;
    let installedVersion = "";
    try {
        if (existsSync(USER_SKILL_FILE)) {
            const text = readFileSync(USER_SKILL_FILE, "utf-8");
            installedVersion = skillVersionFromText(text);
        }
    } catch {
        installed = !!lock;
    }
    return {
        installed,
        installedVersion,
        lock,
        lockUpdatedAt: lock?.updatedAt || "",
        installPath: USER_SKILL_DIR,
    };
}

function githubRepoFromSkillLock(lock) {
    const source = String(lock?.source || SKILLS_SOURCE);
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source)) return source;
    const sourceUrl = String(lock?.sourceUrl || "");
    const m = sourceUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/i);
    return m ? `${m[1]}/${m[2]}` : SKILLS_SOURCE;
}

function skillPathFromSkillLock(lock) {
    return String(lock?.skillPath || SKILLS_REMOTE_SKILL_PATH);
}

function githubRawSkillUrls(lock) {
    const repo = githubRepoFromSkillLock(lock);
    const path = skillPathFromSkillLock(lock)
        .split("/")
        .map(encodeURIComponent)
        .join("/");
    return ["main", "master"].map((ref) => `https://raw.githubusercontent.com/${repo}/${ref}/${path}`);
}

async function fetchText(url, timeoutMs) {
    if (typeof fetch !== "function") return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { Accept: "text/plain" },
        });
        if (!res.ok) return null;
        return await res.text();
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function checkRemoteFoundrySkill(lock, installedVersion) {
    for (const url of githubRawSkillUrls(lock)) {
        const text = await fetchText(url, SKILLS_REMOTE_CHECK_TIMEOUT_MS);
        if (!text) continue;
        const latestVersion = skillVersionFromText(text);
        if (!latestVersion) {
            return {
                ok: false,
                status: "unknown",
                latestVersion: "",
                summary: "Foundry Skills are installed, but the latest version metadata could not be read.",
            };
        }
        if (!installedVersion) {
            return {
                ok: false,
                status: "unknown",
                latestVersion,
                summary: "Foundry Skills are installed, but the installed version could not be read.",
            };
        }
        if (compareVersions(installedVersion, latestVersion) < 0) {
            return {
                ok: true,
                status: "outdated",
                latestVersion,
                summary: "A newer version of Foundry Skills is available.",
            };
        }
        return {
            ok: true,
            status: "latest",
            latestVersion,
            summary: `The latest Foundry Skills are already installed (version ${latestVersion}).`,
        };
    }
    return {
        ok: false,
        status: "unknown",
        latestVersion: "",
        summary: "Unable to access GitHub to verify whether Foundry Skills are up to date.",
    };
}

export async function checkFoundrySkillStatus() {
    const installed = readInstalledFoundrySkill();
    const base = {
        skill: SKILLS_SKILL,
        source: SKILLS_SOURCE,
        scope: "user",
        installPath: installed.installPath,
        installed: installed.installed,
        installedVersion: installed.installedVersion,
        lockPresent: !!installed.lock,
        skillPath: skillPathFromSkillLock(installed.lock),
        lockUpdatedAt: installed.lockUpdatedAt,
        checkMethod: "github-skill-metadata",
    };
    if (!installed.installed) {
        return {
            ...base,
            ok: true,
            status: "missing",
            latestVersion: "",
            summary: "Foundry Skills are not installed yet.",
        };
    }
    const latest = await checkRemoteFoundrySkill(installed.lock, installed.installedVersion);
    return { ...base, ...latest };
}

async function ensureFoundrySkillOnce() {
    const status = await checkFoundrySkillStatus();
    if (status.status !== "missing" && status.status !== "outdated") {
        return {
            ...status,
            action: "none",
            changed: false,
            ready: status.installed,
        };
    }

    const action = status.status === "outdated" ? "update" : "install";
    const result = await installFoundrySkill();
    const ready = result.ok || status.installed;
    return {
        ...status,
        ...result,
        action,
        changed: result.ok,
        previousStatus: status.status,
        status: result.ok ? "latest" : status.status,
        installed: ready,
        installedVersion: result.installedVersion || status.installedVersion,
        latestVersion: status.latestVersion,
        ready,
    };
}

export function ensureFoundrySkill() {
    const cacheAge = Date.now() - lastEnsureFoundrySkillCompletedAt;
    if (lastEnsureFoundrySkillResult && cacheAge >= 0 && cacheAge < SKILLS_CHECK_TTL_MS) {
        return Promise.resolve(lastEnsureFoundrySkillResult);
    }
    if (!ensureFoundrySkillPromise) {
        ensureFoundrySkillPromise = ensureFoundrySkillOnce()
            .then((result) => {
                const cacheable = result.ok || (result.status === "unknown" && result.ready);
                if (cacheable) {
                    lastEnsureFoundrySkillResult = result;
                    lastEnsureFoundrySkillCompletedAt = Date.now();
                }
                return result;
            })
            .finally(() => {
                ensureFoundrySkillPromise = null;
            });
    }
    return ensureFoundrySkillPromise;
}

export async function ensureFoundrySkillForSession(
    session,
    { ensureSkill = ensureFoundrySkill } = {},
) {
    const result = await ensureSkill();
    if (!result.ready || !result.changed) {
        return { ...result, reloaded: false };
    }
    if (typeof session?.rpc?.skills?.reload !== "function") {
        return {
            ...result,
            ready: false,
            reloaded: false,
            error: "The current Copilot runtime does not support programmatic skill reload.",
        };
    }
    const reloadDiagnostics = await session.rpc.skills.reload();
    return {
        ...result,
        reloaded: true,
        reloadDiagnostics,
    };
}
