// SemVer-compatible comparison shared by the Foundry Skills sync and the
// marketplace plugin update check. Missing core segments are zero-filled so
// "1.0" equals "1.0.0"; build metadata does not affect precedence.
export function compareVersions(a, b) {
    const left = parseVersion(a);
    const right = parseVersion(b);
    const coreLength = Math.max(left.core.length, right.core.length);

    for (let i = 0; i < coreLength; i++) {
        const cmp = compareIdentifier(left.core[i] ?? "0", right.core[i] ?? "0", false);
        if (cmp !== 0) return cmp;
    }

    if (!left.prerelease.length && !right.prerelease.length) return 0;
    if (!left.prerelease.length) return 1;
    if (!right.prerelease.length) return -1;

    const prereleaseLength = Math.max(left.prerelease.length, right.prerelease.length);
    for (let i = 0; i < prereleaseLength; i++) {
        if (i >= left.prerelease.length) return -1;
        if (i >= right.prerelease.length) return 1;
        const cmp = compareIdentifier(left.prerelease[i], right.prerelease[i], true);
        if (cmp !== 0) return cmp;
    }
    return 0;
}

function parseVersion(value) {
    const normalized = String(value || "").trim().replace(/^v(?=\d)/i, "");
    const withoutBuild = normalized.split("+", 1)[0];
    const separator = withoutBuild.indexOf("-");
    const core = separator >= 0 ? withoutBuild.slice(0, separator) : withoutBuild;
    const prerelease = separator >= 0 ? withoutBuild.slice(separator + 1) : "";
    return {
        core: core.split(".").map((identifier) => identifier || "0"),
        prerelease: prerelease ? prerelease.split(".") : [],
    };
}

function compareIdentifier(left, right, prerelease) {
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
        const normalizedLeft = left.replace(/^0+(?=\d)/, "");
        const normalizedRight = right.replace(/^0+(?=\d)/, "");
        if (normalizedLeft.length !== normalizedRight.length) {
            return normalizedLeft.length < normalizedRight.length ? -1 : 1;
        }
        if (normalizedLeft === normalizedRight) return 0;
        return normalizedLeft < normalizedRight ? -1 : 1;
    }
    if (prerelease && leftNumeric !== rightNumeric) {
        return leftNumeric ? -1 : 1;
    }
    if (left === right) return 0;
    return left < right ? -1 : 1;
}
