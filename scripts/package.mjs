// Assembles the distributable extension folder (bundled JS + static assets +
// a trimmed package.json) under dist/pkg/ and zips it to
// dist/foundry-agent-canvas.zip for GitHub Releases.
//
// Static assets (public/, inspector-ui/) are copied as-is; they are consumed
// at runtime via readFileSync/serve-from-disk, not bundled by esbuild.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, rmSync, cpSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST_DIR = join(ROOT, "dist");
const PKG_DIR = join(DIST_DIR, "pkg");
const ZIP_PATH = join(DIST_DIR, "foundry-agent-canvas.zip");

// 1. Build the bundle first.
execFileSync(process.execPath, [join(ROOT, "scripts", "build.mjs")], { stdio: "inherit" });

// 2. Stage the package folder fresh.
rmSync(PKG_DIR, { recursive: true, force: true });
mkdirSync(PKG_DIR, { recursive: true });

cpSync(join(DIST_DIR, "extension.mjs"), join(PKG_DIR, "extension.mjs"));
cpSync(join(ROOT, "public"), join(PKG_DIR, "public"), { recursive: true });
cpSync(join(ROOT, "inspector-ui"), join(PKG_DIR, "inspector-ui"), { recursive: true });
cpSync(join(ROOT, "README.md"), join(PKG_DIR, "README.md"));

// Trimmed package.json: no devDependencies/scripts, no dependencies (they're
// inlined into extension.mjs by esbuild), just identity metadata.
const srcPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
writeFileSync(
    join(PKG_DIR, "package.json"),
    JSON.stringify(
        {
            name: srcPkg.name,
            version: srcPkg.version,
            private: true,
            type: "module",
            description: srcPkg.description,
        },
        null,
        4
    ) + "\n"
);

// 3. Zip it up (zip root = extension folder contents, so it can be unzipped
// directly into .github/extensions/foundry-agent-canvas/).
if (existsSync(ZIP_PATH)) rmSync(ZIP_PATH);

if (process.platform === "win32") {
    execFileSync("powershell", [
        "-NoProfile",
        "-Command",
        `Compress-Archive -Path '${PKG_DIR}\\*' -DestinationPath '${ZIP_PATH}' -Force`,
    ], { stdio: "inherit" });
} else {
    execFileSync("zip", ["-r", ZIP_PATH, "."], { cwd: PKG_DIR, stdio: "inherit" });
}

console.log(`Packaged -> ${ZIP_PATH}`);
