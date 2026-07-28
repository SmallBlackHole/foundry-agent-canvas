import assert from "node:assert/strict";
import test from "node:test";

import { compareVersions } from "../src/version-compare.mjs";

test("compares numeric version segments", () => {
    assert.equal(compareVersions("1.0.4", "1.0.5"), -1);
    assert.equal(compareVersions("1.0.10", "1.0.9"), 1);
    assert.equal(compareVersions("1.0.4", "1.0.4"), 0);
    assert.equal(compareVersions("1.0", "1.0.0"), 0);
});

test("orders SemVer prereleases below stable releases", () => {
    assert.equal(compareVersions("1.0.0-beta", "1.0.0"), -1);
    assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
    assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.10"), -1);
    assert.equal(compareVersions("1.0.0-beta", "1.0.0-rc"), -1);
});

test("ignores build metadata and accepts a leading v", () => {
    assert.equal(compareVersions("1.0.0+build.1", "1.0.0+build.2"), 0);
    assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
});
