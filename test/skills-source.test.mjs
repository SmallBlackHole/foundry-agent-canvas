import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { isExpectedFoundrySkillSource } from "../src/skills.mjs";

test("managed-agent PoC pins the forked Foundry skill branch", async () => {
    const source = await readFile(new URL("../src/skills.mjs", import.meta.url), "utf8");

    assert.match(source, /const SKILLS_SOURCE = "qinezh\/azure-skills";/);
    assert.match(source, /const SKILLS_SOURCE_REF = "managed-agents";/);
    assert.match(source, /archive\/refs\/heads\/\$\{SKILLS_SOURCE_REF\}\.tar\.gz/);
    assert.equal(isExpectedFoundrySkillSource({
        source: "qinezh/azure-skills",
        sourceRef: "managed-agents",
        skillPath: "skills/microsoft-foundry/SKILL.md",
    }), true);
    assert.equal(isExpectedFoundrySkillSource({
        source: "microsoft/azure-skills",
        sourceRef: "main",
        skillPath: "skills/microsoft-foundry/SKILL.md",
    }), false);
});
