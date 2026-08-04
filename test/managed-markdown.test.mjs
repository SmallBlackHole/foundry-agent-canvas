import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    markdownToSafeNodes,
    safeMarkdownUrl,
} from "../public/managed-markdown.js";

function elements(nodes, tag) {
    const found = [];
    for (const node of nodes) {
        if (node.type !== "element") continue;
        if (!tag || node.tag === tag) found.push(node);
        found.push(...elements(node.children, tag));
    }
    return found;
}

function visibleText(nodes) {
    return nodes.map((node) => (
        node.type === "text" ? node.value : visibleText(node.children)
    )).join("");
}

test("renders practical chat Markdown as safe structured nodes", () => {
    const nodes = markdownToSafeNodes([
        "# Heading",
        "",
        "A **bold** and *emphasized* [link](https://example.com/docs) with `code`.",
        "",
        "- first",
        "- second",
        "",
        "> quoted",
        "",
        "```js",
        "const value = 1;",
        "```",
    ].join("\n"));

    assert.equal(elements(nodes, "h1").length, 1);
    assert.equal(elements(nodes, "strong").length, 1);
    assert.equal(elements(nodes, "em").length, 1);
    assert.equal(elements(nodes, "ul").length, 1);
    assert.equal(elements(nodes, "li").length, 2);
    assert.equal(elements(nodes, "blockquote").length, 1);
    assert.equal(elements(nodes, "pre").length, 1);
    assert.equal(elements(nodes, "code").length, 2);
    assert.deepEqual(elements(nodes, "a")[0].attributes, {
        href: "https://example.com/docs",
        target: "_blank",
        rel: "noopener noreferrer",
    });
});

test("neutralizes raw HTML, images, and executable URLs", () => {
    const nodes = markdownToSafeNodes([
        "<script>alert('html')</script>",
        "",
        "Inline <img src=x onerror=alert(1)> HTML.",
        "",
        "[script](javascript:alert(1)) [data](data:text/html,boom) [safe](https://example.com/)",
        "",
        "![remote](https://example.com/tracker.png)",
    ].join("\n"));

    assert.equal(elements(nodes, "script").length, 0);
    assert.equal(elements(nodes, "img").length, 0);
    assert.equal(elements(nodes, "a").length, 1);
    assert.match(visibleText(nodes), /<script>alert\('html'\)<\/script>/);
    assert.match(visibleText(nodes), /<img src=x onerror=alert\(1\)>/);
    assert.match(visibleText(nodes), /script data safe/);
    assert.match(visibleText(nodes), /\[image: remote\]/);
    assert.equal(safeMarkdownUrl("javascript:alert(1)"), "");
    assert.equal(safeMarkdownUrl("JaVaScRiPt:alert(1)"), "");
    assert.equal(safeMarkdownUrl("java%0ascript:alert(1)"), "");
    assert.equal(safeMarkdownUrl("data:text/html,boom"), "");
    assert.equal(safeMarkdownUrl("vbscript:msgbox(1)"), "");
    assert.equal(safeMarkdownUrl("https://example.com/a"), "https://example.com/a");
});

test("keeps fenced code literal and handles partial streaming Markdown", () => {
    const partialEmphasis = markdownToSafeNodes("Start **bold");
    const partialFence = markdownToSafeNodes("```js\nconst value = 1;");
    const complete = markdownToSafeNodes("Start **bold**");

    assert.equal(elements(partialEmphasis, "strong").length, 0);
    assert.equal(visibleText(partialEmphasis), "Start **bold");
    assert.equal(elements(partialFence, "pre").length, 1);
    assert.equal(visibleText(partialFence), "const value = 1;");
    assert.equal(elements(complete, "strong").length, 1);
    assert.equal(visibleText(complete), "Start bold");
});

test("managed playground renders only assistant messages as Markdown", async () => {
    const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

    assert.match(app, /if \(message\.role === "assistant"\) \{\s*renderManagedAssistantMarkdown\(row, message\.text\);/);
    assert.match(app, /else \{\s*row\.textContent = message\.text;/);
    assert.doesNotMatch(app, /row\.innerHTML\s*=/);
});

test("ships the exact licensed parser through packaged public assets", async () => {
    const [packageJson, vendor, license, routes, packageScript] = await Promise.all([
        readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
        readFile(new URL("../public/vendor/marked/marked.esm.js", import.meta.url), "utf8"),
        readFile(new URL("../public/vendor/marked/LICENSE", import.meta.url), "utf8"),
        readFile(new URL("../src/routes.mjs", import.meta.url), "utf8"),
        readFile(new URL("../scripts/package.mjs", import.meta.url), "utf8"),
    ]);

    assert.match(vendor, new RegExp(`marked v${packageJson.dependencies.marked.replaceAll(".", "\\.")}`));
    assert.match(license, /Permission is hereby granted, free of charge/);
    assert.match(routes, /path === "\/managed-markdown\.js"/);
    assert.match(routes, /path === "\/vendor\/marked\/marked\.esm\.js"/);
    assert.match(packageScript, /cpSync\(join\(ROOT, "public"\), join\(PKG_DIR, "public"\), \{ recursive: true \}\)/);
});
