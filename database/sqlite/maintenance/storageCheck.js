"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { getFilesystemFreeSpace } = require("./quota");

function isPathInside(childPath, parentPath) {
    const relative = path.relative(parentPath, childPath);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function evaluateStoragePaths(options = {}) {
    const isProduction = (options.env || process.env.NODE_ENV) === "production";
    const repoRoot = path.resolve(process.cwd());

    // Auto-detect physical /persistent volume mount on host
    let hasPhysicalPersistentMount = false;
    try {
        if (fs.existsSync("/persistent")) {
            fs.accessSync("/persistent", fs.constants.R_OK | fs.constants.W_OK);
            hasPhysicalPersistentMount = true;
        }
    } catch (_) {}

    const defaultDbPath = hasPhysicalPersistentMount ? "/persistent/discordbot.sqlite" : path.join(repoRoot, "data", "discordbot.sqlite");
    const defaultBackupDir = hasPhysicalPersistentMount ? "/persistent/backups" : path.join(repoRoot, "backups");
    const defaultAssetDir = hasPhysicalPersistentMount ? "/persistent/cache-assets" : path.join(repoRoot, "data", "cache-assets");

    const rawDbPath = options.dbPath || process.env.SQLITE_DB_PATH || defaultDbPath;
    const rawBackupDir = options.backupDir || process.env.SQLITE_BACKUP_DIR || defaultBackupDir;
    const rawAssetDir = options.assetDir || process.env.SQLITE_ASSET_DIR || defaultAssetDir;

    const resolvedDbPath = path.resolve(rawDbPath);
    const resolvedDbDir = path.dirname(resolvedDbPath);
    const resolvedBackupDir = path.resolve(rawBackupDir);
    const resolvedAssetDir = path.resolve(rawAssetDir);

    const dbInSource = isPathInside(resolvedDbPath, repoRoot);
    const backupInSource = isPathInside(resolvedBackupDir, repoRoot);
    const assetInSource = isPathInside(resolvedAssetDir, repoRoot);
    const hasInSource = dbInSource || backupInSource || assetInSource;

    const explicitDbPath = Boolean(options.dbPath || (process.env.SQLITE_DB_PATH && process.env.SQLITE_DB_PATH.trim()));
    const explicitBackupDir = Boolean(options.backupDir || (process.env.SQLITE_BACKUP_DIR && process.env.SQLITE_BACKUP_DIR.trim()));
    const explicitAssetDir = Boolean(options.assetDir || (process.env.SQLITE_ASSET_DIR && process.env.SQLITE_ASSET_DIR.trim()));
    const allowInSource = process.env.ALLOW_IN_SOURCE_STORAGE === "true";

    const isAutoDetectedPersistent = hasPhysicalPersistentMount && !hasInSource && (
        resolvedDbPath.startsWith("/persistent") &&
        resolvedBackupDir.startsWith("/persistent") &&
        resolvedAssetDir.startsWith("/persistent")
    );

    const missingExplicitEnvs = [];
    if (!explicitDbPath && !isAutoDetectedPersistent) missingExplicitEnvs.push("SQLITE_DB_PATH");
    if (!explicitBackupDir && !isAutoDetectedPersistent) missingExplicitEnvs.push("SQLITE_BACKUP_DIR");
    if (!explicitAssetDir && !isAutoDetectedPersistent) missingExplicitEnvs.push("SQLITE_ASSET_DIR");

    // Persistent storage path is configured when no paths reside inside source tree and explicit external paths or auto-detected mount is configured
    const configuredPersistentPath = !hasInSource && (missingExplicitEnvs.length === 0 || isAutoDetectedPersistent || !isProduction);
    const persistenceConfirmed = Boolean(
        isAutoDetectedPersistent ||
        process.env.SQLITE_PERSISTENCE_CONFIRMED === "true" ||
        process.env.PERSISTENT_STORAGE_CONFIRMED === "true"
    );
    const persistentMountVerified = configuredPersistentPath && persistenceConfirmed;
    const isPersistent = configuredPersistentPath; // backward-compatibility flag

    const results = {
        ok: true,
        isProduction,
        isPersistent,
        configuredPersistentPath,
        persistentMountVerified,
        persistenceConfirmed,
        allowInSource,
        missingExplicitEnvs,
        hasInSource,
        errors: [],
        warnings: [],
        pathWarning: false,
        filesystemWarning: false,
        filesystemCritical: false,
        persistentRecommended: false,
        readable: true,
        writable: true,
        paths: {
            database: { path: resolvedDbPath, dir: resolvedDbDir, inSource: dbInSource, explicit: explicitDbPath },
            backup: { path: resolvedBackupDir, inSource: backupInSource, explicit: explicitBackupDir },
            assetCache: { path: resolvedAssetDir, inSource: assetInSource, explicit: explicitAssetDir }
        },
        permissions: {},
        freeSpace: {}
    };

    const targetDirs = [
        { name: "Database Directory", dir: resolvedDbDir, key: "database" },
        { name: "Backup Directory", dir: resolvedBackupDir, key: "backup" },
        { name: "Asset Cache Directory", dir: resolvedAssetDir, key: "assetCache" }
    ];

    // 1. Path Placement & Persistence Assessment
    if (!configuredPersistentPath) {
        results.persistentRecommended = true;
        const inSourceNames = [];
        if (dbInSource) inSourceNames.push("database");
        if (backupInSource) inSourceNames.push("backup");
        if (assetInSource) inSourceNames.push("asset-cache");

        if (allowInSource) {
            results.pathWarning = false;
            results.warnings.push(`[STORAGE] ℹ️ ALLOW_IN_SOURCE_STORAGE=true is active. Local in-source paths [${inSourceNames.join(", ") || "default"}] are permitted by owner override.`);
        } else if (isProduction) {
            results.pathWarning = true;
            const missingDetails = missingExplicitEnvs.length > 0
                ? `Missing explicit external path ENV(s): [${missingExplicitEnvs.join(", ")}]. `
                : "";
            const sourceDetails = inSourceNames.length > 0
                ? `Storage path(s) [${inSourceNames.join(", ")}] reside inside source directory (${repoRoot}). `
                : "";
            const msg = `[PRODUCTION_STORAGE] ⚠️ Production storage is not using verified external persistent mount. ${missingDetails}${sourceDetails}In containerized production (Pterodactyl/Docker/VPS), data may be lost on container rebuild or redeploy unless external persistent mounts (e.g. /persistent/...) are configured or ALLOW_IN_SOURCE_STORAGE=true is explicitly set.`;
            results.warnings.push(msg);
        } else {
            results.pathWarning = true;
            const msg = `[STORAGE] ℹ️ Storage path(s) [${inSourceNames.join(", ") || "default"}] reside in local workspace. Ensure persistent volumes are mounted before deploying to production.`;
            results.warnings.push(msg);
        }
    }

    // 2. Ensure directories exist & verify Read/Write permissions (Actual Filesystem Failure -> CRITICAL)
    for (const target of targetDirs) {
        try {
            if (!fs.existsSync(target.dir)) {
                fs.mkdirSync(target.dir, { recursive: true });
            }
            fs.accessSync(target.dir, fs.constants.R_OK | fs.constants.W_OK);

            // Write probe check: create temporary file and delete
            const probeFile = path.join(target.dir, `.__perm_probe_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
            fs.writeFileSync(probeFile, "probe");
            fs.unlinkSync(probeFile);

            results.permissions[target.key] = { readable: true, writable: true };
        } catch (err) {
            results.readable = false;
            results.writable = false;
            results.filesystemCritical = true;
            results.permissions[target.key] = { readable: false, writable: false, error: err.message };
            results.errors.push(`[STORAGE] ❌ Filesystem write failure on ${target.name} (${target.dir}): ${err.message}`);
        }
    }

    // 3. Multi-Volume Free Space Check (Database, Backup, Asset Cache)
    results.volumes = {};
    for (const target of targetDirs) {
        try {
            const space = getFilesystemFreeSpace(target.dir);
            const vol = {
                path: target.dir,
                name: target.name,
                availableBytes: space.availableBytes,
                availableMb: space.availableMb,
                totalBytes: space.totalBytes,
                totalMb: space.totalMb,
                percentFree: space.percentFree,
                readable: results.permissions[target.key]?.readable ?? true,
                writable: results.permissions[target.key]?.writable ?? true,
                warning: false,
                critical: false,
                status: "ok"
            };

            if (space.availableMb !== null) {
                if (space.availableMb < 100) {
                    vol.critical = true;
                    vol.status = "critical";
                    results.filesystemCritical = true;
                    results.errors.push(`[STORAGE] ❌ Critically low disk space on ${target.name} (${target.dir}): ${space.availableMb} MB available (< 100 MB threshold).`);
                } else if (space.availableMb < 1000) {
                    vol.warning = true;
                    vol.status = "warning";
                    results.filesystemWarning = true;
                    results.warnings.push(`[STORAGE] ⚠️ Low free disk space on ${target.name} (${target.dir}): ${space.availableMb} MB available (< 1,000 MB recommended).`);
                }
            }

            results.volumes[target.key] = vol;
        } catch (err) {
            results.warnings.push(`[STORAGE] ⚠️ Could not evaluate free filesystem space on ${target.name}: ${err.message}`);
        }
    }

    // Backward-compatibility: results.freeSpace maps to database volume
    results.freeSpace = results.volumes.database || getFilesystemFreeSpace(resolvedDbDir);

    // ok is true as long as there are no actual filesystem errors
    results.ok = results.errors.length === 0;
    return results;
}

module.exports = {
    evaluateStoragePaths,
    isPathInside
};
