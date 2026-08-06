import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const FOUNDRY_SCOPE = "https://ai.azure.com/.default";
export const MANAGEMENT_SCOPE = "https://management.azure.com/.default";

const IS_WINDOWS = process.platform === "win32";

function probeKnownPaths(bin) {
    if (!IS_WINDOWS) return undefined;
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const localAppData = process.env.LOCALAPPDATA;
    const candidates = [];
    if (bin === "az") {
        candidates.push(join(programFiles, "Microsoft SDKs", "Azure", "CLI2", "wbin", "az.cmd"));
    } else if (bin === "azd") {
        candidates.push(join(programFiles, "Azure Dev CLI", "azd.exe"));
        if (localAppData) candidates.push(join(localAppData, "Programs", "Azure Dev CLI", "azd.exe"));
    }
    return candidates.find((candidate) => existsSync(candidate));
}

const binCache = new Map();

function which(bin) {
    if (binCache.has(bin)) return binCache.get(bin);
    let resolved;
    try {
        const result = spawnSync(IS_WINDOWS ? "where" : "which", [bin], {
            encoding: "utf-8",
            shell: IS_WINDOWS,
        });
        if (result.status === 0 && result.stdout) {
            const lines = result.stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
            resolved = IS_WINDOWS
                ? lines.find((line) => /\.(cmd|bat|exe)$/i.test(line)) || lines[0]
                : lines[0];
        }
    } catch {
        /* fall through to known-path probe */
    }
    resolved = resolved || probeKnownPaths(bin) || (IS_WINDOWS ? `${bin}.cmd` : bin);
    binCache.set(bin, resolved);
    return resolved;
}

function quoteExe(exe) {
    return IS_WINDOWS && /\s/.test(exe) && !exe.startsWith('"') ? `"${exe}"` : exe;
}

function defaultRunCli(bin, args) {
    try {
        const result = spawnSync(quoteExe(which(bin)), args, {
            encoding: "utf-8",
            shell: IS_WINDOWS,
            windowsHide: true,
        });
        return {
            status: result.status ?? -1,
            stdout: (result.stdout || "").trim(),
            stderr: (result.stderr || "").trim(),
        };
    } catch (error) {
        return { status: -1, stdout: "", stderr: String(error?.message || error) };
    }
}

function decodeJwt(token) {
    try {
        const part = String(token).split(".")[1];
        const json = Buffer.from(
            part.replace(/-/g, "+").replace(/_/g, "/"),
            "base64",
        ).toString("utf-8");
        return JSON.parse(json);
    } catch {
        return null;
    }
}

export function createFoundryAuth({
    loadIdentity = () => import("@azure/identity"),
    runCli = defaultRunCli,
    now = Date.now,
    createSessionId = randomUUID,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    launchWaitMs = 2_500,
} = {}) {
    let credential;
    let authGeneration = 0;
    const tokenCache = new Map();
    const signIns = new Map();

    async function tokenFromIdentity(scope) {
        try {
            let activeCredential = credential;
            if (!activeCredential) {
                const generation = authGeneration;
                const identity = await loadIdentity();
                if (generation !== authGeneration) return null;
                activeCredential = credential || new identity.DefaultAzureCredential();
                credential = activeCredential;
            }
            const result = await activeCredential.getToken(scope);
            if (result?.token) {
                return {
                    token: result.token,
                    expEpochMs: result.expiresOnTimestamp || now() + 5 * 60_000,
                };
            }
        } catch {
            /* no default credential available; continue to CLI fallbacks */
        }
        return null;
    }

    async function tokenFromAz(scope) {
        const result = await runCli("az", [
            "account",
            "get-access-token",
            "--scope",
            scope,
            "-o",
            "json",
        ]);
        if (result.status !== 0 || !result.stdout) return null;
        try {
            const parsed = JSON.parse(result.stdout);
            if (!parsed.accessToken) return null;
            return {
                token: parsed.accessToken,
                expEpochMs: parsed.expires_on
                    ? Number(parsed.expires_on) * 1000
                    : now() + 5 * 60_000,
            };
        } catch {
            return null;
        }
    }

    async function tokenFromAzd(scope) {
        const result = await runCli("azd", ["auth", "token", "--scope", scope, "--output", "json"]);
        if (result.status !== 0 || !result.stdout) return null;
        try {
            const parsed = JSON.parse(result.stdout);
            if (!parsed.token) return null;
            const expiresOn = parsed.expiresOn ? Date.parse(parsed.expiresOn) : now() + 5 * 60_000;
            return {
                token: parsed.token,
                expEpochMs: Number.isFinite(expiresOn) ? expiresOn : now() + 5 * 60_000,
            };
        } catch {
            return null;
        }
    }

    async function getToken(scope = FOUNDRY_SCOPE) {
        const hit = tokenCache.get(scope);
        if (hit && now() < hit.expEpochMs - 60_000) return hit.token;
        const generation = authGeneration;
        const result = (await tokenFromIdentity(scope))
            || (await tokenFromAz(scope))
            || (await tokenFromAzd(scope));
        if (generation !== authGeneration) throw new Error("auth_changed");
        if (!result) throw new Error("not_signed_in");
        tokenCache.set(scope, result);
        return result.token;
    }

    async function getIdentity() {
        const generation = authGeneration;
        const token = (await tokenFromIdentity(MANAGEMENT_SCOPE))?.token;
        if (token && generation === authGeneration) {
            const payload = decodeJwt(token);
            if (payload) {
                return {
                    signedIn: true,
                    account: payload.upn
                        || payload.preferred_username
                        || payload.unique_name
                        || payload.email
                        || "",
                    tenantId: payload.tid || "",
                };
            }
        }

        const result = await runCli("az", ["account", "show", "-o", "json"]);
        if (result.status === 0 && result.stdout) {
            try {
                const account = JSON.parse(result.stdout);
                return {
                    signedIn: true,
                    account: account?.user?.name || "",
                    tenantId: account?.tenantId || "",
                };
            } catch {
                /* fall through */
            }
        }
        return { signedIn: false, account: "", tenantId: "" };
    }

    async function getDefaultSubscriptionId() {
        const result = await runCli("az", ["account", "show", "--query", "id", "-o", "tsv"]);
        return result.status === 0 && result.stdout ? result.stdout.trim() : "";
    }

    async function signInStart() {
        const sessionId = createSessionId();
        let InteractiveBrowserCredential;
        try {
            ({ InteractiveBrowserCredential } = await loadIdentity());
        } catch (error) {
            return {
                ok: false,
                reason: "identity_missing",
                error: String(error?.message || error),
            };
        }

        const abortController = new AbortController();
        const record = {
            credential: new InteractiveBrowserCredential({
                redirectUri: "http://localhost",
            }),
            abortController,
            status: "pending",
            error: "",
            mode: "interactive",
        };
        signIns.set(sessionId, record);

        record.credential.getToken(MANAGEMENT_SCOPE, {
            abortSignal: abortController.signal,
        }).then(() => {
            if (record.status !== "pending") return;
            record.status = "done";
            authGeneration += 1;
            credential = record.credential;
            tokenCache.clear();
        }).catch((error) => {
            if (record.status !== "pending") return;
            record.status = abortController.signal.aborted ? "cancelled" : "error";
            record.error = String(error?.message || error).slice(0, 400);
        });

        const deadline = now() + launchWaitMs;
        while (now() < deadline && record.status === "pending") {
            await sleep(Math.min(150, Math.max(0, deadline - now())));
        }
        if (record.status === "error") {
            signIns.delete(sessionId);
            return {
                ok: false,
                sessionId,
                reason: "login_failed",
                error: record.error,
            };
        }
        return { ok: true, sessionId, mode: "interactive" };
    }

    async function signInStatus(sessionId) {
        const record = signIns.get(sessionId);
        if (!record) return { ok: false, status: "unknown" };
        if (record.status === "done") {
            const identity = await getIdentity();
            signIns.delete(sessionId);
            return { ok: true, status: "done", identity };
        }
        if (record.status === "error" || record.status === "cancelled") {
            signIns.delete(sessionId);
            return {
                ok: record.status !== "error",
                status: record.status,
                error: record.error,
            };
        }
        return { ok: true, status: "pending", mode: record.mode };
    }

    function signInCancel(sessionId) {
        const record = signIns.get(sessionId);
        if (record?.status === "pending") {
            record.status = "cancelled";
            signIns.delete(sessionId);
            record.abortController.abort();
        }
        return { ok: true };
    }

    async function signOut() {
        authGeneration += 1;
        for (const record of signIns.values()) {
            if (record.status === "pending") {
                record.status = "cancelled";
                record.abortController.abort();
            }
        }
        signIns.clear();
        credential = undefined;
        tokenCache.clear();
        return { ok: true };
    }

    return {
        getGeneration: () => authGeneration,
        getToken,
        getIdentity,
        getDefaultSubscriptionId,
        signInStart,
        signInStatus,
        signInCancel,
        signOut,
    };
}

const auth = createFoundryAuth();

export const getAuthGeneration = auth.getGeneration;
export const getToken = auth.getToken;
export const getIdentity = auth.getIdentity;
export const getDefaultSubscriptionId = auth.getDefaultSubscriptionId;
export const signInStart = auth.signInStart;
export const signInStatus = auth.signInStatus;
export const signInCancel = auth.signInCancel;
export const signOut = auth.signOut;
