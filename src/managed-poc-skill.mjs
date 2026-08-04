import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { installSkillFromGitHub } from "./skill-install.mjs";

const SKILL_SOURCE = "qinezh/azure-skills";
const SKILL_SOURCE_REF = "managed-agents";
const SKILL_NAME = "microsoft-foundry-managed-poc";
const SKILL_TARBALL_URL =
    `https://github.com/${SKILL_SOURCE}/archive/refs/heads/${SKILL_SOURCE_REF}.tar.gz`;
const SKILL_TAR_PREFIX = `skills/${SKILL_NAME}/`;
const INSTALL_TIMEOUT_MS = 60_000;
const USER_AGENTS_DIR = join(homedir(), ".agents");
const USER_SKILL_DIR = join(USER_AGENTS_DIR, "skills", SKILL_NAME);
const USER_SKILL_FILE = join(USER_SKILL_DIR, "SKILL.md");
const USER_SKILL_LOCK_FILE = join(USER_AGENTS_DIR, ".skill-lock.json");

let ensurePromise = null;

function installedSkillName() {
    if (!existsSync(USER_SKILL_FILE)) return "";
    try {
        const text = readFileSync(USER_SKILL_FILE, "utf8");
        return text.match(/^name:\s*([^\r\n]+)$/m)?.[1]?.trim() || "";
    } catch {
        return "";
    }
}

export async function installManagedPocSkill() {
    const result = await installSkillFromGitHub({
        tarballUrl: SKILL_TARBALL_URL,
        pathPrefix: SKILL_TAR_PREFIX,
        targetDir: USER_SKILL_DIR,
        lockFile: USER_SKILL_LOCK_FILE,
        skillName: SKILL_NAME,
        source: SKILL_SOURCE,
        sourceRef: SKILL_SOURCE_REF,
        timeoutMs: INSTALL_TIMEOUT_MS,
    });
    return {
        ...result,
        ready: result.ok && installedSkillName() === SKILL_NAME,
        installPath: USER_SKILL_DIR,
        skill: SKILL_NAME,
    };
}

export function ensureManagedPocSkill() {
    if (!ensurePromise) {
        ensurePromise = installManagedPocSkill().finally(() => {
            ensurePromise = null;
        });
    }
    return ensurePromise;
}
