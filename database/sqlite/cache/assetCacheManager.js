"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getDatabase } = require("../connection");
const { canWrite } = require("../maintenance/writePolicy");

const DEFAULT_MAX_QUOTA_BYTES = 500 * 1024 * 1024; // 500MB dedicated quota

function resolveTtlForType(assetType, customTtlMs = null) {
    if (customTtlMs !== null && customTtlMs !== undefined) {
        return customTtlMs;
    }
    const type = String(assetType || "general").toLowerCase();
    if (type === "avatar" || type.includes("avatar")) {
        const days = parseInt(process.env.SQLITE_ASSET_AVATAR_TTL_DAYS, 10);
        return (!isNaN(days) && days > 0 ? days : 3) * 24 * 60 * 60 * 1000;
    }
    if (type === "icon" || type === "guild_icon" || type.includes("icon")) {
        const days = parseInt(process.env.SQLITE_ASSET_GUILD_ICON_TTL_DAYS, 10);
        return (!isNaN(days) && days > 0 ? days : 14) * 24 * 60 * 60 * 1000;
    }
    const defaultDays = parseInt(process.env.SQLITE_ASSET_DEFAULT_TTL_DAYS, 10);
    return (!isNaN(defaultDays) && defaultDays > 0 ? defaultDays : 7) * 24 * 60 * 60 * 1000;
}

function resolveAssetDir() {
    if (process.env.SQLITE_ASSET_DIR && process.env.SQLITE_ASSET_DIR.trim()) {
        return path.resolve(process.env.SQLITE_ASSET_DIR.trim());
    }
    // Auto-detection: If host has mounted a writable /persistent volume, use it automatically
    try {
        if (fs.existsSync("/persistent")) {
            fs.accessSync("/persistent", fs.constants.R_OK | fs.constants.W_OK);
            return path.resolve("/persistent", "cache-assets");
        }
    } catch (_) {}
    return path.join(process.cwd(), "data", "cache-assets");
}

function resolveMaxQuotaBytes() {
    const envVal = parseInt(process.env.SQLITE_ASSET_CACHE_MAX_BYTES, 10);
    return !isNaN(envVal) && envVal > 0 ? envVal : DEFAULT_MAX_QUOTA_BYTES;
}

const MIME_EXT_MAP = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
    "application/json": ".json",
    "application/octet-stream": ".bin"
};

class AssetCacheManager {
    constructor(db = null, options = {}) {
        this._db = db;
        this.assetDir = options.assetDir || resolveAssetDir();
        this.maxQuotaBytes = options.maxQuotaBytes || resolveMaxQuotaBytes();
        this._ensureDirectory();

        // Write Amplification Protection: batch LRU touches
        this.touchBuffer = new Map(); // assetKey -> timestamp
        this.touchFlushIntervalMs = options.touchFlushIntervalMs || 10000;
        this.touchFlushInterval = setInterval(() => this.flushTouches(), this.touchFlushIntervalMs);
        if (this.touchFlushInterval.unref) {
            this.touchFlushInterval.unref();
        }
    }

    get db() {
        return this._db || getDatabase();
    }

    _ensureDirectory() {
        try {
            if (!fs.existsSync(this.assetDir)) {
                fs.mkdirSync(this.assetDir, { recursive: true });
            }
        } catch (err) {
            console.error(`[ASSET_CACHE] ⚠️ Failed to create asset directory: ${err.message}`);
        }
    }

    stopTouchFlusher() {
        if (this.touchFlushInterval) {
            clearInterval(this.touchFlushInterval);
            this.touchFlushInterval = null;
        }
        this.flushTouches();
    }

    recordTouch(assetKey, now = Date.now()) {
        if (!assetKey) return;
        this.touchBuffer.set(String(assetKey), now);
        if (this.touchBuffer.size >= 50) {
            this.flushTouches();
        }
    }

    flushTouches() {
        if (!this.touchBuffer || this.touchBuffer.size === 0) return;
        const entries = Array.from(this.touchBuffer.entries());
        this.touchBuffer.clear();

        try {
            const stmt = this.db.prepare("UPDATE asset_cache SET last_used_at = ? WHERE asset_key = ?");
            const updateTx = this.db.transaction(() => {
                for (const [key, ts] of entries) {
                    stmt.run(ts, key);
                }
            });
            updateTx();
        } catch (_) {}
    }

    getAsset(assetKey) {
        if (!assetKey) return null;
        try {
            const row = this.db.prepare("SELECT * FROM asset_cache WHERE asset_key = ?").get(String(assetKey));
            if (!row) return null;

            const now = Date.now();
            if (row.expires_at && row.expires_at < now) {
                // Expired asset -> treat as miss and prune
                this.deleteAsset(assetKey);
                return null;
            }

            const fullPath = path.join(this.assetDir, row.relative_path);
            if (!fs.existsSync(fullPath)) {
                // Orphan metadata without physical file -> purge row, return miss
                this.db.prepare("DELETE FROM asset_cache WHERE asset_key = ?").run(String(assetKey));
                return null;
            }

            // Record touch in buffer to prevent write amplification
            this.recordTouch(assetKey, now);

            return {
                key: row.asset_key,
                type: row.asset_type,
                relativePath: row.relative_path,
                filePath: fullPath,
                mimeType: row.mime_type,
                sizeBytes: row.size_bytes,
                sha256: row.sha256,
                sourceUrl: row.source_url,
                createdAt: new Date(row.created_at),
                lastUsedAt: new Date(now),
                expiresAt: new Date(row.expires_at),
                buffer: fs.readFileSync(fullPath)
            };
        } catch (err) {
            console.error(`[ASSET_CACHE] ⚠️ Error retrieving asset ${assetKey}: ${err.message}`);
            return null;
        }
    }

    setAsset(assetKey, buffer, options = {}) {
        if (!canWrite("cache")) {
            return false;
        }
        if (!assetKey || !Buffer.isBuffer(buffer)) {
            throw new TypeError("assetKey string and Buffer are required");
        }

        const sizeBytes = buffer.length;
        const maxSingleAssetBytes = 25 * 1024 * 1024; // 25MB single file limit
        if (sizeBytes > maxSingleAssetBytes) {
            throw new Error(`Asset size (${(sizeBytes / 1024 / 1024).toFixed(1)}MB) exceeds maximum single asset limit (25MB)`);
        }

        const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
        const mimeType = options.mimeType || "application/octet-stream";
        const assetType = options.assetType || "general";
        const ext = MIME_EXT_MAP[mimeType] || ".bin";
        const relativePath = `${sha256}${ext}`;
        const fullPath = path.join(this.assetDir, relativePath);

        const now = Date.now();
        const ttlMs = resolveTtlForType(assetType, options.ttlMs);
        const expiresAt = now + ttlMs;

        try {
            // 1. Quota check & eviction
            const currentTotal = this.getTotalSizeBytes();
            if (currentTotal + sizeBytes > this.maxQuotaBytes) {
                this.evictIfOverQuota(this.maxQuotaBytes - sizeBytes);
            }

            // 2. Ensure dir & write file safely
            this._ensureDirectory();
            const fileExistedBefore = fs.existsSync(fullPath);
            let newlyCreatedFile = false;
            if (!fileExistedBefore) {
                const tempPath = `${fullPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
                fs.writeFileSync(tempPath, buffer);
                fs.renameSync(tempPath, fullPath);
                newlyCreatedFile = true;
            }

            // 3. Upsert SQLite metadata
            try {
                const stmt = this.db.prepare(`
                    INSERT INTO asset_cache (
                        asset_key, asset_type, relative_path, mime_type,
                        size_bytes, sha256, source_url, created_at,
                        last_used_at, expires_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(asset_key) DO UPDATE SET
                        asset_type = excluded.asset_type,
                        relative_path = excluded.relative_path,
                        mime_type = excluded.mime_type,
                        size_bytes = excluded.size_bytes,
                        sha256 = excluded.sha256,
                        source_url = excluded.source_url,
                        last_used_at = excluded.last_used_at,
                        expires_at = excluded.expires_at
                `);

                stmt.run(
                    String(assetKey),
                    String(assetType),
                    relativePath,
                    mimeType,
                    sizeBytes,
                    sha256,
                    options.sourceUrl ? String(options.sourceUrl) : null,
                    now,
                    now,
                    expiresAt
                );
            } catch (dbErr) {
                if (newlyCreatedFile && fs.existsSync(fullPath)) {
                    try { fs.unlinkSync(fullPath); } catch (_) {}
                }
                throw dbErr;
            }

            return {
                key: assetKey,
                relativePath,
                sha256,
                sizeBytes,
                filePath: fullPath
            };
        } catch (err) {
            console.error(`[ASSET_CACHE] ⚠️ Failed to set asset ${assetKey}: ${err.message}`);
            return null;
        }
    }

    deleteAsset(assetKey) {
        if (!assetKey) return false;
        if (this.touchBuffer) {
            this.touchBuffer.delete(String(assetKey));
        }
        try {
            const row = this.db.prepare("SELECT relative_path, sha256 FROM asset_cache WHERE asset_key = ?").get(String(assetKey));
            if (!row) return false;

            // Check if any other key references the same relative_path (deduplication check)
            const sharing = this.db.prepare("SELECT count(*) as cnt FROM asset_cache WHERE relative_path = ? AND asset_key != ?").get(row.relative_path, String(assetKey));
            if (!sharing || sharing.cnt === 0) {
                const fullPath = path.join(this.assetDir, row.relative_path);
                if (fs.existsSync(fullPath)) {
                    try {
                        fs.unlinkSync(fullPath);
                    } catch (_) {}
                }
            }

            const res = this.db.prepare("DELETE FROM asset_cache WHERE asset_key = ?").run(String(assetKey));
            return res.changes > 0;
        } catch (err) {
            console.error(`[ASSET_CACHE] ⚠️ Error deleting asset ${assetKey}: ${err.message}`);
            return false;
        }
    }

    getTotalSizeBytes() {
        try {
            const row = this.db.prepare(`
                SELECT COALESCE(SUM(size_bytes), 0) as total
                FROM (
                    SELECT relative_path, MAX(size_bytes) as size_bytes
                    FROM asset_cache
                    GROUP BY relative_path
                )
            `).get();
            return row ? Number(row.total) : 0;
        } catch (_) {
            return 0;
        }
    }

    evictIfOverQuota(targetMaxBytes = this.maxQuotaBytes) {
        const stats = {
            expiredDeleted: 0,
            lruDeleted: 0,
            bytesFreed: 0
        };

        try {
            const now = Date.now();

            // Step 1: Evict expired assets
            const expiredRows = this.db.prepare("SELECT asset_key, relative_path, size_bytes FROM asset_cache WHERE expires_at <= ?").all(now);
            for (const row of expiredRows) {
                if (this.deleteAsset(row.asset_key)) {
                    stats.expiredDeleted++;
                    stats.bytesFreed += row.size_bytes;
                }
            }

            // Step 2: If still over target, flush pending touches and evict LRU (least recently used)
            this.flushTouches();
            let currentTotal = this.getTotalSizeBytes();
            if (currentTotal > targetMaxBytes) {
                const lruRows = this.db.prepare("SELECT asset_key, relative_path, size_bytes FROM asset_cache ORDER BY last_used_at ASC").all();
                for (const row of lruRows) {
                    if (currentTotal <= targetMaxBytes) break;
                    if (this.deleteAsset(row.asset_key)) {
                        stats.lruDeleted++;
                        stats.bytesFreed += row.size_bytes;
                        currentTotal -= row.size_bytes;
                    }
                }
            }
        } catch (err) {
            console.error(`[ASSET_CACHE] ⚠️ Error during quota eviction: ${err.message}`);
        }

        return stats;
    }

    reconcileOrphans() {
        const stats = {
            orphanFilesRemoved: 0,
            orphanRowsRemoved: 0
        };

        try {
            // 1. Check orphan files on disk not referenced in SQLite
            if (fs.existsSync(this.assetDir)) {
                const filesOnDisk = fs.readdirSync(this.assetDir);
                const dbPaths = new Set(this.db.prepare("SELECT DISTINCT relative_path FROM asset_cache").all().map(r => r.relative_path));

                for (const file of filesOnDisk) {
                    if (!dbPaths.has(file)) {
                        try {
                            fs.unlinkSync(path.join(this.assetDir, file));
                            stats.orphanFilesRemoved++;
                        } catch (_) {}
                    }
                }
            }

            // 2. Check orphan rows in SQLite whose files do not exist on disk
            const allRows = this.db.prepare("SELECT asset_key, relative_path FROM asset_cache").all();
            for (const row of allRows) {
                const fullPath = path.join(this.assetDir, row.relative_path);
                if (!fs.existsSync(fullPath)) {
                    this.db.prepare("DELETE FROM asset_cache WHERE asset_key = ?").run(row.asset_key);
                    stats.orphanRowsRemoved++;
                }
            }
        } catch (err) {
            console.error(`[ASSET_CACHE] ⚠️ Error during orphan reconciliation: ${err.message}`);
        }

        return stats;
    }

    getStats() {
        try {
            const totalBytes = this.getTotalSizeBytes();
            const countRow = this.db.prepare("SELECT COUNT(*) as count FROM asset_cache").get();
            const count = countRow ? countRow.count : 0;
            return {
                count,
                totalBytes,
                totalMb: (totalBytes / (1024 * 1024)).toFixed(2),
                maxQuotaBytes: this.maxQuotaBytes,
                maxQuotaMb: (this.maxQuotaBytes / (1024 * 1024)).toFixed(0),
                percentUsed: ((totalBytes / this.maxQuotaBytes) * 100).toFixed(1),
                assetDir: this.assetDir
            };
        } catch (err) {
            return {
                count: 0,
                totalBytes: 0,
                totalMb: "0.00",
                maxQuotaBytes: this.maxQuotaBytes,
                maxQuotaMb: "500",
                percentUsed: "0.0",
                assetDir: this.assetDir,
                error: err.message
            };
        }
    }

    getCacheStats() {
        return this.getStats();
    }
}

const assetManagerInstances = new WeakMap();
let defaultAssetCacheManager = null;

function getAssetCacheManager(db = null, options = {}) {
    if (db) {
        if (!assetManagerInstances.has(db)) {
            assetManagerInstances.set(db, new AssetCacheManager(db, options));
        }
        return assetManagerInstances.get(db);
    }
    if (!defaultAssetCacheManager) {
        defaultAssetCacheManager = new AssetCacheManager(null, options);
    }
    return defaultAssetCacheManager;
}

module.exports = {
    AssetCacheManager,
    getAssetCacheManager,
    resolveAssetDir
};
