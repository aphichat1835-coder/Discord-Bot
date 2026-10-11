"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const { getFilesystemFreeSpace, getDatabaseFootprint } = require("./quota");

const DEFAULT_MAX_BACKUPS = 2;

function computeFileSha256(filePath) {
    return new Promise((resolve, reject) => {
        try {
            const hash = crypto.createHash("sha256");
            const stream = fs.createReadStream(filePath);
            stream.on("data", chunk => hash.update(chunk));
            stream.on("end", () => resolve(hash.digest("hex")));
            stream.on("error", err => reject(err));
        } catch (err) {
            reject(err);
        }
    });
}

function resolveBackupDir(customDir = null) {
    if (customDir) return path.resolve(customDir);
    if (process.env.SQLITE_BACKUP_DIR && process.env.SQLITE_BACKUP_DIR.trim()) {
        return path.resolve(process.env.SQLITE_BACKUP_DIR.trim());
    }
    // Auto-detection: If host has mounted a writable /persistent volume, use it automatically
    try {
        if (fs.existsSync("/persistent")) {
            fs.accessSync("/persistent", fs.constants.R_OK | fs.constants.W_OK);
            return path.resolve("/persistent", "backups");
        }
    } catch (_) {}
    return path.resolve(process.cwd(), "backups");
}

function listBackups(customDir = null, options = {}) {
    const backupDir = resolveBackupDir(customDir);
    if (!fs.existsSync(backupDir)) return [];

    const includePreMigration = options.includePreMigration || false;

    return fs.readdirSync(backupDir)
        .filter(f => {
            if (!f.startsWith("sqlite_backup_") || !f.endsWith(".sqlite")) return false;
            if (!includePreMigration && f.startsWith("sqlite_backup_pre_migration_")) return false;
            return true;
        })
        .map(f => {
            const p = path.join(backupDir, f);
            const stat = fs.statSync(p);
            return {
                filename: f,
                path: p,
                sizeBytes: stat.size,
                sizeMb: parseFloat((stat.size / (1024 * 1024)).toFixed(2)),
                createdAt: new Date(stat.mtimeMs).toISOString(),
                mtime: stat.mtimeMs
            };
        })
        .sort((a, b) => b.mtime - a.mtime);
}

function listPreMigrationBackups(customDir = null) {
    const backupDir = resolveBackupDir(customDir);
    if (!fs.existsSync(backupDir)) return [];

    return fs.readdirSync(backupDir)
        .filter(f => f.startsWith("sqlite_backup_pre_migration_") && f.endsWith(".sqlite"))
        .map(f => {
            const p = path.join(backupDir, f);
            const stat = fs.statSync(p);
            return {
                filename: f,
                path: p,
                sizeBytes: stat.size,
                sizeMb: parseFloat((stat.size / (1024 * 1024)).toFixed(2)),
                createdAt: new Date(stat.mtimeMs).toISOString(),
                mtime: stat.mtimeMs
            };
        })
        .sort((a, b) => b.mtime - a.mtime);
}

async function createBackup(db, options = {}) {
    if (!db) throw new TypeError("createBackup requires an active database");

    const startTime = Date.now();
    const backupDir = resolveBackupDir(options.backupDir);
    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
    }

    // Safety check: ensure sufficient filesystem free space (including WAL and SHM)
    if (!options.skipSpaceCheck && db.name && fs.existsSync(db.name)) {
        const footprint = getDatabaseFootprint(db.name);
        const requiredBytes = Math.max(footprint.totalBytes * 1.5, 50 * 1024 * 1024); // at least 1.5x total footprint or 50MB
        const freeSpace = getFilesystemFreeSpace(backupDir);

        if (freeSpace.availableBytes !== null && freeSpace.availableBytes < requiredBytes) {
            const neededMb = (requiredBytes / (1024 * 1024)).toFixed(1);
            const availMb = freeSpace.availableMb;
            throw new Error(`พื้นที่ดิสก์คงเหลือไม่เพียงพอสำหรับการสำรองข้อมูล (ต้องการพื้นที่ว่างอย่างน้อย ${neededMb} MB, มีอยู่ ${availMb} MB)`);
        }
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = options.filename || `sqlite_backup_${timestamp}.sqlite`;
    const targetPath = path.join(backupDir, filename);
    const tempPath = path.join(backupDir, `${filename}.tmp`);

    // Clean up any stale temp file
    if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch (_) {}
    }

    // better-sqlite3 provides native online async backup API
    try {
        await db.backup(tempPath);
    } catch (err) {
        if (fs.existsSync(tempPath)) {
            try { fs.unlinkSync(tempPath); } catch (_) {}
        }
        if (fs.existsSync(targetPath)) {
            try { fs.unlinkSync(targetPath); } catch (_) {}
        }
        throw new Error(`การสำรองข้อมูล SQLite ล้มเหลวระหว่างเขียนไฟล์: ${err.message}`);
    }

    // Post-backup verification: verify backup file physically opens and passes quick_check on temp file
    let verifyDb = null;
    let verified = false;
    let quickCheckOutput = null;
    try {
        verifyDb = new Database(tempPath, { readonly: true, fileMustExist: true });
        const checkRows = verifyDb.pragma("quick_check(1)");
        verified = checkRows.length === 1 && (checkRows[0].quick_check === "ok" || checkRows[0] === "ok");
        quickCheckOutput = checkRows;
    } catch (err) {
        verified = false;
        quickCheckOutput = [err.message];
    } finally {
        if (verifyDb) {
            try { verifyDb.close(); } catch (_) {}
        }
    }

    if (!verified) {
        try { fs.unlinkSync(tempPath); } catch (_) {}
        if (fs.existsSync(targetPath)) {
            try { fs.unlinkSync(targetPath); } catch (_) {}
        }
        throw new Error(`ไฟล์สำรองข้อมูลไม่ผ่านการตรวจสอบความสมบูรณ์ (Quick Check Failed): ${JSON.stringify(quickCheckOutput)}`);
    }

    const sha256 = await computeFileSha256(tempPath);

    // Atomically promote temporary backup to targetPath
    fs.renameSync(tempPath, targetPath);

    const stat = fs.statSync(targetPath);

    const durationMs = Date.now() - startTime;

    // Apply rotation to keep storage bounded (default: 2 sets)
    const maxBackups = options.maxBackups || DEFAULT_MAX_BACKUPS;
    rotateBackups(backupDir, maxBackups);

    return {
        ok: true,
        verified: true,
        path: targetPath,
        filename,
        sizeBytes: stat.size,
        sizeMb: parseFloat((stat.size / (1024 * 1024)).toFixed(2)),
        sha256,
        durationMs,
        timestamp
    };
}

function rotateBackups(backupDir, maxToKeep = DEFAULT_MAX_BACKUPS) {
    if (!fs.existsSync(backupDir)) return;
    const backups = listBackups(backupDir);

    if (backups.length > maxToKeep) {
        const toDelete = backups.slice(maxToKeep);
        for (const item of toDelete) {
            try {
                fs.unlinkSync(item.path);
            } catch (_) {}
        }
    }
}

module.exports = {
    createBackup,
    rotateBackups,
    resolveBackupDir,
    listBackups,
    listPreMigrationBackups,
    computeFileSha256,
    DEFAULT_MAX_BACKUPS
};
