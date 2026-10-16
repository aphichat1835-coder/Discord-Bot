"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const checkAudit = require("../../scripts/checkAudit");

test("CheckAudit Script Suite", async (t) => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    await t.test("1. resolveNpmBin and getAuditEnv contracts", () => {
        const npmBin = checkAudit.resolveNpmBin();
        assert.ok(typeof npmBin === "string" && npmBin.length > 0);

        const env = checkAudit.getAuditEnv();
        assert.ok(env && typeof env.PATH === "string");
        assert.ok(env.PATH.length > 0);
    });

    await t.test("2. _matchesAdvisory matches strings, URLs, and package names", () => {
        const exception = {
            packageName: "node-forge",
            advisoryId: "GHSA-86w9-cpqp-85rv"
        };

        // String matches
        assert.equal(checkAudit._matchesAdvisory("node-forge", exception), true);
        assert.equal(checkAudit._matchesAdvisory("other-pkg", exception), false);

        // Object with advisory URL match
        assert.equal(checkAudit._matchesAdvisory({
            name: "test-advisory",
            url: "https://github.com/advisories/GHSA-86w9-cpqp-85rv"
        }, exception), true);

        // Object with package name match
        assert.equal(checkAudit._matchesAdvisory({
            name: "node-forge",
            url: "https://example.com"
        }, exception), true);

        // Non-matching object
        assert.equal(checkAudit._matchesAdvisory({
            name: "unrelated",
            url: "https://example.com/unrelated"
        }, exception), false);
    });

    await t.test("3. _isVulnAllowed identifies tolerated vs untolerated packages", () => {
        const allowedNodeForge = {
            severity: "high",
            via: ["node-forge"]
        };
        assert.equal(checkAudit._isVulnAllowed("node-forge", allowedNodeForge), true);

        const allowedSonarScan = {
            severity: "high",
            via: [{ name: "@sonar/scan", url: "GHSA-86w9-cpqp-85rv" }]
        };
        assert.equal(checkAudit._isVulnAllowed("@sonar/scan", allowedSonarScan), true);

        const unhandledPkg = {
            severity: "high",
            via: ["malicious-package"]
        };
        assert.equal(checkAudit._isVulnAllowed("malicious-package", unhandledPkg), false);
    });

    await t.test("4. _classifyVulnerabilities filters low/moderate and partitions unhandled vs tolerated", () => {
        const vulnerabilities = {
            "low-pkg": { severity: "low", via: ["low-pkg"] },
            "mod-pkg": { severity: "moderate", via: ["mod-pkg"] },
            "node-forge": { severity: "high", via: ["node-forge"] },
            "evil-pkg": { severity: "critical", via: ["evil-pkg"] }
        };

        const result = checkAudit._classifyVulnerabilities(vulnerabilities);
        assert.equal(result.tolerated.length, 1);
        assert.equal(result.tolerated[0].pkgName, "node-forge");

        assert.equal(result.unhandled.length, 1);
        assert.equal(result.unhandled[0].pkgName, "evil-pkg");
    });

    await t.test("5. _reportAuditResults completes cleanly when no unhandled vulnerabilities exist", () => {
        const unhandled = [];
        const tolerated = [{ pkgName: "node-forge", severity: "high" }];

        // Should not throw or exit
        assert.doesNotThrow(() => {
            checkAudit._reportAuditResults(unhandled, tolerated);
        });
    });
});
