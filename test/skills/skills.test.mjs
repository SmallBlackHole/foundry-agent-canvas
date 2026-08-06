import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ensureFoundrySkillForSession } from "../../src/skills/skills.mjs";

test("the provider uses session-aware Foundry skill synchronization", async () => {
    const extension = await readFile(new URL("../../extension.mjs", import.meta.url), "utf8");

    assert.match(
        extension,
        /import \{ ensureFoundrySkillForSession \} from "\.\/src\/skills\/skills\.mjs";/,
    );
    assert.match(extension, /ensureFoundrySkillForSession\(session\)/);
    assert.doesNotMatch(extension, /ensureFoundrySkill\(\)/);
});

test("reloads session skills after Foundry Skills are installed or updated", async () => {
    const diagnostics = { warnings: [], errors: [] };
    let reloadCalls = 0;
    const result = await ensureFoundrySkillForSession({
        rpc: {
            skills: {
                reload: async () => {
                    reloadCalls += 1;
                    return diagnostics;
                },
            },
        },
    }, {
        ensureSkill: async () => ({
            ok: true,
            ready: true,
            changed: true,
            action: "install",
        }),
    });

    assert.equal(reloadCalls, 1);
    assert.equal(result.ready, true);
    assert.equal(result.reloaded, true);
    assert.equal(result.reloadDiagnostics, diagnostics);
});

test("does not reload session skills when the installed skill did not change", async () => {
    let reloadCalls = 0;
    const result = await ensureFoundrySkillForSession({
        rpc: {
            skills: {
                reload: async () => {
                    reloadCalls += 1;
                },
            },
        },
    }, {
        ensureSkill: async () => ({
            ok: true,
            ready: true,
            changed: false,
            action: "none",
        }),
    });

    assert.equal(reloadCalls, 0);
    assert.equal(result.ready, true);
    assert.equal(result.reloaded, false);
});

test("reports an unsupported runtime without sending a hidden reload prompt", async () => {
    const session = {
        send: async () => {
            assert.fail("must not send a hidden /skills reload prompt");
        },
    };
    const result = await ensureFoundrySkillForSession(session, {
        ensureSkill: async () => ({
            ok: true,
            ready: true,
            changed: true,
            action: "install",
        }),
    });

    assert.equal(result.ready, false);
    assert.equal(result.reloaded, false);
    assert.match(result.error, /does not support programmatic skill reload/);
});
