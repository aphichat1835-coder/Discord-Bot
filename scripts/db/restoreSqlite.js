#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { resolveDbPath, closeDatabase } = require("../../database/sqlite/connection");
const {
    isProcessLockActive,
    acquireRestoreLock,
    releaseRestoreLock
} = require("../../database/sqlite/maintenance/processLock");

function parseArgs() {
    const args = process.argv.slice(2);
    let sourceBackup = null;
    let targetDb = null;
    let force = false;

    for (let i = 0; i < args.length; i++) {
        if ((args[i] === "--source" || args[i] === "-s") && args[i + 1]) {
            sourceBackup = args[i + 1];
            i++;
        } else if ((args[i] === "--target" || args[i] === "-t") && args[i + 1]) {
            targetDb = args[i + 1];
            i++;
        } else if (args[i] === "--force" || args[i] === "-f") {
            force = true;
        } else if (!sourceBackup && !args[i].startsWith("-")) {
            sourceBackup = args[i];
        }
    }
    return { sourceBackup, targetDb, force };
}

function prunePreRestoreBackups(targetPath, maxKeep = 1) {
    try {
        const targetDir = path.dirname(targetPath);
        const baseName = path.basename(targetPath);
        if (!fs.existsSync(targetDir)) return;
        const prefix = `${baseName}.pre-restore-`;
        const files = fs.readdirSync(targetDir)
            .filter(f => f.startsWith(prefix) && f.endsWith(".bak"))
            .map(f => {
                const fullPath = path.join(targetDir, f);
                const stat = fs.statSync(fullPath);
                return { fullPath, mtimeMs: stat.mtimeMs };
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs);

        if (files.length > maxKeep) {
            for (const item of files.slice(maxKeep)) {
                try {
                    fs.unlinkSync(item.fullPath);
                    console.log(`[RESTORE-SQLITE]     Pruned old pre-restore safety backup: ${path.basename(item.fullPath)}`);
                } catch (_) {}
            }
        }
    } catch (err) {
        console.warn(`[RESTORE-SQLITE] ⚠️ Failed to prune old pre-restore backups: ${err.message}`);
    }
}

async function restoreDatabase({ sourceBackup, targetDb, force = false }) {
    console.log("[RESTORE-SQLITE] 🔄 Starting SQLite restore procedure...");

    if (!sourceBackup) {
        throw new Error("Missing required source backup path");
    }

    const sourcePath = path.resolve(sourceBackup);
    const targetPath = resolveDbPath(targetDb);

    console.log(`[RESTORE-SQLITE] 📦 Source Backup: ${sourcePath}`);
    console.log(`[RESTORE-SQLITE] 🎯 Target Path:   ${targetPath}`);

    if (!fs.existsSync(sourcePath)) {
        throw new Error(`Source backup file does not exist: ${sourcePath}`);
    }

    const sourceStat = fs.statSync(sourcePath);
    if (sourceStat.size === 0) {
        throw new Error(`Source backup file is empty (0 bytes): ${sourcePath}`);
    }

    // Step 1: Pre-flight integrity verification on source backup
    console.log("[RESTORE-SQLITE] 1/4 Verifying source backup integrity...");
    let sourceDb;
    try {
        sourceDb = new Database(sourcePath, { readonly: true, fileMustExist: true });
        const integrity = sourceDb.pragma("integrity_check");
        const ok = integrity.length === 1 && (integrity[0].integrity_check === "ok" || integrity[0] === "ok");
        if (!ok) {
            throw new Error(`Integrity check failed: ${JSON.stringify(integrity)}`);
        }
        const userVersion = sourceDb.pragma("user_version", { simple: true });
        console.log(`[RESTORE-SQLITE]     Source verified intact (PRAGMA user_version = ${userVersion}).`);
    } finally {
        if (sourceDb) {
            try { sourceDb.close(); } catch (_) {}
        }
    }

    // Safety Gate: Refuse restore if Bot process is actively running. --force CANNOT bypass active live process!
    const activeLock = isProcessLockActive(targetPath);
    if (activeLock.active && activeLock.pid !== process.pid) {
        throw new Error(
            `[FATAL] Active bot process detected holding SQLite lock (PID: ${activeLock.pid}). ` +
            `Refusing to restore while database is actively running in another process. ` +
            `You MUST stop the bot process first before restoring (kill -TERM ${activeLock.pid} or stop the bot). ` +
            `--force does not allow bypassing an active running bot process.`
        );
    }

    const rLock = acquireRestoreLock(targetPath);
    if (!rLock.acquired) {
        if (!force) {
            throw new Error(
                `Another restore process lock is currently held on target database (PID: ${rLock.pid}). ` +
                `Refusing concurrent restore. If this is a stale lock from a crashed process, specify --force to override.`
            );
        }
        console.warn(`[RESTORE-SQLITE] ⚠️ FORCE flag active: overriding previous restore lock (PID: ${rLock.pid}).`);
    }
    try {
        // Step 2: Ensure connection is closed and backup existing target
        console.log("[RESTORE-SQLITE] 2/4 Securing current target database...");
        closeDatabase();

        const targetDir = path.dirname(targetPath);
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        let rollbackBakPath = null;
        if (fs.existsSync(targetPath)) {
            prunePreRestoreBackups(targetPath, 0);
            const targetStat = fs.statSync(targetPath);
            const { getFilesystemFreeSpace } = require("../../database/sqlite/maintenance/quota");
            const freeSpace = getFilesystemFreeSpace(targetDir);
            const requiredBytes = Math.max(targetStat.size * 1.2, 20 * 1024 * 1024);
            if (freeSpace.availableBytes !== null && freeSpace.availableBytes < requiredBytes) {
                const neededMb = (requiredBytes / (1024 * 1024)).toFixed(1);
                const availMb = freeSpace.availableMb;
                throw new Error(`[RESTORE-SQLITE] พื้นที่ดิสก์ไม่เพียงพอสำหรับ Pre-restore safety backup (ต้องการอย่างน้อย ${neededMb} MB, มีอยู่ ${availMb} MB)`);
            }

            rollbackBakPath = `${targetPath}.pre-restore-${Date.now()}.bak`;
            fs.copyFileSync(targetPath, rollbackBakPath);
            console.log(`[RESTORE-SQLITE]     Pre-restore safety backup created: ${rollbackBakPath}`);
            prunePreRestoreBackups(targetPath, 1);

            // Clean stale WAL, SHM, and journal files to prevent WAL/rollback corruption
            const walPath = `${targetPath}-wal`;
            const shmPath = `${targetPath}-shm`;
            const journalPath = `${targetPath}-journal`;
            if (fs.existsSync(walPath)) try { fs.unlinkSync(walPath); } catch (_) {}
            if (fs.existsSync(shmPath)) try { fs.unlinkSync(shmPath); } catch (_) {}
            if (fs.existsSync(journalPath)) try { fs.unlinkSync(journalPath); } catch (_) {}
        }

        // Step 3: Copy source backup to temporary staging file & verify before atomic replace
        console.log("[RESTORE-SQLITE] 3/4 Copying backup to staging file & verifying integrity...");
        const stagingPath = `${targetPath}.restore-staging-${Date.now()}.tmp`;
        try {
            fs.copyFileSync(sourcePath, stagingPath);

            // Verify staging file integrity
            const stagingDb = new Database(stagingPath, { readonly: true, fileMustExist: true });
            try {
                const sInt = stagingDb.pragma("integrity_check");
                const sOk = sInt.length === 1 && (sInt[0].integrity_check === "ok" || sInt[0] === "ok");
                if (!sOk) {
                    throw new Error(`Staged backup integrity check failed: ${JSON.stringify(sInt)}`);
                }
            } finally {
                stagingDb.close();
            }

            // Remove target auxiliary files before replace
            const walPath = `${targetPath}-wal`;
            const shmPath = `${targetPath}-shm`;
            const journalPath = `${targetPath}-journal`;
            if (fs.existsSync(walPath)) try { fs.unlinkSync(walPath); } catch (_) {}
            if (fs.existsSync(shmPath)) try { fs.unlinkSync(shmPath); } catch (_) {}
            if (fs.existsSync(journalPath)) try { fs.unlinkSync(journalPath); } catch (_) {}

            // Atomic replace
            fs.renameSync(stagingPath, targetPath);
        } catch (copyErr) {
            console.error(`[RESTORE-SQLITE] ❌ Staging copy or atomic replace failed: ${copyErr.message}`);
            if (fs.existsSync(stagingPath)) {
                try { fs.unlinkSync(stagingPath); } catch (_) {}
            }
            if (rollbackBakPath && fs.existsSync(rollbackBakPath)) {
                console.warn(`[RESTORE-SQLITE] ⚠️ Copy/Staging failure detected. Initiating immediate auto-rollback from ${rollbackBakPath}...`);
                try {
                    fs.copyFileSync(rollbackBakPath, targetPath);
                    const walPath = `${targetPath}-wal`;
                    const shmPath = `${targetPath}-shm`;
                    const journalPath = `${targetPath}-journal`;
                    if (fs.existsSync(walPath)) try { fs.unlinkSync(walPath); } catch (_) {}
                    if (fs.existsSync(shmPath)) try { fs.unlinkSync(shmPath); } catch (_) {}
                    if (fs.existsSync(journalPath)) try { fs.unlinkSync(journalPath); } catch (_) {}
                    console.log("[RESTORE-SQLITE] 🔄 Immediate auto-rollback completed successfully.");
                } catch (rbErr) {
                    console.error(`[RESTORE-SQLITE] 🚨 Immediate auto-rollback failed: ${rbErr.message}`);
                }
            }
            throw copyErr;
        }

        // Step 4: Post-flight integrity verification on restored target
        console.log("[RESTORE-SQLITE] 4/4 Verifying restored database integrity...");
        let targetCheckDb;
        try {
            targetCheckDb = new Database(targetPath, { readonly: true, fileMustExist: true });
            const integrity = targetCheckDb.pragma("integrity_check");
            const ok = integrity.length === 1 && (integrity[0].integrity_check === "ok" || integrity[0] === "ok");
            if (!ok) {
                throw new Error(`Target integrity check failed: ${JSON.stringify(integrity)}`);
            }
            console.log("[RESTORE-SQLITE]     Target verified intact.");
        } catch (err) {
            console.error(`[RESTORE-SQLITE] ❌ Restored target verification failed: ${err.message}`);
            if (targetCheckDb) {
                try { targetCheckDb.close(); } catch (_) {}
                targetCheckDb = null;
            }

            if (rollbackBakPath && fs.existsSync(rollbackBakPath)) {
                console.warn(`[RESTORE-SQLITE] ⚠️ Auto-rollback initiated: restoring from safety backup ${rollbackBakPath}...`);
                try {
                    fs.copyFileSync(rollbackBakPath, targetPath);
                    const walPath = `${targetPath}-wal`;
                    const shmPath = `${targetPath}-shm`;
                    const journalPath = `${targetPath}-journal`;
                    if (fs.existsSync(walPath)) try { fs.unlinkSync(walPath); } catch (_) {}
                    if (fs.existsSync(shmPath)) try { fs.unlinkSync(shmPath); } catch (_) {}
                    if (fs.existsSync(journalPath)) try { fs.unlinkSync(journalPath); } catch (_) {}
                    console.log("[RESTORE-SQLITE] 🔄 Auto-rollback completed successfully. Original database state restored.");
                } catch (rbErr) {
                    console.error(`[RESTORE-SQLITE] 🚨 Auto-rollback failed: ${rbErr.message}`);
                }
            }
            throw err;
        } finally {
            if (targetCheckDb) {
                try { targetCheckDb.close(); } catch (_) {}
            }
        }

        console.log("------------------------------------------------------------");
        console.log("[RESTORE-SQLITE] ✅ Database restored successfully!");
        console.log(`[RESTORE-SQLITE] Target: ${targetPath}`);
        console.log("------------------------------------------------------------");

        return {
            ok: true,
            sourcePath,
            targetPath,
            rollbackBakPath
        };
    } finally {
        releaseRestoreLock(targetPath);
    }
}

async function main() {
    const { sourceBackup, targetDb, force } = parseArgs();
    if (!sourceBackup) {
        console.error("❌ Usage: node scripts/db/restoreSqlite.js --source <backup_file.sqlite> [--target <target_db.sqlite>] [--force]");
        process.exit(1);
    }

    try {
        await restoreDatabase({ sourceBackup, targetDb, force });
    } catch (err) {
        console.error(`[RESTORE-SQLITE] ❌ Restore failed: ${err.message}`);
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error("[RESTORE-SQLITE] Unhandled rejection:", err);
        process.exit(1);
    });
}

module.exports = {
    parseArgs,
    prunePreRestoreBackups,
    restoreDatabase
};

