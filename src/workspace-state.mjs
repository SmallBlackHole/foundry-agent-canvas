import { watch as watchWorkspace } from "node:fs";

import { initialBuildSections } from "./build-sections.mjs";
import { inspectHostedAgentWorkspace } from "./local-agent.mjs";
import { pushFrame } from "./server-utils.mjs";

export const WORKSPACE_STATE_FRAME_TYPE = "workspaceState";
export const MONITOR_INTERVAL_MS = 5_000;
export const MONITOR_MAX_ATTEMPTS = 60;
export const MONITOR_DEBOUNCE_MS = 250;

export function flushPendingWorkspaceState(entry, client) {
    const frame = entry?.pendingWorkspaceStateFrame;
    if (!frame) return false;
    try {
        client.write(`data: ${JSON.stringify(frame)}\n\n`);
        entry.pendingWorkspaceStateFrame = null;
        return true;
    } catch {
        return false;
    }
}

export function cancelWorkspaceStateMonitor(entry) {
    const controller = entry?.workspaceStateMonitor;
    if (!controller) return false;
    controller.cancel();
    return true;
}

export async function refreshWorkspaceState(
    entry,
    workspaceRootFn,
    {
        inspectWorkspace = inspectHostedAgentWorkspace,
        isActive = () => true,
        push = pushFrame,
        source = "monitor",
    } = {},
) {
    const root = await workspaceRootFn();
    const info = await inspectWorkspace(root);
    const sections = initialBuildSections(info);
    let transitioned = false;

    if (isActive() && info.hasAgent && !entry.workspaceStateTransitioned) {
        entry.workspaceStateTransitioned = true;
        const frame = {
            type: WORKSPACE_STATE_FRAME_TYPE,
            source,
            hasAzure: info.hasAzure,
            hasAgent: true,
            initialized: true,
            manifestPath: info.manifestPath || "",
            sections,
        };
        if (!entry.sseClients?.size || push(entry, frame) === 0) {
            entry.pendingWorkspaceStateFrame = frame;
        }
        transitioned = true;
    }

    return {
        source,
        hasAzure: info.hasAzure,
        hasAgent: info.hasAgent,
        initialized: info.hasAzure || info.hasAgent,
        manifestPath: info.manifestPath || "",
        sections,
        transitioned,
    };
}

export function startWorkspaceStateMonitor(
    entry,
    refresh,
    {
        workspaceRoot = "",
        intervalMs = MONITOR_INTERVAL_MS,
        maxAttempts = MONITOR_MAX_ATTEMPTS,
        debounceMs = MONITOR_DEBOUNCE_MS,
        watchFactory = watchWorkspace,
        onError = async () => {},
        onWatchError = async () => {},
    } = {},
) {
    cancelWorkspaceStateMonitor(entry);
    entry.workspaceStateTransitioned = false;
    entry.pendingWorkspaceStateFrame = null;
    let resolveMonitor;
    let activeCheck = null;
    let pendingSource = "";
    let pollAttempts = 0;
    let lastResult = null;
    const controller = {
        finished: false,
        watcher: null,
        debounceTimer: null,
        pollTimer: null,
        promise: new Promise((resolve) => {
            resolveMonitor = resolve;
        }),
        cancel: () => finish(null),
    };
    entry.workspaceStateMonitor = controller;

    function report(callback, ...args) {
        try {
            Promise.resolve(callback(...args)).catch(() => {
                /* reporting failures must not stop workspace monitoring */
            });
        } catch {
            /* reporting failures must not stop workspace monitoring */
        }
    }

    function finish(result) {
        if (controller.finished) return;
        controller.finished = true;
        pendingSource = "";
        if (controller.debounceTimer) {
            clearTimeout(controller.debounceTimer);
            controller.debounceTimer = null;
        }
        if (controller.pollTimer) {
            clearTimeout(controller.pollTimer);
            controller.pollTimer = null;
        }
        const watcher = controller.watcher;
        controller.watcher = null;
        if (watcher) {
            try {
                watcher.close();
            } catch {
                /* watcher may already be closed after an error */
            }
        }
        if (entry.workspaceStateMonitor === controller) {
            entry.workspaceStateMonitor = null;
        }
        resolveMonitor(result);
    }

    async function check(source) {
        if (controller.finished) return null;
        if (activeCheck) {
            pendingSource = source;
            return activeCheck;
        }
        activeCheck = (async () => {
            try {
                lastResult = await refresh(source, () => !controller.finished);
                if (lastResult?.hasAgent) finish(lastResult);
                return lastResult;
            } catch (err) {
                report(onError, err, source);
                return null;
            }
        })();
        try {
            return await activeCheck;
        } finally {
            activeCheck = null;
            if (pendingSource && !controller.finished) {
                const source = pendingSource;
                pendingSource = "";
                queueMicrotask(() => void check(source));
            }
        }
    }

    function scheduleWatchCheck() {
        if (controller.finished) return;
        if (controller.debounceTimer) clearTimeout(controller.debounceTimer);
        if (debounceMs <= 0) {
            queueMicrotask(() => void check("watch"));
            return;
        }
        controller.debounceTimer = setTimeout(() => {
            controller.debounceTimer = null;
            void check("watch");
        }, debounceMs);
        controller.debounceTimer.unref?.();
    }

    async function poll() {
        if (controller.finished) return;
        pollAttempts += 1;
        await check("poll");
        if (controller.finished) return;
        if (pollAttempts >= maxAttempts) {
            finish(lastResult);
            return;
        }
        if (intervalMs <= 0) {
            queueMicrotask(() => void poll());
        } else {
            controller.pollTimer = setTimeout(() => {
                controller.pollTimer = null;
                void poll();
            }, intervalMs);
            controller.pollTimer.unref?.();
        }
    }

    if (workspaceRoot) {
        try {
            controller.watcher = watchFactory(workspaceRoot, { recursive: true }, scheduleWatchCheck);
            controller.watcher.on?.("error", (err) => {
                if (controller.finished || !controller.watcher) return;
                const watcher = controller.watcher;
                controller.watcher = null;
                try {
                    watcher.close();
                } catch {
                    /* watcher already failed */
                }
                report(onWatchError, err);
            });
        } catch (err) {
            report(onWatchError, err);
        }
    }

    void poll();
    return controller;
}
