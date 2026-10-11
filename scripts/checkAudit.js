"use strict";

const { execSync } = require("node:child_process");

const ALLOWED_DEV_EXCEPTIONS = [
    {
        packageName: "node-forge",
        parentPackage: "@sonar/scan",
        advisoryId: "GHSA-86w9-cpqp-85rv",
        reason: "Development and CI scanner tooling only; not included in production runtime. Upstream @sonar/scan has no patched release available."
    },
    {
        packageName: "@sonar/scan",
        parentPackage: null,
        advisoryId: "GHSA-86w9-cpqp-85rv",
        reason: "Direct devDependency wrapping vulnerable transitive node-forge. Upstream has no fix available."
    }
];

function runProductionAudit() {
    console.log("[AUDIT-GATE] Running production dependencies security audit...");
    try {
        execSync("npm audit --omit=dev --audit-level=high", { stdio: "inherit" });
        console.log("[AUDIT-GATE] ✅ Production dependencies audit passed: 0 vulnerabilities found.");
    } catch {
        console.error("[AUDIT-GATE] ❌ Production dependencies security audit FAILED.");
        process.exit(1);
    }
}

function runFullAuditCheck() {
    console.log("[AUDIT-GATE] Checking development dependencies and advisories...");
    let auditJson;
    try {
        const stdout = execSync("npm audit --json", { encoding: "utf8" });
        auditJson = JSON.parse(stdout);
    } catch (err) {
        if (err.stdout) {
            try {
                auditJson = JSON.parse(err.stdout);
            } catch {
                console.error("[AUDIT-GATE] ❌ Failed to parse npm audit JSON output.");
                process.exit(1);
            }
        } else {
            console.error("[AUDIT-GATE] ❌ npm audit execution failed:", err.message);
            process.exit(1);
        }
    }

    const vulnerabilities = auditJson?.vulnerabilities || {};
    const unhandled = [];
    const tolerated = [];

    for (const [pkgName, vuln] of Object.entries(vulnerabilities)) {
        if (vuln.severity !== "high" && vuln.severity !== "critical") {
            continue;
        }

        const isAllowed = ALLOWED_DEV_EXCEPTIONS.some(exception => {
            if (exception.packageName !== pkgName) return false;
            const via = vuln.via || [];
            const matchesAdvisory = via.some(v => {
                if (typeof v === "string") return v === exception.packageName || v === "node-forge";
                return String(v.url || "").includes(exception.advisoryId) ||
                       String(v.name || "") === exception.packageName;
            });
            return matchesAdvisory;
        });

        if (isAllowed) {
            tolerated.push({ pkgName, severity: vuln.severity });
        } else {
            unhandled.push({ pkgName, vuln });
        }
    }

    if (unhandled.length > 0) {
        console.error("[AUDIT-GATE] ❌ Unhandled high/critical vulnerabilities found:");
        for (const item of unhandled) {
            console.error(`- ${item.pkgName} (${item.vuln.severity}):`, JSON.stringify(item.vuln.via));
        }
        process.exit(1);
    }

    if (tolerated.length > 0) {
        console.log("[AUDIT-GATE] ⚠️ Documented Dev-Dependency Exception Accepted:");
        for (const exp of ALLOWED_DEV_EXCEPTIONS) {
            console.log(`  - Package: ${exp.packageName} (Advisory: ${exp.advisoryId})`);
            console.log(`    Scope: ${exp.reason}`);
        }
    }

    console.log("[AUDIT-GATE] ✅ Security audit gate completed successfully.");
}

function main() {
    runProductionAudit();
    runFullAuditCheck();
}

main();
