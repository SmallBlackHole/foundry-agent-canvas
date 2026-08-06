// Assembles the distributable extension folder (bundled JS + static assets +
// a trimmed package.json) under dist/pkg/ and zips it to
// dist/microsoft-foundry.zip for GitHub Releases.
//
// Static HTML/CSS/assets are copied as-is. Browser JavaScript is replaced with
// the built output under dist/public/: one bundled app.js plus minified
// compatibility modules for restored canvases.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, rmSync, cpSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST_DIR = join(ROOT, "dist");
const BUILT_PUBLIC_DIR = join(DIST_DIR, "public");
const PKG_DIR = join(DIST_DIR, "pkg");
const ZIP_PATH = join(DIST_DIR, "microsoft-foundry.zip");
const FLUENT_ICONS = [
    "add_16_regular.svg",
    "arrow_circle_up_16_regular.svg",
    "arrow_clockwise_16_regular.svg",
    "arrow_swap_16_regular.svg",
    "book_20_regular.svg",
    "box_multiple_20_regular.svg",
    "calendar_20_regular.svg",
    "chat_multiple_20_regular.svg",
    "checkmark_16_regular.svg",
    "chevron_down_12_regular.svg",
    "code_20_regular.svg",
    "cube_12_regular.svg",
    "dismiss_16_regular.svg",
    "globe_search_20_regular.svg",
    "more_horizontal_20_regular.svg",
    "number_circle_1_16_regular.svg",
    "number_circle_2_16_regular.svg",
    "number_circle_3_16_regular.svg",
    "open_16_regular.svg",
    "person_16_regular.svg",
    "plug_connected_16_regular.svg",
    "question_circle_20_regular.svg",
    "rocket_20_regular.svg",
    "send_16_regular.svg",
    "shield_checkmark_20_regular.svg",
    "sparkle_20_regular.svg",
    "toolbox_20_regular.svg",
    "wrench_screwdriver_20_regular.svg",
];

// 1. Build a minified release bundle first.
execFileSync(process.execPath, [join(ROOT, "scripts", "build.mjs"), "--minify"], { stdio: "inherit" });

// 2. Stage the package folder fresh.
rmSync(PKG_DIR, { recursive: true, force: true });
mkdirSync(PKG_DIR, { recursive: true });

cpSync(join(DIST_DIR, "extension.mjs"), join(PKG_DIR, "extension.mjs"));
cpSync(join(ROOT, "public"), join(PKG_DIR, "public"), { recursive: true });
const packagedPublicDir = join(PKG_DIR, "public");
rmSync(join(packagedPublicDir, "app"), { recursive: true, force: true });
rmSync(join(packagedPublicDir, "app.js"), { force: true });
rmSync(join(packagedPublicDir, "selection-state.js"), { force: true });
rmSync(join(packagedPublicDir, "issue-report.js"), { force: true });
cpSync(BUILT_PUBLIC_DIR, packagedPublicDir, { recursive: true, force: true });
cpSync(join(ROOT, "inspector-ui"), join(PKG_DIR, "inspector-ui"), { recursive: true });
const fluentSrc = join(ROOT, "node_modules", "@fluentui", "svg-icons", "icons");
const fluentDest = join(PKG_DIR, "public", "fluent-icons");
rmSync(fluentDest, { recursive: true, force: true });
mkdirSync(fluentDest, { recursive: true });
for (const icon of FLUENT_ICONS) {
    cpSync(join(fluentSrc, icon), join(fluentDest, icon));
}

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
// directly into .github/extensions/microsoft-foundry/).
if (existsSync(ZIP_PATH)) rmSync(ZIP_PATH);

if (process.platform === "win32") {
    execFileSync("powershell", [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-Command",
        `Compress-Archive -Path '${PKG_DIR}\\*' -DestinationPath '${ZIP_PATH}' -Force`,
    ], { stdio: "inherit" });
} else {
    execFileSync("zip", ["-r", ZIP_PATH, "."], { cwd: PKG_DIR, stdio: "inherit" });
}

console.log(`Packaged -> ${ZIP_PATH}`);
