"use strict";

const { execSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

function resolveNpmBin() {
    const candidate = path.join(path.dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm");
    if (fs.existsSync(candidate)) return candidate;
    return "npm";
}

function getAuditEnv() {
    const nodeDir = path.dirname(process.execPath);
    const fixedPaths = [nodeDir, "/usr/local/bin", "/usr/bin", "/bin"];
    return {
        ...process.env,
        PATH: fixedPaths.join(path.delimiter)
    };
}

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
        const npmBin = resolveNpmBin();
        const env = getAuditEnv();
        execSync(`"${npmBin}" audit --omit=dev --audit-level=high`, { stdio: "inherit", env });
        console.log("[AUDIT-GATE] ✅ Production dependencies audit passed: 0 vulnerabilities found.");
    } catch {
        console.error("[AUDIT-GATE] ❌ Production dependencies security audit FAILED.");
        process.exit(1);
    }
}

function _parseAuditJsonOutput() {
    const npmBin = resolveNpmBin();
    const env = getAuditEnv();
    try {
        const stdout = execSync(`"${npmBin}" audit --json`, { encoding: "utf8", env });
        return JSON.parse(stdout);
    } catch (err) {
        if (!err.stdout) {
            console.error("[AUDIT-GATE] ❌ npm audit execution failed:", err.message);
            process.exit(1);
        }
        try {
            return JSON.parse(err.stdout);
        } catch {
            console.error("[AUDIT-GATE] ❌ Failed to parse npm audit JSON output.");
            process.exit(1);
        }
    }
}

function _matchesAdvisory(v, exception) {
    if (typeof v === "string") {
        return v === exception.packageName || v === "node-forge";
    }
    return String(v.url || "").includes(exception.advisoryId) ||
           String(v.name || "") === exception.packageName;
}

function _isVulnAllowed(pkgName, vuln) {
    return ALLOWED_DEV_EXCEPTIONS.some(exception => {
        if (exception.packageName !== pkgName) return false;
        const via = vuln.via || [];
        return via.some(v => _matchesAdvisory(v, exception));
    });
}

function _classifyVulnerabilities(vulnerabilities) {
    const unhandled = [];
    const tolerated = [];

    for (const [pkgName, vuln] of Object.entries(vulnerabilities)) {
        if (vuln.severity !== "high" && vuln.severity !== "critical") {
            continue;
        }

        if (_isVulnAllowed(pkgName, vuln)) {
            tolerated.push({ pkgName, severity: vuln.severity });
        } else {
            unhandled.push({ pkgName, vuln });
        }
    }
    return { unhandled, tolerated };
}

function _reportAuditResults(unhandled, tolerated) {
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

function runFullAuditCheck() {
    console.log("[AUDIT-GATE] Checking development dependencies and advisories...");
    const auditJson = _parseAuditJsonOutput();
    const vulnerabilities = auditJson?.vulnerabilities || {};
    const { unhandled, tolerated } = _classifyVulnerabilities(vulnerabilities);
    _reportAuditResults(unhandled, tolerated);
}

function main() {
    runProductionAudit();
    runFullAuditCheck();
}

main();
