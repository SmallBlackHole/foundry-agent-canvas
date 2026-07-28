import assert from "node:assert/strict";
import test from "node:test";

import {
    parseHostedAgentRegions,
    updateHostedAgentRegions,
} from "../scripts/sync-hosted-agent-regions.mjs";
import {
    HOSTED_AGENT_REGIONS,
    isHostedAgentRegionSupported,
} from "../src/foundry.mjs";

const learnExcerpt = `
### Region availability

Hosted agents are currently available in the following regions:

- East US 2
- UK South
- West Europe
- Australia East
- Brazil South
- Canada Central
- France Central
- Japan East
- South India
- Sweden Central

> [!NOTE]
> This list will be updated as additional regions become available.

## Next steps
`;

test("parses and normalizes hosted-agent regions from Microsoft Learn", () => {
    assert.deepEqual(parseHostedAgentRegions(learnExcerpt), [
        "australiaeast",
        "brazilsouth",
        "canadacentral",
        "eastus2",
        "francecentral",
        "japaneast",
        "southindia",
        "swedencentral",
        "uksouth",
        "westeurope",
    ]);
});

test("only rewrites the generated region block when the list changes", () => {
    const source = `before
// BEGIN HOSTED_AGENT_REGIONS
// Last synced: 2026-07-01.
export const HOSTED_AGENT_REGIONS = [
    "eastus2",
];
// END HOSTED_AGENT_REGIONS
after`;

    assert.equal(updateHostedAgentRegions(source, ["eastus2"], "2026-07-28"), source);
    const updated = updateHostedAgentRegions(source, ["eastus2", "uksouth"], "2026-07-28");
    assert.match(updated, /Last synced: 2026-07-28/);
    assert.match(updated, /"uksouth"/);
    assert.match(updated, /^before[\s\S]*after$/);
});

test("current hosted-agent support includes the latest documented regions", () => {
    assert.equal(HOSTED_AGENT_REGIONS.length, 31);
    assert.equal(isHostedAgentRegionSupported("UK South"), true);
    assert.equal(isHostedAgentRegionSupported("eastus"), true);
    assert.equal(isHostedAgentRegionSupported("antarcticnorth"), false);
});
