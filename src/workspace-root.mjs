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
    let revision = 0;
    const fallbackRoot = projectScopedWorkspaceRoot(extensionDir || "") || nonEmptyPath(fallbackCwd);

    function update(workingDirectory) {
        const resolved =
            nonEmptyPath(workingDirectory?.gitRoot) ||
            nonEmptyPath(workingDirectory?.cwd) ||
            nonEmptyPath(workingDirectory);
        if (resolved) {
            activeRoot = resolved;
            revision += 1;
        }
        return resolve();
    }

    function resolve() {
        return activeRoot || fallbackRoot;
    }

    update(initialWorkingDirectory);
    return {
        active: () => activeRoot,
        resolve,
        revision: () => revision,
        update,
    };
}

function latestWorkingDirectoryContext(events) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event?.type === "session.context_changed" && event.data?.cwd) {
            return event.data;
        }
        if (event?.type === "session.start" && event.data?.context?.cwd) {
            return event.data.context;
        }
    }
    return null;
}

export async function initializeWorkspaceRoot(session, resolver) {
    session.on("session.context_changed", (event) => {
        resolver.update(event.data);
    });

    const initialRevision = resolver.revision();
    const [snapshotResult, eventsResult] = await Promise.allSettled([
        session.rpc.metadata.snapshot(),
        session.getEvents(),
    ]);

    // A live context event received while the snapshots were loading is newer
    // than either response and must win.
    if (resolver.revision() !== initialRevision) return resolver.resolve();

    const snapshotCwd =
        snapshotResult.status === "fulfilled" ? nonEmptyPath(snapshotResult.value?.workingDirectory) : "";
    const historicalContext =
        eventsResult.status === "fulfilled" ? latestWorkingDirectoryContext(eventsResult.value || []) : null;
    const historicalCwd = nonEmptyPath(historicalContext?.cwd);

    if (historicalContext && (!snapshotCwd || historicalCwd === snapshotCwd)) {
        resolver.update(historicalContext);
    } else if (snapshotCwd) {
        resolver.update(snapshotCwd);
    }

    if (resolver.active()) return resolver.resolve();

    const failures = [snapshotResult, eventsResult]
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
    throw new AggregateError(failures, "Could not resolve the active session working directory.");
}
