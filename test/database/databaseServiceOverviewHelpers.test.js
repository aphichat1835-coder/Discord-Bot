"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const databaseService = require("../../database/services/databaseService");
const {
    evaluateSqliteHealth,
    summarizeTableRecordCounts,
    computeStorageBreakdown,
    calculateManagedStorage,
    resolvePersistentLabel,
    measureMongoOverview
} = databaseService._test;

test("databaseService Overview & Health Pure Helpers Suite", async (t) => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    await t.test("1. evaluateSqliteHealth correctly classifies health levels", () => {
        // Filesystem critical
        const crit1 = evaluateSqliteHealth({
            storage: { filesystemCritical: true, errors: ["Disk full on mount /data"] },
            emergency: { isEmergency: false },
            quota: { status: "normal", degradedReason: null }
        });
        assert.equal(crit1.sqliteHealth, "error");
        assert.equal(crit1.sqliteStatusLabel, "🔴 มีปัญหา (Critical / Disk)");
        assert.equal(crit1.degradedReason, "Disk full on mount /data");

        // Emergency mode
        const crit2 = evaluateSqliteHealth({
            storage: { filesystemCritical: false, errors: [] },
            emergency: { isEmergency: true },
            quota: { status: "normal", degradedReason: null }
        });
        assert.equal(crit2.sqliteHealth, "error");

        // Hard quota
        const crit3 = evaluateSqliteHealth({
            storage: { filesystemCritical: false, errors: [] },
            emergency: { isEmergency: false },
            quota: { status: "hard", degradedReason: "Hard cap exceeded" }
        });
        assert.equal(crit3.sqliteHealth, "error");

        // Filesystem warning
        const warn1 = evaluateSqliteHealth({
            storage: { filesystemWarning: true, warnings: ["Low disk space 10%"] },
            emergency: { isEmergency: false },
            quota: { status: "normal", degradedReason: null }
        });
        assert.equal(warn1.sqliteHealth, "warning");
        assert.equal(warn1.sqliteStatusLabel, "🟠 ใกล้ถึงขีดจำกัด");
        assert.equal(warn1.degradedReason, "Low disk space 10%");

        // Critical quota
        const warn2 = evaluateSqliteHealth({
            storage: { filesystemWarning: false },
            emergency: { isEmergency: false },
            quota: { status: "critical", degradedReason: "Quota at 90%" }
        });
        assert.equal(warn2.sqliteHealth, "warning");

        // Soft quota
        const check = evaluateSqliteHealth({
            storage: { filesystemWarning: false, filesystemCritical: false },
            emergency: { isEmergency: false },
            quota: { status: "soft", degradedReason: null }
        });
        assert.equal(check.sqliteHealth, "check");
        assert.equal(check.sqliteStatusLabel, "🟡 ควรตรวจสอบ");

        // Normal ok
        const normal = evaluateSqliteHealth({
            storage: { filesystemWarning: false, filesystemCritical: false },
            emergency: { isEmergency: false },
            quota: { status: "normal", degradedReason: null }
        });
        assert.equal(normal.sqliteHealth, "ok");
        assert.equal(normal.sqliteStatusLabel, "🟢 ปกติ");
    });

    await t.test("2. resolvePersistentLabel reflects storage mount verification", () => {
        assert.equal(resolvePersistentLabel({ persistentMountVerified: true }), "✅ Owner-Confirmed Persistent Path");
        assert.equal(resolvePersistentLabel({ configuredPersistentPath: true }), "🟡 Persistent Path Configured (Mount Unverified)");
        assert.equal(resolvePersistentLabel({ allowInSource: true }), "ℹ️ Owner-Permitted In-Source Storage");
        assert.equal(resolvePersistentLabel({}), "❌ Ephemeral / In-Source");
        assert.equal(resolvePersistentLabel(null), "❌ Ephemeral / In-Source");
    });

    await t.test("3. summarizeTableRecordCounts safely counts categorized records", () => {
        const mockDb = {
            prepare: (sql) => {
                if (sql.includes("sqlite_master")) {
                    return {
                        all: () => [
                            { name: "core_config" },
                            { name: "asset_cache" },
                            { name: "audit_history" },
                            { name: "temp_lock" },
                            { name: "broken_table" }
                        ]
                    };
                }
                return {
                    get: () => {
                        if (sql.includes("broken_table")) throw new Error("Table corrupted");
                        return { c: 10 };
                    }
                };
            }
        };

        const counts = summarizeTableRecordCounts(mockDb);
        assert.ok(counts.total >= 40);
        assert.equal(typeof counts.core, "number");
        assert.equal(typeof counts.cache, "number");
        assert.equal(typeof counts.history, "number");
        assert.equal(typeof counts.temp, "number");
    });

    await t.test("4. computeStorageBreakdown and calculateManagedStorage", () => {
        const mockDb = {};
        const breakdown = computeStorageBreakdown({
            db: mockDb,
            dbPath: "/tmp/nonexistent/db.sqlite",
            quota: { footprint: { totalBytes: 1048576 } }
        });

        assert.equal(breakdown.dbBytes, 1048576);
        assert.ok(breakdown.totalManagedBytes >= 1048576);

        const managed = calculateManagedStorage({
            db: mockDb,
            dbPath: "/tmp/nonexistent/db.sqlite",
            quota: { footprint: { totalBytes: 2097152 } },
            storage: { freeSpace: { availableBytes: 52428800, availableMb: 50 } }
        });

        assert.equal(managed.databaseBytes, 2097152);
        assert.equal(managed.databaseMb, 2);
        assert.equal(managed.freeDiskMb, 50);
    });

    await t.test("5. measureMongoOverview verifies ping and handles exceptions", async () => {
        // 1. Connected with successful ping
        const mockMongoHealthy = {
            getMongoStatus: () => ({ connected: true }),
            mongoose: {
                connection: {
                    db: {
                        command: async () => ({ ok: 1 })
                    }
                }
            }
        };
        const resHealthy = await measureMongoOverview(mockMongoHealthy);
        assert.equal(resHealthy.mongoHealthLabel, "🟢 ปกติ");
        assert.ok(typeof resHealthy.mongoPingMs === "number");

        // 2. Connected but ping throws
        const mockMongoSlow = {
            getMongoStatus: () => ({ connected: true }),
            mongoose: {
                connection: {
                    db: {
                        command: async () => { throw new Error("Ping timeout"); }
                    }
                }
            }
        };
        const resSlow = await measureMongoOverview(mockMongoSlow);
        assert.equal(resSlow.mongoHealthLabel, "🟡 ช้า/มีปัญหา");
        assert.equal(resSlow.mongoPingMs, null);

        // 3. Disconnected
        const mockMongoDisconnected = {
            getMongoStatus: () => ({ connected: false }),
            mongoose: null
        };
        const resDisconnected = await measureMongoOverview(mockMongoDisconnected);
        assert.equal(resDisconnected.mongoHealthLabel, "🔴 ขาดการเชื่อมต่อ");
    });
});
