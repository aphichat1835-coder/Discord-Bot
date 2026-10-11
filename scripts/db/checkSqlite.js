#!/usr/bin/env node
"use strict";

const { openDatabase, closeDatabase, resolveDbPath } = require("../../database/sqlite/connection");
const { runStartupCheck } = require("../../database/sqlite/maintenance/startupCheck");

function parseArgs() {
    const args = process.argv.slice(2);
    let customPath = null;
    for (let i = 0; i < args.length; i++) {
        if ((args[i] === "--path" || args[i] === "-p") && args[i + 1]) {
            customPath = args[i + 1];
            i++;
        }
    }
    return { customPath };
}

async function main() {
    console.log("[CHECK-SQLITE] 🔍 Starting standalone SQLite health probe...");
    const { customPath } = parseArgs();
    const dbPath = resolveDbPath(customPath);
    console.log(`[CHECK-SQLITE] 📁 Database target: ${dbPath}`);

    let db;
    try {
        db = openDatabase({ path: dbPath });
        const results = runStartupCheck(db, { dbPath });

        console.log("------------------------------------------------------------");
        console.log(`[CHECK-SQLITE] Status:               ${results.ok ? "✅ HEALTHY" : "❌ FAILED"}`);
        console.log(`[CHECK-SQLITE] Duration:             ${results.durationMs}ms`);
        console.log(`[CHECK-SQLITE] Connection:           ${results.checks.connection ? "PASS" : "FAIL"}`);
        console.log(`[CHECK-SQLITE] PRAGMAs (WAL/FK):     ${results.checks.pragmas ? "PASS" : "FAIL"}`);
        console.log(`[CHECK-SQLITE] Migrations:           ${results.checks.migrations ? "PASS" : "FAIL"} (Version ${results.stats.migration?.currentVersion})`);
        console.log(`[CHECK-SQLITE] Read Probe:           ${results.checks.readProbe ? "PASS" : "FAIL"}`);
        console.log(`[CHECK-SQLITE] Write/Rollback Probe: ${results.checks.writeRollbackProbe ? "PASS" : "FAIL"}`);
        console.log(`[CHECK-SQLITE] Quick Integrity:      ${results.checks.quickIntegrity ? "PASS" : "FAIL"}`);
        console.log(`[CHECK-SQLITE] Tables Count:         ${results.stats.tablesCount} (${(results.stats.tables || []).join(", ")})`);

        if (results.stats.quota) {
            const q = results.stats.quota;
            const pct = ((q.footprint.totalMb / q.limits.hardMb) * 100).toFixed(2);
            console.log(`[CHECK-SQLITE] Footprint:            ${q.footprint.totalMb} MB (${pct}% of ${q.limits.hardMb}MB limit)`);
            console.log(`[CHECK-SQLITE] Quota Status:         ${q.status.toUpperCase()}`);
        }
        console.log("------------------------------------------------------------");

        if (!results.ok) {
            process.exitCode = 1;
        }
    } catch (err) {
        console.error(`[CHECK-SQLITE] ❌ FATAL ERROR during check: ${err.message}`);
        process.exitCode = 1;
    } finally {
        if (db) {
            closeDatabase();
        }
    }
}

main().catch(err => {
    console.error("[CHECK-SQLITE] Unhandled rejection:", err);
    process.exit(1);
});
