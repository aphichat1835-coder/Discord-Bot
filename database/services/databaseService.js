"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { getDatabase, getCurrentDbPath, resolveDbPath } = require("../sqlite/connection");
const { evaluateQuota, getDatabaseFootprint, getFilesystemFreeSpace, evaluateEmergencyThresholds, canSendAlert, recordAlertSent } = require("../sqlite/maintenance/quota");
const { runBoundedCleanup } = require("../sqlite/maintenance/cleanup");
const { runIncrementalVacuum, checkpointWal } = require("../sqlite/maintenance/vacuum");
const { createBackup, listBackups } = require("../sqlite/maintenance/backup");
const { runStartupCheck } = require("../sqlite/maintenance/startupCheck");
const { evaluateStoragePaths } = require("../sqlite/maintenance/storageCheck");
const { executeEmergencyTrim } = require("../sqlite/maintenance/emergencyTrim");
const { TABLE_CATEGORIES, getCategoryForTable } = require("../sqlite/tableCategories");
const { getAssetCacheManager } = require("../sqlite/cache/assetCacheManager");
const { sendWebhookEvent } = require("../../discord/core/webhooks");
const mongo = require("../mongo/index");

// ════════════════════════════════════════════════════════════════════════════
//  🛡️ ALLOWLISTS & CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

const CONSOLE_COMMANDS = Object.freeze([
    "status",
    "health",
    "stats",
    "tables",
    "migrations",
    "integrity",
    "cleanup",
    "cleanup cache",
    "cleanup history",
    "checkpoint",
    "vacuum",
    "backup",
    "emergency-trim",
    "full-check"
]);

const ALLOWED_MONGO_COLLECTIONS = Object.freeze([
    "GuildConfig",
    "VerifyLog",
    "OAuthUser",
    "OAuthMemberSnapshot",
    "OAuthMemberRoleSnapshot",
    "OAuthUserProfileSnapshot",
    "OAuthUserGuildSnapshot",
    "OAuthUserConnectionSnapshot",
    "OAuthObjectChunkSnapshot",
    "OAuthSnapshotRecovery",
    "IpIdentityLink",
    "IpIdentityUserHistory",
    "IpIdentityDeviceHistory",
    "IpIdentityRoleHistory",
    "PrivacyDeletionJob",
    "VerificationMigrationArchive",
    "VerificationMigrationState"
]);

// ════════════════════════════════════════════════════════════════════════════
//  📊 1. OVERVIEW & HEALTH
// ════════════════════════════════════════════════════════════════════════════

async function getDatabaseOverview() {
    const startTime = Date.now();
    const dbPath = getCurrentDbPath() || resolveDbPath();
    const db = getDatabase();

    // 1. SQLite Status & Quota + Filesystem Health Aggregation
    const quota = evaluateQuota(dbPath);
    const storage = evaluateStoragePaths({ dbPath });
    const emergency = evaluateEmergencyThresholds(dbPath);

    let sqliteHealth = "ok"; // 'ok' | 'check' | 'warning' | 'error'
    let sqliteStatusLabel = "🟢 ปกติ";
    let degradedReason = quota.degradedReason;

    if (storage.filesystemCritical || emergency.isEmergency || quota.status === "hard") {
        sqliteHealth = "error";
        sqliteStatusLabel = "🔴 มีปัญหา (Critical / Disk)";
        if (storage.filesystemCritical) {
            degradedReason = storage.errors[0] || "พื้นที่จัดเก็บข้อมูลบนดิสก์วิกฤต หรือไม่สามารถเขียนไฟล์ได้";
        }
    } else if (storage.filesystemWarning || quota.status === "critical") {
        sqliteHealth = "warning";
        sqliteStatusLabel = "🟠 ใกล้ถึงขีดจำกัด";
        if (storage.filesystemWarning) {
            degradedReason = storage.warnings[0] || degradedReason;
        }
    } else if (quota.status === "soft") {
        sqliteHealth = "check";
        sqliteStatusLabel = "🟡 ควรตรวจสอบ";
    }

    // 2. Table counts & record totals dynamically classified via central category map
    let totalRecords = 0;
    let coreCount = 0;
    let cacheCount = 0;
    let historyCount = 0;
    let tempCount = 0;

    try {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(t => t.name);
        for (const tbl of tables) {
            let cnt = 0;
            try {
                const r = db.prepare(`SELECT COUNT(*) AS c FROM "${tbl}"`).get();
                cnt = r ? r.c : 0;
            } catch (_) {}
            totalRecords += cnt;
            const category = getCategoryForTable(tbl);
            if (category === "core") coreCount += cnt;
            else if (category === "cache") cacheCount += cnt;
            else if (category === "history") historyCount += cnt;
            else tempCount += cnt;
        }
    } catch (_) {}

    // 3. Maintenance metadata
    const metaMap = {};
    try {
        const metaRows = db.prepare("SELECT key, value FROM database_meta").all();
        for (const r of metaRows) metaMap[r.key] = r.value;
    } catch (_) {}

    // 4. Backups list & managed storage breakdown (DB, Backups, Assets, Free Disk, Total Managed)
    const backups = listBackups();
    const lastBackupInfo = backups.length > 0 ? backups[0] : null;

    const allBackups = listBackups(null, { includePreMigration: true });
    let backupBytes = allBackups.reduce((sum, b) => sum + (b.sizeBytes || 0), 0);
    try {
        const dbDir = path.dirname(dbPath);
        if (fs.existsSync(dbDir)) {
            const baks = fs.readdirSync(dbDir).filter(f => f.endsWith(".bak"));
            for (const f of baks) {
                const stat = fs.statSync(path.join(dbDir, f));
                backupBytes += stat.size;
            }
        }
    } catch (_) {}

    let assetBytes = 0;
    try {
        const assetMgr = getAssetCacheManager(db);
        const assetStats = assetMgr.getStats();
        assetBytes = assetStats.totalBytes || assetStats.totalSizeBytes || 0;
    } catch (_) {}

    const dbBytes = quota.footprint.totalBytes || 0;
    const totalManagedBytes = dbBytes + backupBytes + assetBytes;

    const managedStorage = {
        databaseBytes: dbBytes,
        databaseMb: parseFloat((dbBytes / (1024 * 1024)).toFixed(2)),
        backupBytes,
        backupMb: parseFloat((backupBytes / (1024 * 1024)).toFixed(2)),
        assetBytes,
        assetMb: parseFloat((assetBytes / (1024 * 1024)).toFixed(2)),
        totalManagedBytes,
        totalManagedMb: parseFloat((totalManagedBytes / (1024 * 1024)).toFixed(2)),
        freeDiskBytes: storage.freeSpace?.availableBytes ?? null,
        freeDiskMb: storage.freeSpace?.availableMb ?? null
    };

    // 5. MongoDB Overview
    const mongoStatus = mongo.getMongoStatus();
    let mongoPingMs = null;
    let mongoHealthLabel = mongoStatus.connected ? "🟢 ปกติ" : "🔴 ขาดการเชื่อมต่อ";

    if (mongoStatus.connected && mongo.mongoose.connection.db) {
        try {
            const pStart = Date.now();
            await mongo.mongoose.connection.db.command({ ping: 1 });
            mongoPingMs = Date.now() - pStart;
        } catch (_) {
            mongoHealthLabel = "🟡 ช้า/มีปัญหา";
        }
    }

    return {
        timestamp: Date.now(),
        durationMs: Date.now() - startTime,
        databases: {
            sqlite: {
                status: sqliteHealth,
                statusLabel: sqliteStatusLabel,
                path: dbPath,
                footprintMb: quota.footprint.totalMb,
                hardLimitMb: quota.limits.hardMb,
                usedPercent: parseFloat(((quota.footprint.totalMb / quota.limits.hardMb) * 100).toFixed(1)),
                degradedReason,
                storage: {
                    freeSpaceMb: storage.freeSpace?.availableMb ?? null,
                    percentFree: storage.freeSpace?.percentFree ?? null,
                    filesystemCritical: storage.filesystemCritical,
                    filesystemWarning: storage.filesystemWarning,
                    isPersistent: storage.isPersistent,
                    configuredPersistentPath: storage.configuredPersistentPath,
                    persistentMountVerified: storage.persistentMountVerified,
                    allowInSource: storage.allowInSource,
                    persistentLabel: storage.persistentMountVerified
                        ? "✅ Owner-Confirmed Persistent Path"
                        : storage.configuredPersistentPath
                            ? "🟡 Persistent Path Configured (Mount Unverified)"
                            : storage.allowInSource
                                ? "ℹ️ Owner-Permitted In-Source Storage"
                                : "❌ Ephemeral / In-Source",
                    managedStorage
                },
                records: {
                    total: totalRecords,
                    core: coreCount,
                    cache: cacheCount,
                    history: historyCount,
                    temp: tempCount
                },
                lastMaintenance: {
                    lastCleanup: metaMap.last_cleanup || null,
                    lastBackup: lastBackupInfo?.createdAt || metaMap.last_backup || null,
                    lastIntegrityCheck: metaMap.last_integrity_check || null,
                    lastCheckpoint: metaMap.last_checkpoint || null
                }
            },
            mongodb: {
                status: mongoStatus.connected ? "ok" : "error",
                statusLabel: mongoHealthLabel,
                connected: mongoStatus.connected,
                pingMs: mongoPingMs,
                name: mongoStatus.name,
                modelsCount: mongoStatus.models,
                pool: mongoStatus.pool
            }
        }
    };
}

// ════════════════════════════════════════════════════════════════════════════
//  🗄️ 2. SQLITE DETAILED STATUS & CATEGORIES
// ════════════════════════════════════════════════════════════════════════════

async function getSqliteDetailedStatus() {
    const dbPath = getCurrentDbPath() || resolveDbPath();
    const db = getDatabase();
    const quota = evaluateQuota(dbPath);
    const storageCheck = evaluateStoragePaths({ dbPath });

    // Pragmas
    const journalMode = db.pragma("journal_mode", { simple: true });
    const userVersion = db.pragma("user_version", { simple: true });
    const foreignKeys = db.pragma("foreign_keys", { simple: true });
    const synchronous = db.pragma("synchronous", { simple: true });

    // Table Detailed Row Counts & Disk Page Bytes
    const tableCounts = {};
    const tableBytes = {};
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(t => t.name);

    for (const tbl of tables) {
        try {
            const r = db.prepare(`SELECT COUNT(*) AS c FROM "${tbl}"`).get();
            tableCounts[tbl] = r ? r.c : 0;
        } catch (_) {
            tableCounts[tbl] = 0;
        }
    }

    try {
        const dbstatRows = db.prepare("SELECT name, SUM(pgsize) AS b FROM dbstat GROUP BY name").all();
        for (const row of dbstatRows) {
            tableBytes[row.name] = Number(row.b) || 0;
        }
    } catch (_) {}

    const buildTableMeta = (name, label) => {
        const count = tableCounts[name] || 0;
        const bytes = tableBytes[name] || 0;
        return {
            count,
            bytes,
            sizeMb: parseFloat((bytes / (1024 * 1024)).toFixed(2)),
            label
        };
    };

    const sumCategory = (tablesMap) => {
        let count = 0;
        let bytes = 0;
        for (const meta of Object.values(tablesMap)) {
            count += meta.count || 0;
            bytes += meta.bytes || 0;
        }
        return {
            count,
            bytes,
            sizeMb: parseFloat((bytes / (1024 * 1024)).toFixed(2))
        };
    };

    // Build categories dynamically from central TABLE_CATEGORIES to ensure 100% architectural alignment
    const categories = {};
    for (const catDef of Object.values(TABLE_CATEGORIES)) {
        const catKey = catDef.key;
        const tablesObj = {};
        for (const [tblName, tblLabel] of Object.entries(catDef.tables)) {
            tablesObj[tblName] = buildTableMeta(tblName, tblLabel);
        }
        const agg = sumCategory(tablesObj);
        categories[catKey] = {
            label: catDef.label,
            count: agg.count,
            bytes: agg.bytes,
            sizeMb: agg.sizeMb,
            tables: tablesObj
        };
    }

    // Maintenance runs log (last 5)
    let maintenanceHistory = [];
    try {
        const rows = db.prepare(`
            SELECT id, run_type, started_at, finished_at, status, details_json
            FROM maintenance_runs
            ORDER BY id DESC LIMIT 5
        `).all();
        maintenanceHistory = rows.map(r => {
            let parsed = null;
            try {
                parsed = r.details_json ? JSON.parse(r.details_json) : null;
            } catch (_) {}
            return {
                id: r.id,
                type: r.run_type,
                run_type: r.run_type,
                actor: parsed?.actor || "system",
                status: r.status,
                details: parsed?.metadata || parsed,
                error: parsed?.error || null,
                started_at: r.started_at,
                completed_at: r.finished_at,
                finished_at: r.finished_at,
                duration_ms: (r.finished_at && r.started_at) ? (r.finished_at - r.started_at) : 0
            };
        });
    } catch (_) {}

    // Backups
    const backups = listBackups();
    // Managed storage breakdown
    const allBackups = listBackups(null, { includePreMigration: true });
    let backupBytes = allBackups.reduce((sum, b) => sum + (b.sizeBytes || 0), 0);
    try {
        const dbDir = path.dirname(dbPath);
        if (fs.existsSync(dbDir)) {
            const baks = fs.readdirSync(dbDir).filter(f => f.endsWith(".bak"));
            for (const f of baks) {
                const stat = fs.statSync(path.join(dbDir, f));
                backupBytes += stat.size;
            }
        }
    } catch (_) {}

    let assetBytes = 0;
    try {
        const assetMgr = getAssetCacheManager(db);
        const assetStats = assetMgr.getStats();
        assetBytes = assetStats.totalBytes || assetStats.totalSizeBytes || 0;
    } catch (_) {}

    const dbBytes = quota.footprint.totalBytes || 0;
    const totalManagedBytes = dbBytes + backupBytes + assetBytes;

    const managedStorage = {
        databaseBytes: dbBytes,
        databaseMb: parseFloat((dbBytes / (1024 * 1024)).toFixed(2)),
        backupBytes,
        backupMb: parseFloat((backupBytes / (1024 * 1024)).toFixed(2)),
        assetBytes,
        assetMb: parseFloat((assetBytes / (1024 * 1024)).toFixed(2)),
        totalManagedBytes,
        totalManagedMb: parseFloat((totalManagedBytes / (1024 * 1024)).toFixed(2)),
        freeDiskBytes: storageCheck.freeSpace?.availableBytes ?? null,
        freeDiskMb: storageCheck.freeSpace?.availableMb ?? null
    };

    return {
        path: dbPath,
        open: db.open,
        pragmas: {
            journalMode,
            userVersion,
            foreignKeys: foreignKeys === 1,
            synchronous
        },
        quota,
        storage: {
            mainBytes: quota.footprint.mainBytes,
            walBytes: quota.footprint.walBytes,
            shmBytes: quota.footprint.shmBytes,
            totalMb: quota.footprint.totalMb,
            limits: quota.limits,
            filesystem: quota.filesystem,
            volumes: storageCheck.volumes,
            isPersistent: storageCheck.isPersistent,
            configuredPersistentPath: storageCheck.configuredPersistentPath,
            persistentMountVerified: storageCheck.persistentMountVerified,
            pathWarning: storageCheck.pathWarning,
            allowInSource: storageCheck.allowInSource,
            persistentLabel: storageCheck.persistentMountVerified
                ? "✅ Owner-Confirmed Persistent Path"
                : storageCheck.configuredPersistentPath
                    ? "🟡 Persistent Path Configured (Mount Unverified)"
                    : storageCheck.allowInSource
                        ? "ℹ️ Owner-Permitted In-Source Storage"
                        : "❌ Ephemeral / In-Source",
            managedStorage
        },
        categories,
        maintenanceHistory,
        backups
    };
}

// ════════════════════════════════════════════════════════════════════════════
//  ⚡ 3. SQLITE MAINTENANCE ACTIONS & AUDIT
// ════════════════════════════════════════════════════════════════════════════

function notifyIntegrityCorrupted(intRows, fkRows, dbPath = null) {
    if (!canSendAlert("sqlite_integrity_corrupted")) return;
    recordAlertSent("sqlite_integrity_corrupted");
    try {
        sendWebhookEvent({
            target: "ALERT",
            severity: "CRITICAL",
            category: "DATA",
            code: "sqlite.integrity.corrupted",
            title: "🚨 ตรวจพบความเสียหายในไฟล์ฐานข้อมูล SQLite (Integrity Corrupted)",
            description: "ระบบตรวจพบความเสียหายของโครงสร้าง B-Tree หรือ Foreign Key ในไฟล์ SQLite Database ระหว่างการตรวจสอบ Integrity Check",
            context: {
                "Integrity Status": Array.isArray(intRows) ? JSON.stringify(intRows).slice(0, 500) : String(intRows),
                "Foreign Key Errors": fkRows && fkRows.length > 0 ? JSON.stringify(fkRows).slice(0, 500) : "None",
                "ไฟล์ฐานข้อมูล": dbPath || getCurrentDbPath() || resolveDbPath(),
                "เวลาที่เกิด": new Date().toISOString()
            }
        }).catch(() => {});
    } catch (_) {}
}

function recordMaintenanceAudit(db, {
    action = "maintenance",
    actor = "owner",
    invoker = null,
    startTime = Date.now(),
    finishedAt = Date.now(),
    status = "success",
    details = {},
    metadata = null,
    error = null,
    target = "sqlite",
    durationMs = null
} = {}) {
    const resolvedActor = actor || invoker || "owner";
    const duration = durationMs !== null ? durationMs : (finishedAt - startTime);
    const auditPayload = {
        actor: resolvedActor,
        action,
        target: target || "sqlite",
        status,
        durationMs: duration,
        error: error ? (error.message || String(error)) : (details?.error || null),
        metadata: metadata || details || {}
    };

    try {
        if (!db || typeof db.prepare !== "function") {
            throw new Error("Invalid or uninitialized database connection");
        }
        db.prepare(`
            INSERT INTO maintenance_runs (run_type, started_at, finished_at, status, details_json)
            VALUES (?, ?, ?, ?, ?)
        `).run(action, startTime, finishedAt, status, JSON.stringify(auditPayload));
        return { ok: true, audit: auditPayload };
    } catch (auditErr) {
        console.warn(`[DATABASE_AUDIT] ⚠️ Failed to persist maintenance audit for action "${action}": ${auditErr.message}`);
        try {
            sendWebhookEvent({
                target: "ALERT",
                severity: "WARNING",
                category: "DATA",
                code: "database.audit.write_failed",
                title: "⚠️ บันทึก Audit Log ฐานข้อมูลไม่สำเร็จ",
                description: `ไม่สามารถบันทึกประวัติการบำรุงรักษาลงตาราง maintenance_runs ได้:\n• Action: ${action}\n• Actor: ${resolvedActor}\n• Error: ${auditErr.message}`,
                context: {
                    "Action": action,
                    "Actor": resolvedActor,
                    "Audit Error": auditErr.message,
                    "Status": status
                }
            }).catch(() => {});
        } catch (_) {}
        return { ok: false, error: auditErr.message };
    }
}

async function executeSqliteAction(action, options = {}, invoker = "owner") {
    const db = getDatabase();
    const startTime = Date.now();
    let result = { ok: false, action, message: "" };

    const recordAudit = (status, details, error = null) => {
        return recordMaintenanceAudit(db, {
            action,
            invoker,
            startTime,
            finishedAt: Date.now(),
            status,
            details,
            error,
            target: options?.target || "sqlite"
        });
    };

    try {
        switch (action) {
            case "check": {
                const probe = runStartupCheck(db, { dbPath: getCurrentDbPath() });
                result = { ok: probe.ok, action, probe, message: "ตรวจสอบความสมบูรณ์สำเร็จ" };
                db.prepare("INSERT OR REPLACE INTO database_meta (key, value, updated_at) VALUES ('last_health_check', ?, ?)")
                    .run(new Date().toISOString(), Date.now());
                recordAudit("success", result);
                break;
            }

            case "integrity": {
                const intRows = db.pragma("integrity_check");
                const fkRows = db.pragma("foreign_key_check");
                const passed = intRows.length === 1 && (intRows[0].integrity_check === "ok" || intRows[0] === "ok") && fkRows.length === 0;
                result = {
                    ok: passed,
                    action,
                    integrity: intRows,
                    foreignKeyErrors: fkRows,
                    message: passed ? "ตรวจสอบ Integrity ผ่าน 100%" : "พบข้อผิดพลาดใน Integrity"
                };
                if (!passed) {
                    notifyIntegrityCorrupted(intRows, fkRows);
                }
                db.prepare("INSERT OR REPLACE INTO database_meta (key, value, updated_at) VALUES ('last_integrity_check', ?, ?)")
                    .run(new Date().toISOString(), Date.now());
                recordAudit(passed ? "success" : "failure", result);
                break;
            }

            case "cleanup_expired":
            case "cleanup_all": {
                const stats = runBoundedCleanup(db, { maxBatches: options.maxBatches || 5 });
                result = { ok: true, action, stats, message: `ทำความสะอาดข้อมูลสำเร็จ ลบ ${stats.totalDeleted || stats.deletedRows || 0} รายการ` };
                db.prepare("INSERT OR REPLACE INTO database_meta (key, value, updated_at) VALUES ('last_cleanup', ?, ?)")
                    .run(new Date().toISOString(), Date.now());
                recordAudit("success", result);
                break;
            }

            case "cleanup_cache": {
                let cacheDelCount = 0;
                let assetCount = 0;
                let assetError = null;

                try {
                    const del = db.prepare("DELETE FROM cache_entries").run();
                    cacheDelCount = del.changes || 0;
                } catch (cErr) {
                    console.error(`[DATABASE_SERVICE] ❌ Failed to clear cache_entries: ${cErr.message}`);
                }

                try {
                    const { getAssetCacheManager } = require("../sqlite/cache/assetCacheManager");
                    const assetMgr = getAssetCacheManager(db);
                    const allAssets = db.prepare("SELECT asset_key FROM asset_cache").all();
                    for (const a of allAssets) {
                        if (assetMgr.deleteAsset(a.asset_key)) {
                            assetCount++;
                        }
                    }
                    assetMgr.reconcileOrphans();
                } catch (err) {
                    assetError = err.message;
                    console.warn(`[DATABASE_SERVICE] ⚠️ Asset Cache Manager cleanup failed: ${err.message}. Retaining metadata to prevent orphaned disk files.`);
                }

                if (assetError) {
                    result = {
                        ok: false,
                        action,
                        deletedRows: cacheDelCount,
                        assetError,
                        message: `ล้างแคชข้อความสำเร็จ (${cacheDelCount} รายการ) แต่การล้าง Asset Cache ล้มเหลว: ${assetError} (รักษารายการ Metadata ไว้เพื่อป้องกันไฟล์ขยะตกค้าง)`
                    };
                    recordAudit("failure", result, new Error(assetError));
                } else {
                    const total = cacheDelCount + assetCount;
                    result = {
                        ok: true,
                        action,
                        deletedRows: total,
                        message: `ล้างแคชสำเร็จ ลบทั้งหมด ${total} รายการ (รวมไฟล์ Assets บนดิสก์)`
                    };
                    recordAudit("success", result);
                }
                break;
            }

            case "cleanup_history": {
                const days = parseInt(process.env.SQLITE_HISTORY_RETENTION_DAYS, 10);
                const retentionDays = (!isNaN(days) && days > 0) ? days : 30;
                const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
                const batchSize = 1000;

                const batchDelete = (table) => {
                    let deleted = 0;
                    const stmt = db.prepare(`
                        DELETE FROM ${table}
                        WHERE id IN (
                            SELECT id FROM ${table}
                            WHERE occurred_at < ?
                            LIMIT ?
                        )
                    `);
                    while (true) {
                        const info = stmt.run(cutoff, batchSize);
                        deleted += info.changes;
                        if (info.changes < batchSize) break;
                    }
                    return deleted;
                };

                const vDel = batchDelete("voice_events");
                const cDel = batchDelete("command_events");
                const sDel = batchDelete("session_events");
                const rDel = batchDelete("runtime_events");
                const total = vDel + cDel + sDel + rDel;

                result = { ok: true, action, deletedRows: total, message: `ล้างประวัติเก่าเกิน ${retentionDays} วันสำเร็จ ลบ ${total} รายการ` };
                recordAudit("success", result);
                break;
            }

            case "checkpoint": {
                const rawMode = String(options.mode || "PASSIVE").trim().toUpperCase();
                const chk = checkpointWal(db, rawMode);
                const ok = Boolean(chk && chk.ok);
                result = {
                    ok,
                    action,
                    checkpoint: chk,
                    message: ok
                        ? `ดำเนินการ Checkpoint WAL สำเร็จ (Mode: ${chk.mode || rawMode}, Checkpointed: ${chk.checkpointedPages || chk.result?.[0]?.checkpointed || 0}, Logged: ${chk.logPages || chk.result?.[0]?.log || 0})`
                        : `ดำเนินการ Checkpoint WAL ล้มเหลว: ${chk?.error || "Unknown error"}`
                };
                if (ok) {
                    db.prepare("INSERT OR REPLACE INTO database_meta (key, value, updated_at) VALUES ('last_checkpoint', ?, ?)")
                        .run(new Date().toISOString(), Date.now());
                }
                recordAudit(ok ? "success" : "failure", result, ok ? null : (chk?.error || "Checkpoint failed"));
                break;
            }

            case "vacuum": {
                const safePages = Math.min(10000, Math.max(1, parseInt(options.pages, 10) || 500));
                const vac = runIncrementalVacuum(db, safePages);
                const ok = Boolean(vac && vac.ok);
                result = {
                    ok,
                    action,
                    vacuum: vac,
                    message: ok
                        ? `ดำเนินการ Incremental Vacuum สำเร็จ (คืนหน้าได้: ${vac.pagesVacuumed || 0} หน้า, ขนาดก่อน/หลัง: ${vac.preTotalMb || 0} MB ➔ ${vac.postTotalMb || 0} MB)`
                        : `ดำเนินการ Incremental Vacuum ล้มเหลว: ${vac?.error || "Unknown error"}`
                };
                recordAudit(ok ? "success" : "failure", result, ok ? null : (vac?.error || "Vacuum failed"));
                break;
            }

            case "backup": {
                const maxBackups = options.retention || parseInt(process.env.SQLITE_BACKUP_RETENTION, 10) || 2;
                const bkp = await createBackup(db, { maxBackups });
                const ok = Boolean(bkp && bkp.ok);
                result = {
                    ok,
                    action,
                    backup: bkp,
                    message: ok
                        ? `สำรองข้อมูลสำเร็จ (${bkp.filename}) ขนาด ${bkp.sizeMb} MB`
                        : `สำรองข้อมูลล้มเหลว: ${bkp?.error || "Unknown error"}`
                };
                if (ok) {
                    db.prepare("INSERT OR REPLACE INTO database_meta (key, value, updated_at) VALUES ('last_backup', ?, ?)")
                        .run(new Date().toISOString(), Date.now());
                }
                recordAudit(ok ? "success" : "failure", result, ok ? null : (bkp?.error || "Backup failed"));
                break;
            }

            case "emergency_trim": {
                const trim = await executeEmergencyTrim(db, {
                    actor: invoker,
                    reason: options.reason || "Manual Owner Emergency Trim"
                });
                result = {
                    ok: trim.ok,
                    action,
                    trimResult: trim,
                    message: trim.isResolved
                        ? `Emergency Trim สำเร็จ: คืนพื้นที่ได้ ${trim.freedMb} MB (ลบทั้งหมด ${trim.itemsPurged.totalItems} รายการ) สภาวะกลับสู่ปกติสมบูรณ์ (OK)`
                        : trim.postStatus === "soft" || trim.isSoftWarning
                            ? `Emergency Trim เสร็จสิ้น: คืนพื้นที่ได้ ${trim.freedMb} MB ระบบพ้นขีดวิกฤตแต่ยังอยู่ในเกณฑ์เฝ้าระวัง (Soft Warning)`
                            : `Emergency Trim เสร็จสิ้น: คืนพื้นที่ได้ ${trim.freedMb} MB แต่ระบบยังอยู่ในเกณฑ์อันตราย (${trim.postStatus})`
                };
                recordAudit(trim.ok ? "success" : "failure", result);
                break;
            }

            case "full_check": {
                const readRow = db.prepare("SELECT 1 AS probe").get();
                const intRows = db.pragma("integrity_check");
                const fkRows = db.pragma("foreign_key_check");
                const journalMode = db.pragma("journal_mode", { simple: true });
                const foreignKeys = db.pragma("foreign_keys", { simple: true });
                const schemaVer = db.pragma("user_version", { simple: true });
                const dbPath = getCurrentDbPath() || resolveDbPath();
                const quota = evaluateQuota(dbPath);
                const emergency = evaluateEmergencyThresholds(dbPath);
                const storage = evaluateStoragePaths({ dbPath });

                const integrityOk = intRows.length === 1 && (intRows[0].integrity_check === "ok" || intRows[0] === "ok");
                const fkOk = fkRows.length === 0;
                const pragmasOk = String(journalMode).toLowerCase() === "wal" && foreignKeys === 1;
                const readOk = Boolean(readRow && readRow.probe === 1);

                const hasErrors = !integrityOk || !fkOk || !pragmasOk || !readOk || !storage.ok || storage.filesystemCritical || quota.status === "hard";
                const hasWarnings = !hasErrors && (storage.warnings.length > 0 || storage.filesystemWarning || storage.pathWarning || quota.status === "soft" || quota.status === "critical" || emergency.isEmergency);

                let status = "ok";
                let message = "";

                if (hasErrors) {
                    status = "error";
                    message = "ตรวจพบข้อผิดพลาดร้ายแรงในการตรวจสอบความสมบูรณ์แบบละเอียด (Integrity/Pragmas/Storage Failure)";
                    if (!integrityOk || !fkOk) {
                        notifyIntegrityCorrupted(intRows, fkRows);
                    }
                } else if (hasWarnings) {
                    status = "warning";
                    message = `Diagnostic Check ผ่านการตรวจสอบหลัก แต่พบคำเตือน (WARNING): Storage/Quota เฝ้าระวัง (${quota.status}), พื้นที่ว่าง ${storage.freeSpace?.availableMb ?? "N/A"} MB`;
                } else {
                    status = "ok";
                    message = `Diagnostic Check ผ่าน 100% (PASS): SQLite ทำงานปกติสมบูรณ์, Schema Version ${schemaVer}, พื้นที่ ${quota.footprint.totalMb} MB (${quota.status})`;
                }

                result = {
                    ok: !hasErrors,
                    status,
                    action,
                    schemaVersion: schemaVer,
                    integrityOk,
                    foreignKeyErrors: fkRows,
                    pragmasOk,
                    journalMode,
                    quota,
                    emergency,
                    storage,
                    message
                };
                recordAudit(status === "ok" ? "success" : status === "warning" ? "warning" : "failure", result);
                break;
            }

            default:
                throw new Error(`ไม่รองรับคำสั่งการทำงาน: ${action}`);
        }
    } catch (err) {
        result = { ok: false, action, error: err.message, message: `เกิดข้อผิดพลาด: ${err.message}` };
        recordAudit("error", result, err);
    }

    result.durationMs = Date.now() - startTime;
    return result;
}

// ════════════════════════════════════════════════════════════════════════════
//  💻 4. DATABASE CONSOLE (STRICT ALLOWLIST - NO SHELL)
// ════════════════════════════════════════════════════════════════════════════

async function executeDatabaseConsole(commandString, invoker = "owner") {
    const raw = String(commandString || "").trim();
    const startTime = Date.now();

    if (!raw) {
        return {
            ok: false,
            command: "",
            output: "กรุณาระบุคำสั่ง เช่น status, health, stats, tables, integrity, cleanup, checkpoint, vacuum, backup",
            durationMs: 0
        };
    }

    // Shell injection guard: block common shell binaries and symbols
    const lower = raw.toLowerCase();
    const blockedKeywords = ["rm ", "rmdir", "curl", "wget", "bash", "sh", "npm", "node", "cat ", "ls ", "eval", ";", "|", "&", "`", "$"];
    if (blockedKeywords.some(kw => lower.includes(kw))) {
        return {
            ok: false,
            command: raw,
            output: "❌ ไม่อนุญาตให้รันคำสั่ง OS Shell หรืออักขระพิเศษบน Database Console เพื่อความปลอดภัยสูงสุด กรุณาใช้คำสั่งเฉพาะสำหรับฐานข้อมูลที่กำหนดไว้เท่านั้น",
            durationMs: Date.now() - startTime
        };
    }

    // Normalize command
    const cmd = lower;

    if (!CONSOLE_COMMANDS.includes(cmd)) {
        return {
            ok: false,
            command: raw,
            output: `❌ ไม่รู้จักคำสั่ง '${raw}'\nคำสั่งที่อนุญาตให้ใช้งานได้:\n${CONSOLE_COMMANDS.map(c => `  - ${c}`).join("\n")}`,
            durationMs: Date.now() - startTime
        };
    }

    let output = "";
    let ok = true;

    try {
        const db = getDatabase();
        const dispatchSqliteAction = (actName, actOpts, actInvoker) => {
            if (module.exports && typeof module.exports.executeSqliteAction === "function") {
                return module.exports.executeSqliteAction(actName, actOpts, actInvoker);
            }
            return executeSqliteAction(actName, actOpts, actInvoker);
        };

        switch (cmd) {
            case "status":
            case "health": {
                const overview = await getDatabaseOverview();
                const sq = overview.databases.sqlite;
                const mg = overview.databases.mongodb;
                output = [
                    "════════════════════════════════════════════════════════════",
                    "                สถานะระบบฐานข้อมูล (Database Status)          ",
                    "════════════════════════════════════════════════════════════",
                    `[SQLite]  สถานะ: ${sq.statusLabel} | พื้นที่: ${sq.footprintMb} MB / ${sq.hardLimitMb} MB (${sq.usedPercent}%)`,
                    `          จำนวน Records รวม: ${sq.records.total.toLocaleString()} รายการ (Core: ${sq.records.core}, Cache: ${sq.records.cache}, History: ${sq.records.history}, Temp: ${sq.records.temp})`,
                    `          รายละเอียดสถานะ: ${sq.degradedReason}`,
                    "------------------------------------------------------------",
                    `[MongoDB] สถานะ: ${mg.statusLabel} | ฐานข้อมูล: ${mg.name || "-"} | Ping: ${mg.pingMs !== null ? `${mg.pingMs}ms` : "-"}`,
                    `          โมเดลทั้งหมด: ${mg.modelsCount} โมเดล | Connection Pool: max ${mg.pool.maxPoolSize}, min ${mg.pool.minPoolSize}`,
                    "════════════════════════════════════════════════════════════"
                ].join("\n");
                break;
            }

            case "stats": {
                const details = await getSqliteDetailedStatus();
                output = [
                    "════════════════════════════════════════════════════════════",
                    "                สถิติแยกหมวดหมู่ (SQLite Stats)             ",
                    "════════════════════════════════════════════════════════════",
                    `1. ข้อมูลหลัก (Core):      ${details.categories.core.count.toLocaleString()} รายการ`,
                    ...Object.entries(details.categories.core.tables).map(([k, v]) => `   - ${k} (${v.label}): ${v.count.toLocaleString()}`),
                    `2. ข้อมูลชั่วคราว (Temp):    ${details.categories.temporary.count.toLocaleString()} รายการ`,
                    ...Object.entries(details.categories.temporary.tables).map(([k, v]) => `   - ${k} (${v.label}): ${v.count.toLocaleString()}`),
                    `3. ข้อมูลประวัติ (History): ${details.categories.history.count.toLocaleString()} รายการ`,
                    ...Object.entries(details.categories.history.tables).map(([k, v]) => `   - ${k} (${v.label}): ${v.count.toLocaleString()}`),
                    `4. แคชระบบ (Cache):        ${details.categories.cache.count.toLocaleString()} รายการ`,
                    ...Object.entries(details.categories.cache.tables).map(([k, v]) => `   - ${k} (${v.label}): ${v.count.toLocaleString()}`),
                    "════════════════════════════════════════════════════════════"
                ].join("\n");
                break;
            }

            case "tables": {
                const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(t => t.name);
                output = `ตารางทั้งหมดใน SQLite (${tables.length} ตาราง):\n` + tables.map(t => {
                    const cnt = db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get()?.c || 0;
                    return `  - ${t.padEnd(28)} : ${cnt.toLocaleString()} แถว`;
                }).join("\n");
                break;
            }

            case "migrations": {
                const userVersion = db.pragma("user_version", { simple: true });
                const rows = db.prepare("SELECT version, migration_id, applied_at FROM schema_migrations ORDER BY version").all();
                output = [
                    `PRAGMA user_version: ${userVersion}`,
                    "ประวัติ Schema Migrations:",
                    ...rows.map(r => `  [v${r.version}] ${(r.migration_id || "").padEnd(25)} (เมื่อ: ${new Date(r.applied_at).toISOString()})`)
                ].join("\n");
                break;
            }

            case "integrity": {
                const act = await dispatchSqliteAction("integrity", {}, invoker);
                output = act.ok ? "✅ ผ่านการตรวจสอบ Integrity และ Foreign Keys 100% ฐานข้อมูลสมบูรณ์ปกติ" : `❌ พบข้อผิดพลาด: ${JSON.stringify(act)}`;
                ok = act.ok;
                break;
            }

            case "cleanup": {
                const act = await dispatchSqliteAction("cleanup_all", {}, invoker);
                output = act.ok
                    ? `✅ ทำความสะอาดข้อมูลสำเร็จ: ลบข้อมูลชั่วคราวและประวัติเก่า ${act.stats?.totalDeleted || act.stats?.deletedRows || 0} รายการ`
                    : `❌ ทำความสะอาดข้อมูลล้มเหลว: ${act.message || act.error || "Unknown error"}`;
                ok = act.ok;
                break;
            }

            case "cleanup cache": {
                const act = await dispatchSqliteAction("cleanup_cache", {}, invoker);
                output = act.ok
                    ? `✅ ล้างแคชทั้งหมดสำเร็จ: ลบ ${act.deletedRows || 0} รายการ`
                    : `❌ ล้างแคชล้มเหลว: ${act.message || act.error || "Unknown error"}`;
                ok = act.ok;
                break;
            }

            case "cleanup history": {
                const act = await dispatchSqliteAction("cleanup_history", {}, invoker);
                output = act.ok
                    ? (act.message?.startsWith("✅") ? act.message : `✅ ${act.message || `ล้างประวัติสำเร็จ: ลบ ${act.deletedRows || 0} รายการ`}`)
                    : `❌ ล้างประวัติล้มเหลว: ${act.message || act.error || "Unknown error"}`;
                ok = act.ok;
                break;
            }

            case "checkpoint": {
                const act = await dispatchSqliteAction("checkpoint", {}, invoker);
                output = act.ok
                    ? `✅ ดำเนินการ Checkpoint WAL สำเร็จ: ${act.message || "เสร็จสิ้น"}`
                    : `❌ ดำเนินการ Checkpoint WAL ล้มเหลว: ${act.message || act.error || act.checkpoint?.error || "Unknown error"}`;
                ok = act.ok;
                break;
            }

            case "vacuum": {
                const act = await dispatchSqliteAction("vacuum", {}, invoker);
                output = act.ok
                    ? `✅ ดำเนินการ Incremental Vacuum สำเร็จ: ${act.message || "เสร็จสิ้น"}`
                    : `❌ ดำเนินการ Incremental Vacuum ล้มเหลว: ${act.message || act.error || act.vacuum?.error || "Unknown error"}`;
                ok = act.ok;
                break;
            }

            case "backup": {
                const act = await dispatchSqliteAction("backup", {}, invoker);
                output = act.ok
                    ? `✅ สร้างไฟล์สำรองข้อมูลสำเร็จ:\n   ไฟล์: ${act.backup?.filename}\n   ขนาด: ${act.backup?.sizeMb} MB\n   SHA-256: ${act.backup?.sha256 || 'N/A'}`
                    : `❌ สำรองข้อมูลล้มเหลว: ${act.message || act.error || "Unknown error"}`;
                ok = act.ok;
                break;
            }

            case "emergency-trim": {
                const act = await dispatchSqliteAction("emergency_trim", {}, invoker);
                if (act.ok) {
                    const t = act.trimResult;
                    output = [
                        `🚨 ผลการดำเนินการ Emergency Auto-Trim:`,
                        `  สถานะผลลัพธ์:         ${t.isResolved ? '✅ RESOLVED (ปกติ)' : '⚠️ DEGRADED (เฝ้าระวัง)'}`,
                        `  พื้นที่ที่คืนได้:        ${t.freedMb} MB`,
                        `  รายการที่ถูกลบ:       ${t.itemsPurged?.totalItems || 0} รายการ`,
                        `    - Asset หมดอายุ:    ${t.itemsPurged?.assetExpired || 0}`,
                        `    - Cache ชั่วคราว:    ${(t.itemsPurged?.nonces || 0) + (t.itemsPurged?.cacheEntries || 0)}`,
                        `    - ประวัติพ้น Retention: ${t.itemsPurged?.expiredHistory || 0}`,
                        `  ขนาดก่อน/หลัง:        ${t.preFootprint?.totalMb} MB ➔ ${t.postFootprint?.totalMb} MB`,
                        `  ระยะเวลา:             ${t.durationMs} ms`
                    ].join("\n");
                } else {
                    output = `❌ ล้มเหลว: ${act.message || act.error}`;
                }
                ok = act.ok;
                break;
            }

            case "full-check": {
                const act = await dispatchSqliteAction("full_check", {}, invoker);
                if (act.ok) {
                    output = [
                        `🔍 ผลการตรวจสอบความสมบูรณ์แบบละเอียด (Full Health Check):`,
                        `  สถานะ Integrity Check:    ${act.integrityOk ? '✅ PASS (สมบูรณ์ 100%)' : '❌ FAIL'}`,
                        `  Schema Migrations:        ✅ Version ${act.schemaVersion || 4}`,
                        `  Foreign Keys Check:       ✅ PASS (0 errors)`,
                        `  Storage Footprint:        ${act.quota?.footprint?.totalMb} MB / ${act.quota?.limits?.hardMb} MB (${act.quota?.status})`,
                        `  Emergency Alert Status:   ${act.emergency?.isEmergency ? '🚨 CRITICAL' : '🟢 NORMAL'}`
                    ].join("\n");
                } else {
                    output = `❌ ตรวจพบปัญหา: ${act.message || act.error}`;
                }
                ok = act.ok;
                break;
            }
        }
    } catch (err) {
        ok = false;
        output = `❌ เกิดข้อผิดพลาดในการประมวลผลคำสั่ง: ${err.message}`;
    }

    return {
        ok,
        command: raw,
        output,
        durationMs: Date.now() - startTime
    };
}

// ════════════════════════════════════════════════════════════════════════════
//  🍃 5. MONGODB MONITORING & SAFE DATA EXPLORER
// ════════════════════════════════════════════════════════════════════════════

async function getMongoDetailedStatus() {
    const mongoStatus = mongo.getMongoStatus();
    if (!mongoStatus.connected || !mongo.mongoose.connection.db) {
        return {
            connected: false,
            statusLabel: "🔴 ขาดการเชื่อมต่อ",
            collections: []
        };
    }

    // Ping
    let pingMs = 0;
    try {
        const pStart = Date.now();
        await mongo.mongoose.connection.db.command({ ping: 1 });
        pingMs = Date.now() - pStart;
    } catch (_) {}

    // Host & Connection safe info
    const safeHost = mongo.mongoose.connection.host || "cluster.mongodb.net";
    const maskedHost = safeHost.replace(/(:\/\/)([^@]+)@/, "$1***:***@");

    // Collections stats
    const collections = [];
    for (const modelName of ALLOWED_MONGO_COLLECTIONS) {
        const Model = mongo.models[modelName];
        if (!Model) continue;

        let docCount = 0;
        try {
            docCount = await Model.estimatedDocumentCount();
        } catch (_) {
            try {
                docCount = await Model.countDocuments();
            } catch (_) {}
        }

        collections.push({
            name: modelName,
            collectionName: Model.collection?.collectionName || modelName.toLowerCase(),
            count: docCount,
            indexesCount: Model.schema?.indexes()?.length || 0
        });
    }

    // Database Stats (storageSize, dataSize, indexSize, objects)
    let stats = null;
    try {
        const rawStats = await mongo.mongoose.connection.db.stats();
        stats = {
            collections: rawStats.collections || 0,
            objects: rawStats.objects || 0,
            avgObjSize: rawStats.avgObjSize || 0,
            dataSizeBytes: rawStats.dataSize || 0,
            storageSizeBytes: rawStats.storageSize || 0,
            indexSizeBytes: rawStats.indexSize || 0,
            totalSizeBytes: (rawStats.storageSize || 0) + (rawStats.indexSize || 0),
            dataSizeMb: parseFloat(((rawStats.dataSize || 0) / (1024 * 1024)).toFixed(2)),
            storageSizeMb: parseFloat(((rawStats.storageSize || 0) / (1024 * 1024)).toFixed(2)),
            indexSizeMb: parseFloat(((rawStats.indexSize || 0) / (1024 * 1024)).toFixed(2))
        };
    } catch (_) {}

    const topCollections = [...collections].sort((a, b) => b.count - a.count).slice(0, 5);

    return {
        connected: true,
        statusLabel: "🟢 ปกติ",
        databaseName: mongoStatus.name,
        host: maskedHost,
        pingMs,
        pool: mongoStatus.pool,
        collectionsCount: collections.length,
        stats,
        topCollections,
        collections
    };
}

function maskSensitiveValue(key, value) {
    if (value === null || value === undefined) return value;

    const lowerKey = String(key).toLowerCase();

    // 1. Tokens, Secrets, Passwords, Cryptographic blobs
    if (/token|secret|password|key|hash|salt|iv|cipher|auth/i.test(lowerKey)) {
        if (typeof value === "string" && value.length > 8) {
            return `${value.slice(0, 4)}...${value.slice(-3)} [PROTECTED]`;
        }
        return "[PROTECTED_SECRET]";
    }

    // 2. IP Addresses (IPv4 & IPv6)
    if (typeof value === "string") {
        // IPv4 regex
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) {
            return value.replace(/\.\d{1,3}\.\d{1,3}$/, ".***.***");
        }
        // Email
        if (value.includes("@") && value.includes(".")) {
            const [local, dom] = value.split("@");
            return `${local.slice(0, 1)}***@${dom}`;
        }
    }

    // Recursive object masking
    if (typeof value === "object") {
        if (Array.isArray(value)) {
            return value.map((item, idx) => maskSensitiveValue(idx, item));
        }
        const maskedObj = {};
        for (const [k, v] of Object.entries(value)) {
            maskedObj[k] = maskSensitiveValue(k, v);
        }
        return maskedObj;
    }

    return value;
}

async function getMongoCollectionSample(collectionName, limit = 5) {
    if (!ALLOWED_MONGO_COLLECTIONS.includes(collectionName)) {
        throw new Error(`ไม่อนุญาตให้เปิดดู Collection '${collectionName}'`);
    }

    const Model = mongo.models[collectionName];
    if (!Model) {
        throw new Error(`ไม่พบโมเดล '${collectionName}' ในระบบ`);
    }

    const boundedLimit = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 10);
    const docs = await Model.find({}).sort({ _id: -1 }).limit(boundedLimit).lean().exec();

    const maskedDocs = docs.map(doc => {
        const masked = {};
        for (const [k, v] of Object.entries(doc)) {
            masked[k] = maskSensitiveValue(k, v);
        }
        return masked;
    });

    const totalCount = await Model.estimatedDocumentCount().catch(() => 0);

    return {
        collectionName,
        totalCount,
        sampleCount: maskedDocs.length,
        documents: maskedDocs
    };
}

module.exports = {
    getDatabaseOverview,
    getSqliteDetailedStatus,
    executeSqliteAction,
    executeDatabaseConsole,
    getMongoDetailedStatus,
    getMongoCollectionSample,
    maskSensitiveValue,
    notifyIntegrityCorrupted,
    recordMaintenanceAudit,
    recordAudit: recordMaintenanceAudit,
    CONSOLE_COMMANDS,
    ALLOWED_MONGO_COLLECTIONS
};
