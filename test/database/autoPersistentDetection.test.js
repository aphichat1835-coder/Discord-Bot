"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const { resolveDbPath } = require("../../database/sqlite/connection");
const { resolveBackupDir } = require("../../database/sqlite/maintenance/backup");
const { resolveAssetDir } = require("../../database/sqlite/cache/assetCacheManager");
const { evaluateStoragePaths } = require("../../database/sqlite/maintenance/storageCheck");

describe("Auto Persistent Storage Detection Suite", () => {
    test("resolveDbPath defaults to data/discordbot.sqlite when no env is set", () => {
        const prev = process.env.SQLITE_DB_PATH;
        delete process.env.SQLITE_DB_PATH;
        try {
            const resolved = resolveDbPath();
            assert.ok(resolved.endsWith(path.join("data", "discordbot.sqlite")));
        } finally {
            if (prev) process.env.SQLITE_DB_PATH = prev;
        }
    });

    test("resolveBackupDir defaults to backups when no env is set", () => {
        const prev = process.env.SQLITE_BACKUP_DIR;
        delete process.env.SQLITE_BACKUP_DIR;
        try {
            const resolved = resolveBackupDir();
            assert.ok(resolved.endsWith("backups"));
        } finally {
            if (prev) process.env.SQLITE_BACKUP_DIR = prev;
        }
    });

    test("resolveAssetDir defaults to data/cache-assets when no env is set", () => {
        const prev = process.env.SQLITE_ASSET_DIR;
        delete process.env.SQLITE_ASSET_DIR;
        try {
            const resolved = resolveAssetDir();
            assert.ok(resolved.endsWith(path.join("data", "cache-assets")));
        } finally {
            if (prev) process.env.SQLITE_ASSET_DIR = prev;
        }
    });

    test("storageCheck respects explicit external paths and persistenceConfirmed", () => {
        const res = evaluateStoragePaths({
            env: "production",
            dbPath: "/mnt/external/db.sqlite",
            backupDir: "/mnt/external/backups",
            assetDir: "/mnt/external/assets"
        });

        assert.equal(res.configuredPersistentPath, true);
        assert.equal(res.hasInSource, false);
    });
});
