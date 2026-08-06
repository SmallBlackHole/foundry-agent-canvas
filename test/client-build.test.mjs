import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("the release build bundles app.js and minifies compatibility modules", async () => {
    await execFileAsync(
        process.execPath,
        [join(ROOT, "scripts", "build.mjs"), "--minify"],
        { cwd: ROOT },
    );

    const sourceModules = await readdir(join(ROOT, "public", "app"));
    const sourcePaths = [
        join(ROOT, "public", "app.js"),
        join(ROOT, "public", "selection-state.js"),
        join(ROOT, "public", "issue-report.js"),
        ...sourceModules
            .filter((name) => name.endsWith(".js"))
            .map((name) => join(ROOT, "public", "app", name)),
    ];
    const sourceSize = (
        await Promise.all(sourcePaths.map((path) => stat(path)))
    ).reduce((total, item) => total + item.size, 0);

    const bundlePath = join(ROOT, "dist", "public", "app.js");
    const bundle = await readFile(bundlePath, "utf8");
    assert.ok(bundle.length > 0);
    assert.ok(bundle.length < sourceSize);
    assert.ok(bundle.split(/\r?\n/).length <= 6);
    assert.doesNotMatch(bundle, /\bfrom\s*["'][^"']+["']/);

    for (const name of sourceModules.filter((item) => item.endsWith(".js"))) {
        const compatibilityModule = await readFile(
            join(ROOT, "dist", "public", "app", name),
            "utf8",
        );
        assert.ok(compatibilityModule.length > 0);
        assert.ok(compatibilityModule.split(/\r?\n/).length <= 5);
    }
    await Promise.all([
        readFile(join(ROOT, "dist", "public", "selection-state.js"), "utf8"),
        readFile(join(ROOT, "dist", "public", "issue-report.js"), "utf8"),
    ]);
});

test("packaging overlays source browser JavaScript with built output", async () => {
    const source = await readFile(
        join(ROOT, "scripts", "package.mjs"),
        "utf8",
    );

    assert.match(
        source,
        /rmSync\(join\(packagedPublicDir, "app"\), \{ recursive: true, force: true \}\)/,
    );
    assert.match(
        source,
        /cpSync\(BUILT_PUBLIC_DIR, packagedPublicDir, \{ recursive: true, force: true \}\)/,
    );
});
