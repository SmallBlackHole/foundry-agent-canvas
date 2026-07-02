// Bundles the extension entry point (extension.mjs) plus its local modules
// (catalog.mjs, foundry.mjs, inspector-backend/index.mjs) and their npm
// dependencies (@azure/identity, ws) into a single ESM file under dist/.
//
// `@github/copilot-sdk/extension` is provided by the Copilot CLI host at
// runtime, not an npm package we ship, so it must stay external. Node
// builtins are external automatically under platform: "node".

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST_DIR = join(ROOT, "dist");

mkdirSync(DIST_DIR, { recursive: true });

await build({
    entryPoints: [join(ROOT, "extension.mjs")],
    outfile: join(DIST_DIR, "extension.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    external: ["@github/copilot-sdk/extension"],
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

console.log(`Bundled extension.mjs -> ${join(DIST_DIR, "extension.mjs")}`);
