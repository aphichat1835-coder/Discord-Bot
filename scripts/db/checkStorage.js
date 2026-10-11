"use strict";

const { evaluateStoragePaths } = require("../../database/sqlite/maintenance/storageCheck");

function runStorageCli() {
    console.log("[CHECK-STORAGE] 🔍 Starting Production Storage & Volume Mount Probe...");
    console.log(`[CHECK-STORAGE] Mode:               ${process.env.NODE_ENV || "development"}`);

    const res = evaluateStoragePaths();

    console.log("------------------------------------------------------------");
    console.log(`[CHECK-STORAGE] Database Path:      ${res.paths.database.path}`);
    console.log(`                Outside Source:     ${res.paths.database.inSource ? "❌ Inside Source Tree" : "✅ Isolated External"}`);
    console.log(`                Permissions:        ${res.permissions.database?.writable ? "✅ R/W Verified" : "❌ Denied"}`);
    console.log("------------------------------------------------------------");
    console.log(`[CHECK-STORAGE] Backup Path:        ${res.paths.backup.path}`);
    console.log(`                Outside Source:     ${res.paths.backup.inSource ? "❌ Inside Source Tree" : "✅ Isolated External"}`);
    console.log(`                Permissions:        ${res.permissions.backup?.writable ? "✅ R/W Verified" : "❌ Denied"}`);
    console.log("------------------------------------------------------------");
    console.log(`[CHECK-STORAGE] Asset Cache Path:   ${res.paths.assetCache.path}`);
    console.log(`                Outside Source:     ${res.paths.assetCache.inSource ? "❌ Inside Source Tree" : "✅ Isolated External"}`);
    console.log(`                Permissions:        ${res.permissions.assetCache?.writable ? "✅ R/W Verified" : "❌ Denied"}`);
    console.log("------------------------------------------------------------");
    if (res.freeSpace?.availableMb !== null && res.freeSpace?.availableMb !== undefined) {
        console.log(`[CHECK-STORAGE] Free Disk Space:    ${res.freeSpace.availableMb} MB available (${res.freeSpace.percentFree}% free)`);
    }

    if (res.warnings.length > 0) {
        console.log("------------------------------------------------------------");
        console.log("⚠️ Warnings:");
        res.warnings.forEach(w => console.log(`   ${w}`));
    }

    if (res.errors.length > 0) {
        console.log("------------------------------------------------------------");
        console.log("❌ Errors:");
        res.errors.forEach(e => console.log(`   ${e}`));
        console.log("------------------------------------------------------------");
        console.log("[CHECK-STORAGE] Result:             ❌ FAILED PRE-FLIGHT CHECK");
        process.exit(1);
    }

    console.log("------------------------------------------------------------");
    console.log("[CHECK-STORAGE] Result:             ✅ PASSED PRE-FLIGHT CHECK");
    process.exit(0);
}

if (require.main === module) {
    runStorageCli();
}

module.exports = { runStorageCli };
