import assert from "node:assert/strict";
import test from "node:test";

import {
    buildIssueReportUrl,
    detectOperatingSystem,
} from "../public/issue-report.js";

test("normalizes common webview platforms without exposing the full user agent", () => {
    assert.equal(detectOperatingSystem({ platform: "Win32" }), "Windows");
    assert.equal(detectOperatingSystem({ platform: "MacIntel" }), "macOS");
    assert.equal(detectOperatingSystem({ platform: "Linux x86_64" }), "Linux");
    assert.equal(
        detectOperatingSystem({
            platform: "MacIntel",
            userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)",
        }),
        "iOS",
    );
    assert.equal(detectOperatingSystem({ userAgentData: { platform: "Android" } }), "Android");
    assert.equal(detectOperatingSystem({}), "Unknown");
});

test("prefills the issue form with OS and plugin version", () => {
    const url = new URL(buildIssueReportUrl({
        operatingSystem: "Windows",
        pluginVersion: "1.2.3",
    }));

    assert.equal(url.origin + url.pathname, "https://github.com/microsoft/foundry-toolkit/issues/new");
    assert.equal(url.searchParams.get("labels"), "canvas");
    assert.equal(url.searchParams.has("title"), false);
    assert.match(url.searchParams.get("body"), /- OS: Windows/);
    assert.match(url.searchParams.get("body"), /- Microsoft Foundry plugin version: 1\.2\.3/);
    assert.doesNotMatch(url.searchParams.get("body"), /Copilot (?:app|CLI) version/);
    assert.doesNotMatch(url.searchParams.get("body"), /Mozilla|Win32/);
});
