#!/usr/bin/env node
"use strict";

const { openDatabase, closeDatabase, resolveDbPath } = require("../../database/sqlite/connection");
const { createBackup, resolveBackupDir } = require("../../database/sqlite/maintenance/backup");

function parseArgs() {
    const args = process.argv.slice(2);
    let customDb = null;
    let customDest = null;
    let maxBackups = 2;

    for (let i = 0; i < args.length; i++) {
        if ((args[i] === "--db" || args[i] === "-d") && args[i + 1]) {
            customDb = args[i + 1];
            i++;
        } else if ((args[i] === "--dest" || args[i] === "-o") && args[i + 1]) {
            customDest = args[i + 1];
            i++;
        } else if (args[i] === "--keep" && args[i + 1]) {
            maxBackups = parseInt(args[i + 1], 10) || 5;
            i++;
        }
    }
    return { customDb, customDest, maxBackups };
}

async function main() {
    console.log("[BACKUP-SQLITE] 📦 Starting SQLite online backup...");
    const { customDb, customDest, maxBackups } = parseArgs();
    const dbPath = resolveDbPath(customDb);
    const backupDir = resolveBackupDir(customDest);

    console.log(`[BACKUP-SQLITE] 📁 Source DB:   ${dbPath}`);
    console.log(`[BACKUP-SQLITE] 📂 Target Dir:  ${backupDir}`);

    let db;
    try {
        db = openDatabase({ path: dbPath });
        const result = await createBackup(db, { backupDir, maxBackups });

        console.log("------------------------------------------------------------");
        console.log(`[BACKUP-SQLITE] Status:    ✅ SUCCESS`);
        console.log(`[BACKUP-SQLITE] File:      ${result.path}`);
        console.log(`[BACKUP-SQLITE] Size:      ${result.sizeMb} MB (${result.sizeBytes} bytes)`);
        console.log(`[BACKUP-SQLITE] Timestamp: ${result.timestamp}`);
        console.log("------------------------------------------------------------");
    } catch (err) {
        console.error(`[BACKUP-SQLITE] ❌ FATAL ERROR during backup: ${err.message}`);
        process.exitCode = 1;
    } finally {
        if (db) {
            closeDatabase();
        }
    }
}

main().catch(err => {
    console.error("[BACKUP-SQLITE] Unhandled rejection:", err);
    process.exit(1);
});
