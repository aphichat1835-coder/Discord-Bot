"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { getFilesystemFreeSpace } = require("./quota");

function isPathInside(childPath, parentPath) {
    const relative = path.relative(parentPath, childPath);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isUnderPath(childPath, targetPath) {
    if (!childPath || !targetPath) return false;
    const resolvedChild = path.resolve(childPath);
    const resolvedTarget = path.resolve(targetPath);
    return resolvedChild === resolvedTarget || isPathInside(resolvedChild, resolvedTarget);
}

function checkPhysicalPersistentMount() {
    try {
        if (fs.existsSync("/persistent")) {
            fs.accessSync("/persistent", fs.constants.R_OK | fs.constants.W_OK);
            return true;
        }
    } catch (_) {}
    return false;
}

function resolveStorageDefaults(hasPhysicalMount, repoRoot, isTempDb, isMemory, options) {
    const defaultDbPath = hasPhysicalMount ? "/persistent/discordbot.sqlite" : path.join(repoRoot, "data", "discordbot.sqlite");
    let defaultBackupDir = hasPhysicalMount ? "/persistent/backups" : path.join(repoRoot, "backups");
    let defaultAssetDir = hasPhysicalMount ? "/persistent/cache-assets" : path.join(repoRoot, "data", "cache-assets");

    if (isTempDb || isMemory) {
        if (!options.backupDir && !process.env.SQLITE_BACKUP_DIR) {
            defaultBackupDir = path.join(os.tmpdir(), "backups");
        }
        if (!options.assetDir && !process.env.SQLITE_ASSET_DIR) {
            defaultAssetDir = path.join(os.tmpdir(), "cache-assets");
        }
    }
    return { defaultDbPath, defaultBackupDir, defaultAssetDir };
}

function resolveStoragePaths(options, repoRoot) {
    const hasPhysicalMount = checkPhysicalPersistentMount();
    const defaultDb = hasPhysicalMount ? "/persistent/discordbot.sqlite" : path.join(repoRoot, "data", "discordbot.sqlite");
    const rawDbPath = options.dbPath || process.env.SQLITE_DB_PATH || defaultDb;
    const isMemory = rawDbPath === ":memory:";
    const isTempDb = typeof rawDbPath === "string" && rawDbPath.startsWith(os.tmpdir());

    const { defaultBackupDir, defaultAssetDir } = resolveStorageDefaults(hasPhysicalMount, repoRoot, isTempDb, isMemory, options);
    const rawBackupDir = options.backupDir || process.env.SQLITE_BACKUP_DIR || defaultBackupDir;
    const rawAssetDir = options.assetDir || process.env.SQLITE_ASSET_DIR || defaultAssetDir;

    const resolvedDbPath = isMemory ? ":memory:" : path.resolve(rawDbPath);
    const resolvedDbDir = isMemory ? os.tmpdir() : path.dirname(resolvedDbPath);
    const resolvedBackupDir = path.resolve(rawBackupDir);
    const resolvedAssetDir = path.resolve(rawAssetDir);

    const dbInSource = !isMemory && isPathInside(resolvedDbPath, repoRoot);
    const backupInSource = isPathInside(resolvedBackupDir, repoRoot);
    const assetInSource = isPathInside(resolvedAssetDir, repoRoot);

    const explicitDbPath = Boolean(options.dbPath || process.env.SQLITE_DB_PATH?.trim());
    const explicitBackupDir = Boolean(options.backupDir || process.env.SQLITE_BACKUP_DIR?.trim());
    const explicitAssetDir = Boolean(options.assetDir || process.env.SQLITE_ASSET_DIR?.trim());

    return {
        hasPhysicalMount,
        isMemory,
        resolvedDbPath,
        resolvedDbDir,
        resolvedBackupDir,
        resolvedAssetDir,
        dbInSource,
        backupInSource,
        assetInSource,
        hasInSource: dbInSource || backupInSource || assetInSource,
        explicitDbPath,
        explicitBackupDir,
        explicitAssetDir
    };
}

function classifyPersistence(pathsInfo, isProduction) {
    const {
        hasPhysicalMount,
        hasInSource,
        resolvedDbPath,
        resolvedBackupDir,
        resolvedAssetDir,
        explicitDbPath,
        explicitBackupDir,
        explicitAssetDir
    } = pathsInfo;

    const isAutoDetectedPersistent = hasPhysicalMount && !hasInSource && (
        isUnderPath(resolvedDbPath, "/persistent") &&
        isUnderPath(resolvedBackupDir, "/persistent") &&
        isUnderPath(resolvedAssetDir, "/persistent")
    );

    const missingExplicitEnvs = [];
    if (!explicitDbPath && !isAutoDetectedPersistent) missingExplicitEnvs.push("SQLITE_DB_PATH");
    if (!explicitBackupDir && !isAutoDetectedPersistent) missingExplicitEnvs.push("SQLITE_BACKUP_DIR");
    if (!explicitAssetDir && !isAutoDetectedPersistent) missingExplicitEnvs.push("SQLITE_ASSET_DIR");

    const configuredPersistentPath = !hasInSource && (missingExplicitEnvs.length === 0 || isAutoDetectedPersistent || !isProduction);
    const persistenceConfirmed = Boolean(
        isAutoDetectedPersistent ||
        process.env.SQLITE_PERSISTENCE_CONFIRMED === "true" ||
        process.env.PERSISTENT_STORAGE_CONFIRMED === "true"
    );
    const persistentMountVerified = isAutoDetectedPersistent || (configuredPersistentPath && persistenceConfirmed);

    let persistenceStatus = "unverified";
    if (isAutoDetectedPersistent) {
        persistenceStatus = "verified";
    } else if (configuredPersistentPath && persistenceConfirmed) {
        persistenceStatus = "operator_attested";
    }

    return {
        isAutoDetectedPersistent,
        missingExplicitEnvs,
        configuredPersistentPath,
        persistenceConfirmed,
        persistentMountVerified,
        persistenceStatus,
        isPersistent: configuredPersistentPath
    };
}

function assessPlacementWarnings(pathsInfo, persistenceInfo, isProduction, allowInSource, repoRoot) {
    const { dbInSource, backupInSource, assetInSource, hasInSource } = pathsInfo;
    const { configuredPersistentPath, missingExplicitEnvs } = persistenceInfo;

    const inSourceNames = [];
    if (dbInSource) inSourceNames.push("database");
    if (backupInSource) inSourceNames.push("backup");
    if (assetInSource) inSourceNames.push("asset-cache");

    const errors = [];
    const warnings = [];

    if (configuredPersistentPath) {
        return { persistentRecommended: false, pathWarning: false, warnings: [], errors: [] };
    }

    if (allowInSource) {
        return {
            persistentRecommended: true,
            pathWarning: false,
            warnings: [`[STORAGE] ℹ️ ALLOW_IN_SOURCE_STORAGE=true is active. Local in-source paths [${inSourceNames.join(", ") || "default"}] are permitted by owner override.`],
            errors: []
        };
    }

    if (isProduction) {
        const missingDetails = missingExplicitEnvs.length > 0 ? `Missing explicit external path ENV(s): [${missingExplicitEnvs.join(", ")}]. ` : "";
        const sourceDetails = inSourceNames.length > 0 ? `Storage path(s) [${inSourceNames.join(", ")}] reside inside source directory (${repoRoot}). ` : "";
        const warnMsg = `[PRODUCTION_STORAGE] ⚠️ Production storage is not using verified external persistent mount. ${missingDetails}${sourceDetails}In containerized production (Pterodactyl/Docker/VPS), data may be lost on container rebuild or redeploy unless external persistent mounts (e.g. /persistent/...) are configured or ALLOW_IN_SOURCE_STORAGE=true is explicitly set.`;
        warnings.push(warnMsg);

        if (hasInSource) {
            const fatalMsg = `[PRODUCTION_STORAGE] ❌ In production mode, SQLite storage must not reside inside source tree (${repoRoot}) without explicit operator override ALLOW_IN_SOURCE_STORAGE=true. (Mount external volume e.g. /persistent/... or configure explicit external paths SQLITE_DB_PATH, SQLITE_BACKUP_DIR, SQLITE_ASSET_DIR).`;
            errors.push(fatalMsg);
        }
        return { persistentRecommended: true, pathWarning: true, warnings, errors };
    }

    const msg = `[STORAGE] ℹ️ Storage path(s) [${inSourceNames.join(", ") || "default"}] reside in local workspace. Ensure persistent volumes are mounted before deploying to production.`;
    return { persistentRecommended: true, pathWarning: true, warnings: [msg], errors: [] };
}

function probeDirectoryPermissions(targetDirs, repoRoot) {
    const permissions = {};
    const errors = [];
    const warnings = [];
    let readable = true;
    let writable = true;
    let filesystemCritical = false;

    for (const target of targetDirs) {
        try {
            if (!fs.existsSync(target.dir)) {
                fs.mkdirSync(target.dir, { recursive: true });
            }
            fs.accessSync(target.dir, fs.constants.R_OK | fs.constants.W_OK);

            const probeFile = path.join(target.dir, `.__perm_probe_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`);
            fs.writeFileSync(probeFile, "probe");
            fs.unlinkSync(probeFile);

            permissions[target.key] = { readable: true, writable: true };
        } catch (err) {
            if (err.code === "EROFS" && isPathInside(target.dir, repoRoot)) {
                permissions[target.key] = { readable: true, writable: false, readOnly: true };
                warnings.push(`[STORAGE] ℹ️ In-source ${target.name} (${target.dir}) is mounted read-only in this environment.`);
                continue;
            }
            readable = false;
            writable = false;
            filesystemCritical = true;
            permissions[target.key] = { readable: false, writable: false, error: err.message };
            errors.push(`[STORAGE] ❌ Filesystem write failure on ${target.name} (${target.dir}): ${err.message}`);
        }
    }

    return { permissions, errors, warnings, readable, writable, filesystemCritical };
}

function checkVolumeSpaces(targetDirs, permissions) {
    const volumes = {};
    const errors = [];
    const warnings = [];
    let filesystemWarning = false;
    let filesystemCritical = false;

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
                readable: permissions[target.key]?.readable ?? true,
                writable: permissions[target.key]?.writable ?? true,
                warning: false,
                critical: false,
                status: "ok"
            };

            if (space.availableMb !== null) {
                if (space.availableMb < 100) {
                    vol.critical = true;
                    vol.status = "critical";
                    filesystemCritical = true;
                    errors.push(`[STORAGE] ❌ Critically low disk space on ${target.name} (${target.dir}): ${space.availableMb} MB available (< 100 MB threshold).`);
                } else if (space.availableMb < 1000) {
                    vol.warning = true;
                    vol.status = "warning";
                    filesystemWarning = true;
                    warnings.push(`[STORAGE] ⚠️ Low free disk space on ${target.name} (${target.dir}): ${space.availableMb} MB available (< 1,000 MB recommended).`);
                }
            }

            volumes[target.key] = vol;
        } catch (err) {
            warnings.push(`[STORAGE] ⚠️ Could not evaluate free filesystem space on ${target.name}: ${err.message}`);
        }
    }

    return { volumes, errors, warnings, filesystemWarning, filesystemCritical };
}

function evaluateStoragePaths(options = {}) {
    const isProduction = (options.env || process.env.NODE_ENV) === "production";
    const repoRoot = path.resolve(process.cwd());
    const allowInSource = options.allowInSource !== undefined ? Boolean(options.allowInSource) : process.env.ALLOW_IN_SOURCE_STORAGE === "true";

    const pathsInfo = resolveStoragePaths(options, repoRoot);
    const persistenceInfo = classifyPersistence(pathsInfo, isProduction);
    const placementWarnings = assessPlacementWarnings(pathsInfo, persistenceInfo, isProduction, allowInSource, repoRoot);

    const targetDirs = [
        { name: "Database Directory", dir: pathsInfo.resolvedDbDir, key: "database" },
        { name: "Backup Directory", dir: pathsInfo.resolvedBackupDir, key: "backup" },
        { name: "Asset Cache Directory", dir: pathsInfo.resolvedAssetDir, key: "assetCache" }
    ];

    const probeResult = probeDirectoryPermissions(targetDirs, repoRoot);
    const spaceResult = checkVolumeSpaces(targetDirs, probeResult.permissions);

    const errors = [...placementWarnings.errors, ...probeResult.errors, ...spaceResult.errors];
    const warnings = [...placementWarnings.warnings, ...probeResult.warnings, ...spaceResult.warnings];

    const results = {
        ok: errors.length === 0,
        isProduction,
        isPersistent: persistenceInfo.isPersistent,
        persistenceStatus: persistenceInfo.persistenceStatus,
        configuredPersistentPath: persistenceInfo.configuredPersistentPath,
        persistentMountVerified: persistenceInfo.persistentMountVerified,
        persistenceConfirmed: persistenceInfo.persistenceConfirmed,
        allowInSource,
        missingExplicitEnvs: persistenceInfo.missingExplicitEnvs,
        hasInSource: pathsInfo.hasInSource,
        errors,
        warnings,
        pathWarning: placementWarnings.pathWarning,
        filesystemWarning: spaceResult.filesystemWarning,
        filesystemCritical: probeResult.filesystemCritical || spaceResult.filesystemCritical,
        persistentRecommended: placementWarnings.persistentRecommended,
        readable: probeResult.readable,
        writable: probeResult.writable,
        paths: {
            database: { path: pathsInfo.resolvedDbPath, dir: pathsInfo.resolvedDbDir, inSource: pathsInfo.dbInSource, explicit: pathsInfo.explicitDbPath },
            backup: { path: pathsInfo.resolvedBackupDir, inSource: pathsInfo.backupInSource, explicit: pathsInfo.explicitBackupDir },
            assetCache: { path: pathsInfo.resolvedAssetDir, inSource: pathsInfo.assetInSource, explicit: pathsInfo.explicitAssetDir }
        },
        permissions: probeResult.permissions,
        volumes: spaceResult.volumes,
        freeSpace: spaceResult.volumes.database || getFilesystemFreeSpace(pathsInfo.resolvedDbDir)
    };

    return results;
}

module.exports = {
    evaluateStoragePaths,
    isPathInside,
    isUnderPath
};
