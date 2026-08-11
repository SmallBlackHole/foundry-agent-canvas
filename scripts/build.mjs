// Builds the two runtime entrypoints:
// - extension.mjs and its Node dependencies -> dist/extension.mjs
// - public/app.js and its browser modules -> dist/public/app.js
//
// `@github/copilot-sdk/extension` is provided by the Copilot App host at
// runtime, not an npm package we ship, so it must stay external. Node
// builtins are external automatically under platform: "node".

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, readdirSync, rmSync } from "node:fs";

import { TELEMETRY_CONNECTION_STRING_ENV } from "../public/telemetry-constants.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST_DIR = join(ROOT, "dist");
const PUBLIC_DIR = join(ROOT, "public");
const CLIENT_DIST_DIR = join(DIST_DIR, "public");
const MINIFY = process.argv.includes("--minify");
const compatibilityClientEntries = [
    join(PUBLIC_DIR, "selection-state.js"),
    join(PUBLIC_DIR, "issue-report.js"),
    join(PUBLIC_DIR, "telemetry-constants.js"),
    ...readdirSync(join(PUBLIC_DIR, "app"))
        .filter((name) => name.endsWith(".js"))
        .sort()
        .map((name) => join(PUBLIC_DIR, "app", name)),
];
const telemetryConnectionString = String(
    process.env[TELEMETRY_CONNECTION_STRING_ENV] || "",
).trim();
const telemetryConnectionStringBase64 = telemetryConnectionString
    ? Buffer.from(telemetryConnectionString, "utf-8").toString("base64")
    : "";

mkdirSync(DIST_DIR, { recursive: true });
rmSync(CLIENT_DIST_DIR, { recursive: true, force: true });
mkdirSync(CLIENT_DIST_DIR, { recursive: true });

await build({
    entryPoints: [join(ROOT, "extension.mjs")],
    outfile: join(DIST_DIR, "extension.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20.19",
    minify: MINIFY,
    external: ["@github/copilot-sdk/extension"],
    define: {
        __FOUNDRY_CANVAS_APPINSIGHTS_CONNECTION_STRING_BASE64__: JSON.stringify(
            telemetryConnectionStringBase64,
        ),
    },
    // esbuild's ESM output wraps bundled CommonJS deps (e.g. ws) in a
    // __require() shim that delegates to a global `require`. In a real ESM
    // module there is no global `require`, so calls like __require("events")
    // throw "Dynamic require of ... is not supported". Injecting a
    // createRequire-based `require` into module scope gives the shim a real
    // require to resolve Node builtins and any CJS externals.
    banner: {
        js: "import { createRequire as __cliCreateRequire } from 'node:module'; const require = __cliCreateRequire(import.meta.url);",
    },
    logLevel: "info",
});

console.log(`Bundled${MINIFY ? " and minified" : ""} extension.mjs -> ${join(DIST_DIR, "extension.mjs")}`);

await Promise.all([
    build({
        entryPoints: [join(PUBLIC_DIR, "app.js")],
        outfile: join(CLIENT_DIST_DIR, "app.js"),
        bundle: true,
        platform: "browser",
        format: "esm",
        target: "es2022",
        minify: MINIFY,
        logLevel: "info",
    }),
    // Retain minified standalone modules for restored canvases that may still
    // request the previous modular graph while a host-managed update settles.
    build({
        entryPoints: compatibilityClientEntries,
        outbase: PUBLIC_DIR,
        outdir: CLIENT_DIST_DIR,
        bundle: false,
        platform: "browser",
        format: "esm",
        target: "es2022",
        minify: MINIFY,
        logLevel: "info",
    }),
]);

console.log(
    `Bundled${MINIFY ? " and minified" : ""} public/app.js -> `
    + join(CLIENT_DIST_DIR, "app.js"),
);
