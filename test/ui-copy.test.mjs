import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("workflow headings use sentence case and hosted agent remains lowercase", async () => {
    const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

    assert.match(html, />Create new hosted agents</);
    assert.match(html, />Build current hosted agent</);
    assert.match(html, />Deploy &amp; test</);
    assert.doesNotMatch(html, /Hosted Agents|Hosted Agent|Deploy &amp; Test/);
});

test("starter options can wrap without clipping their labels", async () => {
    const css = await readFile(new URL("../public/app.css", import.meta.url), "utf8");

    assert.match(css, /\.start-options\s*\{[\s\S]*?flex-wrap:\s*wrap;/);
    assert.match(css, /\.start-option\s*\{[\s\S]*?flex:\s*1 1 120px;/);
    assert.match(css, /\.option-title\s*\{[\s\S]*?white-space:\s*normal;/);
});

test("preview mock exposes region availability instead of a hidden region override", async () => {
    const mock = await readFile(new URL("../scripts/preview-mock.js", import.meta.url), "utf8");
    const preview = await readFile(new URL("../scripts/preview.mjs", import.meta.url), "utf8");

    assert.match(mock, /checkbox\("regionSupported", "Hosted agents available in region"/);
    assert.match(mock, /searchParams\.delete\("region"\)/);
    assert.match(preview, /searchParams\.get\("regionSupported"\) !== "false"/);
    assert.doesNotMatch(preview, /searchParams\.get\("region"\)/);
});
