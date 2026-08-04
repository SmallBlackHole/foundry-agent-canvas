import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("official and managed PoC skills use separate sources and install paths", async () => {
    const [official, managed, extension] = await Promise.all([
        readFile(new URL("../src/skills.mjs", import.meta.url), "utf8"),
        readFile(new URL("../src/managed-poc-skill.mjs", import.meta.url), "utf8"),
        readFile(new URL("../extension.mjs", import.meta.url), "utf8"),
    ]);

    assert.match(official, /const SKILLS_SOURCE = "microsoft\/azure-skills";/);
    assert.match(official, /const SKILLS_SOURCE_REF = "main";/);
    assert.match(official, /const SKILLS_SKILL = "microsoft-foundry";/);
    assert.doesNotMatch(official, /qinezh\/azure-skills|managed-agents/);
    assert.match(official, /status: "wrong_source"/);

    assert.match(managed, /const SKILL_SOURCE = "qinezh\/azure-skills";/);
    assert.match(managed, /const SKILL_SOURCE_REF = "managed-agents";/);
    assert.match(managed, /const SKILL_NAME = "microsoft-foundry-managed-poc";/);
    assert.match(managed, /join\(USER_AGENTS_DIR, "skills", SKILL_NAME\)/);

    assert.match(extension, /ensureFoundrySkill\(\)/);
    assert.match(extension, /ensureManagedPocSkillForSession\(session\)/);
});
