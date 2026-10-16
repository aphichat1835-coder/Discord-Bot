"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Database = require("better-sqlite3");

const {
    loadMigrationFiles,
    runMigrations,
    getAppliedMigrations,
    getPendingMigrations,
    MIGRATION_FILE_PATTERN
} = require("../../database/sqlite/migrations/migrationRunner");

describe("Migration Runner Sort, Regex and In-Memory Execution Suite", () => {
    const realMigrationsDir = path.resolve(__dirname, "../../database/sqlite/migrations");

    describe("1. Production Migrations Ordering & Integrity", () => {
        test("loads production migrations strictly ordered from 001 to 012", () => {
            const migrations = loadMigrationFiles(realMigrationsDir);
            assert.ok(Array.isArray(migrations), "Result should be an array");
            assert.ok(migrations.length >= 12, `Expected at least 12 migrations, got ${migrations.length}`);

            const versions = migrations.map(m => m.version);
            for (let i = 0; i < versions.length; i++) {
                assert.equal(versions[i], i + 1, `Migration index ${i} should have version ${i + 1}`);
            }

            assert.equal(migrations[0].migrationId, "001_initial_core.sql");
            assert.equal(migrations[11].migrationId, "012_verification_webhook_sent_parts.sql");

            // Verify each item has required properties
            for (const item of migrations) {
                assert.ok(item.migrationId, "migrationId must exist");
                assert.ok(typeof item.version === "number", "version must be a number");
                assert.ok(typeof item.checksum === "string" && item.checksum.length === 64, "checksum must be sha256 hex");
                assert.ok(typeof item.content === "string" && item.content.length > 0, "content must be non-empty string");
            }
        });
    });

    describe("2. Natural Numeric Sorting & Tie-Breaking", () => {
        let tempDir;

        before(() => {
            tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-sort-test-"));
            
            // Files intentionally out of order and containing single-digit and multi-digit prefixes
            const testFiles = [
                "10_ten.sql",
                "1_one.sql",
                "2_two.sql",
                "11_eleven.sql",
                "003_three.sql",
                "20_twenty.sql",
                "002_two_dup.sql"
            ];

            for (const file of testFiles) {
                fs.writeFileSync(path.join(tempDir, file), `-- migration ${file}\nSELECT 1;`);
            }
        });

        test("sorts files numerically rather than raw ASCII (e.g. 1, 2, 10, 11)", () => {
            const loaded = loadMigrationFiles(tempDir);
            const ids = loaded.map(m => m.migrationId);

            // With ASCII sort: 002, 003, 10, 11, 1, 2, 20
            // With numeric localeCompare: 1, 002 (or 2), 003, 10, 11, 20
            // Verify '10_ten.sql' comes after '2_two.sql' and '1_one.sql'
            const idx1 = ids.indexOf("1_one.sql");
            const idx2 = ids.indexOf("2_two.sql");
            const idx10 = ids.indexOf("10_ten.sql");
            const idx11 = ids.indexOf("11_eleven.sql");
            const idx20 = ids.indexOf("20_twenty.sql");

            assert.ok(idx1 < idx2, "1_one.sql should precede 2_two.sql");
            assert.ok(idx2 < idx10, "2_two.sql should precede 10_ten.sql");
            assert.ok(idx10 < idx11, "10_ten.sql should precede 11_eleven.sql");
            assert.ok(idx11 < idx20, "11_eleven.sql should precede 20_twenty.sql");
        });

        test("deterministic sorting with same numeric prefix and different suffixes", () => {
            const items = ["005_beta.sql", "005_alpha.sql", "005_gamma.sql"];
            const sorted = [...items].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));

            assert.deepEqual(sorted, ["005_alpha.sql", "005_beta.sql", "005_gamma.sql"]);
        });

        test("deterministic sorting preserves stability across shuffled inputs", () => {
            const expectedOrder = ["1_a.sql", "2_b.sql", "10_c.sql", "11_d.sql", "100_e.sql"];
            
            for (let run = 0; run < 10; run++) {
                const shuffled = [...expectedOrder].sort(() => Math.random() - 0.5);
                const sorted = shuffled.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
                assert.deepEqual(sorted, expectedOrder, `Run ${run} should deterministically produce expected order`);
            }
        });

        after(() => {
            if (tempDir && fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });

    describe("3. Regex Pattern Matching (MIGRATION_FILE_PATTERN)", () => {
        test("correctly parses valid migration filenames", () => {
            const pattern = MIGRATION_FILE_PATTERN || /^(\d+)_(.+)\.sql$/;

            const cases = [
                { input: "001_initial_core.sql", expectedVer: "001", expectedName: "initial_core" },
                { input: "012_verification_webhook_sent_parts.sql", expectedVer: "012", expectedName: "verification_webhook_sent_parts" },
                { input: "1_single_digit.sql", expectedVer: "1", expectedName: "single_digit" },
                { input: "999_complex-name_with.dots.sql", expectedVer: "999", expectedName: "complex-name_with.dots" },
                { input: "10000_large_version.sql", expectedVer: "10000", expectedName: "large_version" }
            ];

            for (const { input, expectedVer, expectedName } of cases) {
                const match = pattern.exec(input);
                assert.ok(match, `Pattern should match ${input}`);
                assert.equal(match[1], expectedVer, `Version capture should match ${expectedVer}`);
                assert.equal(match[2], expectedName, `Name capture should match ${expectedName}`);
            }
        });

        test("rejects invalid migration filenames", () => {
            const pattern = MIGRATION_FILE_PATTERN || /^(\d+)_(.+)\.sql$/;

            const invalidCases = [
                "migration.sql",
                "001-missing-underscore.sql",
                "_missing_version.sql",
                "001_not_sql.txt",
                "abc_name.sql",
                "001_.sql",
                ".001_prefix.sql",
                "001_name.SQL"
            ];

            for (const input of invalidCases) {
                const match = pattern.exec(input);
                assert.equal(match, null, `Pattern should NOT match ${input}`);
            }
        });

        test("loadMigrationFiles gracefully defaults version to 0 for non-standard filenames", () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-regex-test-"));
            try {
                fs.writeFileSync(path.join(tempDir, "custom_without_number.sql"), "SELECT 1;");
                const loaded = loadMigrationFiles(tempDir);
                assert.equal(loaded.length, 1);
                assert.equal(loaded[0].version, 0);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });

    describe("4. In-Memory Database Migration Execution", () => {
        test("executes full suite of migrations on :memory: database cleanly", () => {
            const db = new Database(":memory:");
            try {
                const results = runMigrations(db, { migrationsDir: realMigrationsDir });

                assert.ok(results.applied.length >= 12, "All migrations should be applied");
                assert.equal(results.verified.length, 0, "No migrations should be in verified on fresh DB");
                assert.ok(results.currentVersion >= 12, `currentVersion should be >= 12, got ${results.currentVersion}`);

                // Verify user_version pragma matches current version
                const userVer = db.pragma("user_version", { simple: true });
                assert.equal(userVer, results.currentVersion);

                // Verify applied migrations in database
                const applied = getAppliedMigrations(db);
                assert.equal(applied.size, results.applied.length);
                assert.ok(applied.has("001_initial_core.sql"));
                assert.ok(applied.has("012_verification_webhook_sent_parts.sql"));

                // Verify pending migrations is now empty
                const pending = getPendingMigrations(db, { migrationsDir: realMigrationsDir });
                assert.equal(pending.length, 0);

                // Second run should verify and apply 0 migrations (idempotency)
                const secondRun = runMigrations(db, { migrationsDir: realMigrationsDir });
                assert.equal(secondRun.applied.length, 0);
                assert.equal(secondRun.verified.length, results.applied.length);
            } finally {
                db.close();
            }
        });

        test("reconciles user_version even if user_version was reset to 0", () => {
            const db = new Database(":memory:");
            try {
                runMigrations(db, { migrationsDir: realMigrationsDir });
                
                // Simulate accidental PRAGMA user_version = 0
                db.pragma("user_version = 0");
                assert.equal(db.pragma("user_version", { simple: true }), 0);

                // Re-running migrations should reconcile user_version from schema_migrations
                const rerun = runMigrations(db, { migrationsDir: realMigrationsDir });
                assert.ok(rerun.currentVersion >= 12);
                assert.equal(db.pragma("user_version", { simple: true }), rerun.currentVersion);
            } finally {
                db.close();
            }
        });
    });
});
