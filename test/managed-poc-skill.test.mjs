import assert from "node:assert/strict";
import test from "node:test";

import { ensureManagedPocSkillForSession } from "../src/managed-poc-skill.mjs";

test("reloads session skills after the managed PoC skill is ready", async () => {
    const calls = [];
    const diagnostics = { warnings: [], errors: [] };
    const session = {
        rpc: {
            skills: {
                reload: async () => {
                    calls.push("reload");
                    return diagnostics;
                },
            },
        },
    };

    const result = await ensureManagedPocSkillForSession(session, {
        ensureSkill: async () => ({
            ok: true,
            ready: true,
            skill: "microsoft-foundry-managed-poc",
        }),
    });

    assert.deepEqual(calls, ["reload"]);
    assert.equal(result.ready, true);
    assert.equal(result.reloaded, true);
    assert.equal(result.reloadDiagnostics, diagnostics);
});

test("does not reload session skills when installation is not ready", async () => {
    let reloadCalls = 0;
    const result = await ensureManagedPocSkillForSession({
        rpc: {
            skills: {
                reload: async () => {
                    reloadCalls += 1;
                },
            },
        },
    }, {
        ensureSkill: async () => ({
            ok: false,
            ready: false,
            error: "download failed",
        }),
    });

    assert.equal(reloadCalls, 0);
    assert.equal(result.ready, false);
    assert.equal(result.reloaded, false);
    assert.equal(result.error, "download failed");
});

test("reports an unsupported runtime without sending a hidden reload prompt", async () => {
    const session = {
        send: async () => {
            assert.fail("must not send a hidden /skills reload prompt");
        },
    };

    const result = await ensureManagedPocSkillForSession(session, {
        ensureSkill: async () => ({
            ok: true,
            ready: true,
        }),
    });

    assert.equal(result.ready, false);
    assert.equal(result.reloaded, false);
    assert.match(result.error, /does not support programmatic skill reload/);
});
