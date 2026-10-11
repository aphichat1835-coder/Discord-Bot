"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { evaluateStoragePaths, isPathInside } = require("../../database/sqlite/maintenance/storageCheck");

describe("Storage Check & Volume Mount Probe Suite", () => {
    test("isPathInside: correctly checks parent child relationships", () => {
        const repoRoot = "/workspaces/discordbot3";
        assert.equal(isPathInside("/workspaces/discordbot3/data/test.sqlite", repoRoot), true);
        assert.equal(isPathInside("/workspaces/discordbot3/backups", repoRoot), true);
        assert.equal(isPathInside("/persistent/discordbot.sqlite", repoRoot), false);
        assert.equal(isPathInside("/var/data/backups", repoRoot), false);
    });

    test("evaluateStoragePaths: allows local workspace in development mode with informational warning", () => {
        const res = evaluateStoragePaths({
            env: "development"
        });

        assert.equal(res.isProduction, false);
        assert.equal(res.ok, true);
        assert.equal(res.errors.length, 0);
        assert.equal(res.pathWarning, true);
        assert.ok(res.warnings.length > 0);
    });

    test("evaluateStoragePaths: warns on in-source paths in production mode without fatal crash", () => {
        const repoRoot = path.resolve(process.cwd());
        const res = evaluateStoragePaths({
            env: "production",
            dbPath: path.join(repoRoot, "data", "test.sqlite"),
            backupDir: path.join(repoRoot, "backups"),
            assetDir: path.join(repoRoot, "data", "cache-assets")
        });

        assert.equal(res.isProduction, true);
        // Architecture invariant: In-source storage does NOT fatal crash the bot!
        assert.equal(res.ok, true);
        assert.equal(res.errors.length, 0);
        assert.equal(res.pathWarning, true);
        assert.equal(res.persistentRecommended, true);
        assert.ok(res.warnings.some(w => w.includes("PRODUCTION_STORAGE")));
    });

    test("evaluateStoragePaths: passes cleanly when external persistent paths are provided in production", () => {
        const res = evaluateStoragePaths({
            env: "production",
            dbPath: "/tmp/test_persistent/discordbot.sqlite",
            backupDir: "/tmp/test_persistent/backups",
            assetDir: "/tmp/test_persistent/cache-assets"
        });

        assert.equal(res.isProduction, true);
        assert.equal(res.ok, true);
        assert.equal(res.errors.length, 0);
        assert.equal(res.paths.database.inSource, false);
        assert.equal(res.pathWarning, false);
        assert.equal(res.persistentRecommended, false);
    });

    test("evaluateStoragePaths: flags filesystemCritical on unwritable directory", () => {
        const res = evaluateStoragePaths({
            env: "production",
            dbPath: "/root/__forbidden_path_test/discordbot.sqlite",
            backupDir: "/root/__forbidden_path_test/backups",
            assetDir: "/root/__forbidden_path_test/cache-assets"
        });

        assert.equal(res.ok, false);
        assert.equal(res.filesystemCritical, true);
        assert.ok(res.errors.length > 0);
        assert.ok(res.errors.some(e => e.includes("Filesystem write failure")));
    });
});
