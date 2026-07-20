import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

function nonEmptyPath(value) {
    return typeof value === "string" && value.trim() ? value.trim() : "";
}

function projectScopedWorkspaceRoot(extensionDir) {
    const extensionsDir = dirname(extensionDir);
    const githubDir = dirname(extensionsDir);
    if (
        basename(extensionsDir).toLowerCase() === "extensions" &&
        basename(githubDir).toLowerCase() === ".github" &&
        existsSync(githubDir)
    ) {
        return dirname(githubDir);
    }
    return "";
}

export function createWorkspaceRootResolver({
    extensionDir,
    initialWorkingDirectory,
    fallbackCwd = process.cwd(),
} = {}) {
    let activeRoot = "";
    const fallbackRoot = projectScopedWorkspaceRoot(extensionDir || "") || nonEmptyPath(fallbackCwd);

    function update(workingDirectory) {
        const resolved =
            nonEmptyPath(workingDirectory?.gitRoot) ||
            nonEmptyPath(workingDirectory?.cwd) ||
            nonEmptyPath(workingDirectory);
        if (resolved) activeRoot = resolved;
        return resolve();
    }

    function resolve() {
        return activeRoot || fallbackRoot;
    }

    update(initialWorkingDirectory);
    return { resolve, update };
}
