"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { getFilesystemFreeSpace, getDatabaseFootprint } = require("../maintenance/quota");

const APP_VERSION = (() => {
    try {
        const pkg = require("../../package.json");
        return pkg.version || "5.0.0";
    } catch (_) {
        return "5.0.0";
    }
})();

function calculateChecksum(content) {
    return crypto.createHash("sha256").update(content.trim()).digest("hex");
}

function ensureMigrationTable(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            migration_id TEXT PRIMARY KEY,
            version INTEGER NOT NULL,
            checksum TEXT NOT NULL,
            applied_at INTEGER NOT NULL,
            app_version TEXT NOT NULL
        );
    `);
}

function getAppliedMigrations(db) {
    ensureMigrationTable(db);
    const rows = db.prepare("SELECT migration_id, version, checksum, applied_at FROM schema_migrations ORDER BY version ASC").all();
    const map = new Map();
    for (const row of rows) {
        map.set(row.migration_id, row);
    }
    return map;
}

function loadMigrationFiles(migrationsDir) {
    if (!fs.existsSync(migrationsDir)) {
        return [];
    }
    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith(".sql"))
        .sort();

    return files.map(file => {
        const filePath = path.join(migrationsDir, file);
        const content = fs.readFileSync(filePath, "utf8");
        const match = file.match(/^(\d+)_(.+)\.sql$/);
        const version = match ? parseInt(match[1], 10) : 0;
        return {
            migrationId: file,
            version,
            filePath,
            content,
            checksum: calculateChecksum(content)
        };
    });
}

function isDestructiveMigration(content) {
    if (!content || typeof content !== "string") return false;
    const stripped = content.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    return /\b(DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE)\b/i.test(stripped);
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

function resolvePreMigrationRetention(customRetention = null) {
    if (customRetention !== null && customRetention !== undefined && !isNaN(customRetention)) {
        return parseInt(customRetention, 10);
    }
    const envVal = parseInt(process.env.SQLITE_PRE_MIGRATION_BACKUP_RETENTION, 10);
    return (!isNaN(envVal) && envVal > 0) ? envVal : 1;
}

function rotatePreMigrationBackups(backupDir, maxToKeep = 1) {
    if (!fs.existsSync(backupDir)) return;
    try {
        const files = fs.readdirSync(backupDir)
            .filter(f => f.startsWith("sqlite_backup_pre_migration_") && f.endsWith(".sqlite"))
            .map(f => {
                const p = path.join(backupDir, f);
                const stat = fs.statSync(p);
                return { path: p, mtime: stat.mtimeMs };
            })
            .sort((a, b) => b.mtime - a.mtime);

        if (files.length > maxToKeep) {
            const toDelete = files.slice(maxToKeep);
            for (const item of toDelete) {
                try { fs.unlinkSync(item.path); } catch (_) {}
            }
        }
    } catch (err) {
        console.warn(`[MIGRATION] ⚠️ Failed to rotate pre-migration backups: ${err.message}`);
    }
}

function reconcileUserVersion(db) {
    if (!db) return 0;
    try {
        const row = db.prepare("SELECT MAX(version) as max_version FROM schema_migrations").get();
        const maxVersion = row && row.max_version ? Number(row.max_version) : 0;
        const currentPragma = Number(db.pragma("user_version", { simple: true }) || 0);
        if (maxVersion > currentPragma) {
            db.pragma(`user_version = ${maxVersion}`);
            console.log(`[MIGRATION] 🔄 Reconciled PRAGMA user_version: ${currentPragma} -> ${maxVersion}`);
        }
        return Math.max(maxVersion, currentPragma);
    } catch (_) {
        return 0;
    }
}

function createPreMigrationBackup(db, migrationItem, options = {}) {
    const isMemory = !db.name || db.name === ":memory:";
    if (isMemory && !options.backupDir) {
        return null;
    }

    let backupDir = options.backupDir ? path.resolve(options.backupDir) : null;
    if (!backupDir) {
        // If db is located in a test or scratch directory, isolate backups there
        if (db.name && (db.name.includes("/test/") || db.name.includes("/scratch") || db.name.includes("/temp"))) {
            backupDir = path.join(path.dirname(path.resolve(db.name)), "backups");
        } else {
            backupDir = resolveBackupDir();
        }
    }
    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
    }

    const maxRetention = resolvePreMigrationRetention(options.preMigrationRetention);
    // Rotate older pre-migration copies first to free space before writing
    rotatePreMigrationBackups(backupDir, maxRetention);

    // Space check: ensure sufficient filesystem free space
    if (db.name && db.name !== ":memory:" && fs.existsSync(db.name)) {
        const footprint = getDatabaseFootprint(db.name);
        const requiredBytes = Math.max(footprint.totalBytes * 1.2, 20 * 1024 * 1024);
        const freeSpace = getFilesystemFreeSpace(backupDir);
        if (freeSpace.availableBytes !== null && freeSpace.availableBytes < requiredBytes) {
            const neededMb = (requiredBytes / (1024 * 1024)).toFixed(1);
            const availMb = freeSpace.availableMb;
            throw new Error(`[MIGRATION] พื้นที่ดิสก์ไม่เพียงพอสำหรับการสำรองข้อมูล Pre-migration (ต้องการอย่างน้อย ${neededMb} MB, มีอยู่ ${availMb} MB)`);
        }
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const cleanId = String(migrationItem.migrationId || "migration").replace(/[^a-zA-Z0-9_-]/g, "_");
    const nonce = crypto.randomBytes(4).toString("hex");
    const filename = `sqlite_backup_pre_migration_${cleanId}_${timestamp}_${process.pid}_${nonce}.sqlite`;
    const targetPath = path.join(backupDir, filename);

    // Escape single quotes for SQL string literal
    const escaped = targetPath.replace(/'/g, "''");
    try {
        db.exec(`VACUUM INTO '${escaped}'`);
    } catch (err) {
        throw new Error(`[MIGRATION] Pre-migration safety backup failed before applying destructive migration ${migrationItem.migrationId}: ${err.message}`);
    }

    // Apply pre-migration backup retention rotation (default: 1 set)
    rotatePreMigrationBackups(backupDir, maxRetention);

    return {
        migrationId: migrationItem.migrationId,
        backupPath: targetPath,
        filename,
        createdAt: timestamp
    };
}

function runMigrations(db, options = {}) {
    if (!db) {
        throw new TypeError("runMigrations requires an active database connection");
    }

    const migrationsDir = options.migrationsDir || __dirname;
    ensureMigrationTable(db);
    reconcileUserVersion(db);

    const appliedMap = getAppliedMigrations(db);
    const migrationFiles = loadMigrationFiles(migrationsDir);
    const results = {
        applied: [],
        verified: [],
        preMigrationBackups: [],
        currentVersion: db.pragma("user_version", { simple: true })
    };

    for (const item of migrationFiles) {
        const existing = appliedMap.get(item.migrationId);

        if (existing) {
            // Integrity validation: ensure already applied migration SQL hasn't been modified
            if (existing.checksum !== item.checksum) {
                throw new Error(
                    `[MIGRATION] ❌ Checksum mismatch in already applied migration ${item.migrationId}! ` +
                    `Recorded: ${existing.checksum}, Current: ${item.checksum}. ` +
                    `Migrations are immutable forward-only. Do not edit past migration files.`
                );
            }
            results.verified.push(item.migrationId);
            continue;
        }

        // Pre-migration safety backup guard: if migration contains destructive statements, backup first
        if (isDestructiveMigration(item.content) && !options.skipPreMigrationBackup) {
            const backupInfo = createPreMigrationBackup(db, item, options);
            if (backupInfo) {
                results.preMigrationBackups.push(backupInfo);
            }
        }

        // Apply new migration inside a strict transaction
        const applyTx = db.transaction(() => {
            db.exec(item.content);

            db.prepare(`
                INSERT INTO schema_migrations (migration_id, version, checksum, applied_at, app_version)
                VALUES (?, ?, ?, ?, ?)
            `).run(item.migrationId, item.version, item.checksum, Date.now(), APP_VERSION);
        });

        applyTx();

        // PRAGMA user_version is non-transactional in SQLite; execute only after transaction commits
        db.pragma(`user_version = ${item.version}`);

        results.applied.push(item.migrationId);
        results.currentVersion = item.version;
    }

    reconcileUserVersion(db);
    results.currentVersion = db.pragma("user_version", { simple: true });
    return results;
}

function getPendingMigrations(db, options = {}) {
    const migrationsDir = options.migrationsDir || __dirname;
    ensureMigrationTable(db);
    const appliedMap = getAppliedMigrations(db);
    const migrationFiles = loadMigrationFiles(migrationsDir);
    return migrationFiles.filter(item => !appliedMap.has(item.migrationId));
}

module.exports = {
    runMigrations,
    getAppliedMigrations,
    getPendingMigrations,
    loadMigrationFiles,
    calculateChecksum,
    isDestructiveMigration,
    createPreMigrationBackup,
    rotatePreMigrationBackups,
    resolvePreMigrationRetention,
    reconcileUserVersion
};
