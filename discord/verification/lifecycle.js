"use strict";

const GuildConfig = require("./models/GuildConfig");
const IPRevealRequest = require("./models/IPRevealRequest");
const IpIdentityLink = require("./models/IpIdentityLink");
const VerifyLog = require("./models/VerifyLog");
const { safeError } = require("./utils/safeLogger");
const {
    cleanupSnapshotGarbage,
    getSnapshotCleanupConfig
} = require("./services/snapshotCleanup");
const {
    getOAuthRefreshConfig,
    refreshPersistedOAuthTokens
} = require("./utils/oauthTokenLifecycle");
const {
    runAutomaticMigration,
    config: getAutomaticMigrationConfig
} = require("./services/automaticMigration");
const {
    migrateLegacyHistory,
    migrateVerifyLogHistory
} = require("./services/ipIdentityHistoryService");

const RETENTION_CONFIG_SCAN_MAX = Math.max(
    50,
    Number(process.env.RETENTION_CONFIG_SCAN_MAX || 1000) || 1000
);
const RETENTION_ERROR_MAX = Math.max(
    5,
    Number(process.env.RETENTION_ERROR_MAX || 50) || 50
);
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

let maintenanceTimer = null;
let maintenanceClearInterval = clearInterval;
let runtimeStartPromise = null;
let maintenanceInFlight = false;
let lastRunAt = null;
let lastStartedAt = null;
let lastFinishedAt = null;
let lastSuccessAt = null;
let lastDurationMs = null;
let lastError = null;
let lastSummary = null;
let lastOAuthRefreshAt = null;
let lastOAuthRefreshError = null;
let lastOAuthRefreshSummary = null;
let runCount = 0;
let failCount = 0;
let maintenanceWaiters = [];
let retentionCursor = null;
let lastAutomaticMigrationAt = null;
let lastAutomaticMigrationError = null;
let lastAutomaticMigrationSummary = null;

function resolveMaintenanceWaiters() {
    if (maintenanceInFlight) return;
    const waiters = maintenanceWaiters;
    maintenanceWaiters = [];
    for (const resolve of waiters) resolve();
}

function waitForMaintenanceIdle() {
    if (!maintenanceInFlight) return Promise.resolve();
    return new Promise(resolve => maintenanceWaiters.push(resolve));
}

function retentionDays(mode) {
    const value = String(mode || "").toLowerCase();
    if (["30d", "rolling_30d", "delete_after_30d"].includes(value)) return 30;
    if (["90d", "rolling_90d", "delete_after_90d"].includes(value)) return 90;
    if (["180d", "rolling_180d", "delete_after_180d"].includes(value)) return 180;
    return null;
}

function createSummary(dryRun, now) {
    return {
        dryRun,
        skipped: false,
        startedAt: now,
        finishedAt: null,
        expiredRevealRequests: 0,
        guildsScanned: 0,
        guildsWithRetention: 0,
        retentionCursorWrapped: false,
        verifyLogs: 0,
        ipIdentityLinks: 0,
        snapshotCleanup: null,
        automaticMigration: null,
        ipIdentityHistoryMigration: null,
        ipIdentityVerifyLogMigration: null,
        errors: []
    };
}

async function runAutomaticMigrationSafe(dryRun, summary) {
    try {
        summary.automaticMigration = await runAutomaticMigration({ dryRun });
        if (!dryRun) {
            lastAutomaticMigrationAt = Date.now();
            lastAutomaticMigrationSummary = summary.automaticMigration;
            lastAutomaticMigrationError = null;
        }
    } catch (err) {
        const error = safeError(err);
        summary.automaticMigration = { failed: true, error };
        summary.errors.push({ subsystem: "automatic_migration", error });
        if (!dryRun) {
            lastAutomaticMigrationAt = Date.now();
            lastAutomaticMigrationError = error;
        }
    }
}

async function runSnapshotCleanup(dryRun, summary) {
    try {
        summary.snapshotCleanup = await cleanupSnapshotGarbage({ dryRun });
    } catch (err) {
        summary.snapshotCleanup = {
            mode: "permanent_history",
            dryRun,
            failed: true,
            error: safeError(err)
        };
        summary.errors.push({ subsystem: "snapshot_cleanup", error: safeError(err) });
    }
}

async function runIpIdentityHistoryMigration(dryRun, summary) {
    if (dryRun) {
        summary.ipIdentityHistoryMigration = { skipped: true, reason: "dry_run" };
        return;
    }
    try {
        summary.ipIdentityHistoryMigration = await migrateLegacyHistory();
    } catch (err) {
        const error = safeError(err);
        summary.ipIdentityHistoryMigration = { failed: true, error };
        summary.errors.push({ subsystem: "ip_identity_history_migration", error });
    }
}

async function runIpIdentityVerifyLogMigration(dryRun, summary) {
    if (dryRun) {
        summary.ipIdentityVerifyLogMigration = { skipped: true, reason: "dry_run" };
        return;
    }
    try {
        summary.ipIdentityVerifyLogMigration = await migrateVerifyLogHistory();
    } catch (err) {
        const error = safeError(err);
        summary.ipIdentityVerifyLogMigration = { failed: true, error };
        summary.errors.push({ subsystem: "ip_identity_verify_log_migration", error });
    }
}

async function loadRetentionConfigs(dryRun, summary) {
    const filter = !dryRun && retentionCursor
        ? { _id: { $gt: retentionCursor } }
        : {};
    let configs = await GuildConfig.find(filter)
        .select("guildId security.retentionMode")
        .sort({ _id: 1 })
        .limit(RETENTION_CONFIG_SCAN_MAX)
        .lean();

    if (!dryRun && retentionCursor && configs.length === 0) {
        retentionCursor = null;
        summary.retentionCursorWrapped = true;
        configs = await GuildConfig.find({})
            .select("guildId security.retentionMode")
            .sort({ _id: 1 })
            .limit(RETENTION_CONFIG_SCAN_MAX)
            .lean();
    }

    if (!dryRun) {
        retentionCursor = configs.length >= RETENTION_CONFIG_SCAN_MAX
            ? configs.at(-1)?._id || null
            : null;
    }
    return configs;
}

async function expirePendingRevealRequests(now, dryRun) {
    const filter = { status: "pending", expiresAt: { $lte: now } };
    if (dryRun) return IPRevealRequest.countDocuments(filter);

    const result = await IPRevealRequest.updateMany(filter, {
        $set: {
            status: "expired",
            updatedAt: now,
            ownerNote: "expired automatically"
        }
    });
    return result.modifiedCount || 0;
}

function retentionFilters(guildId, cutoff) {
    return {
        verify: {
            guildId,
            deletedAt: { $exists: false },
            $or: [
                { verifiedAt: { $lt: cutoff } },
                { createdAt: { $lt: cutoff } }
            ]
        },
        identity: {
            guildId,
            deletedAt: { $exists: false },
            lastSeenAt: { $lt: cutoff }
        }
    };
}

async function processGuildRetention(config, { now, dryRun, summary }) {
    const mode = config.security?.retentionMode;
    const days = retentionDays(mode);
    if (!days) return;

    summary.guildsWithRetention++;
    const filters = retentionFilters(config.guildId, now - days * DAY_MS);

    try {
        if (dryRun) {
            const [verifyLogs, ipIdentityLinks] = await Promise.all([
                VerifyLog.countDocuments(filters.verify),
                IpIdentityLink.countDocuments(filters.identity)
            ]);
            summary.verifyLogs += verifyLogs;
            summary.ipIdentityLinks += ipIdentityLinks;
            return;
        }

        const deletedBy = `retention:${mode || "unknown"}`;
        const [verifyLogs, ipIdentityLinks] = await Promise.all([
            VerifyLog.updateMany(filters.verify, {
                $set: { deletedAt: now, deletedBy }
            }),
            IpIdentityLink.updateMany(filters.identity, {
                $set: { deletedAt: now, deletedBy, updatedAt: now }
            })
        ]);
        summary.verifyLogs += verifyLogs.modifiedCount || 0;
        summary.ipIdentityLinks += ipIdentityLinks.modifiedCount || 0;
    } catch (err) {
        summary.errors.push({
            guildId: config.guildId,
            retentionMode: mode || "unknown",
            error: safeError(err)
        });
        if (summary.errors.length > RETENTION_ERROR_MAX) {
            summary.errors.splice(0, summary.errors.length - RETENTION_ERROR_MAX);
        }
    }
}

async function runVerificationMaintenance(options = {}) {
    if (maintenanceInFlight) {
        return { skipped: true, reason: "maintenance_in_flight" };
    }

    maintenanceInFlight = true;
    const now = Date.now();
    const dryRun = options.dryRun === true;
    if (!dryRun) {
        lastError = null;
        lastStartedAt = now;
    }
    const summary = createSummary(dryRun, now);

    try {
        summary.expiredRevealRequests = await expirePendingRevealRequests(now, dryRun);
        await runAutomaticMigrationSafe(dryRun, summary);
        await runIpIdentityHistoryMigration(dryRun, summary);
        await runIpIdentityVerifyLogMigration(dryRun, summary);
        await runSnapshotCleanup(dryRun, summary);
        const configs = await loadRetentionConfigs(dryRun, summary);
        summary.guildsScanned = configs.length;
        summary.truncated = configs.length >= RETENTION_CONFIG_SCAN_MAX;
        summary.maxGuilds = RETENTION_CONFIG_SCAN_MAX;

        for (const config of configs) {
            await processGuildRetention(config, { now, dryRun, summary });
        }

        if (!dryRun) {
            try {
                lastOAuthRefreshSummary = await refreshPersistedOAuthTokens();
                lastOAuthRefreshAt = Date.now();
                lastOAuthRefreshError = null;
            } catch (err) {
                lastOAuthRefreshError = safeError(err);
            }
        }

        summary.finishedAt = Date.now();
        summary.durationMs = summary.finishedAt - summary.startedAt;
        if (!dryRun) {
            lastFinishedAt = summary.finishedAt;
            lastDurationMs = summary.durationMs;
            lastRunAt = summary.finishedAt;
            lastSuccessAt = summary.finishedAt;
            lastSummary = summary;
            runCount++;
        }
        return summary;
    } catch (err) {
        if (!dryRun) {
            lastError = safeError(err);
            lastFinishedAt = Date.now();
            lastDurationMs = lastFinishedAt - now;
            failCount++;
        }
        throw err;
    } finally {
        maintenanceInFlight = false;
        resolveMaintenanceWaiters();
    }
}

async function startVerificationRuntime(options = {}) {
    if (maintenanceTimer) return getVerificationDiagnostics();
    if (runtimeStartPromise) return runtimeStartPromise;
    const maintenanceRunner = options.maintenanceRunner || runVerificationMaintenance;
    const createInterval = options.setIntervalFn || setInterval;
    maintenanceClearInterval = options.clearIntervalFn || clearInterval;
    runtimeStartPromise = (async () => {
        await maintenanceRunner();
        if (!maintenanceTimer) {
            maintenanceTimer = createInterval(() => {
                maintenanceRunner().catch(err => {
                    lastError = safeError(err);
                    console.error("[VERIFICATION] maintenance failed:", lastError);
                });
            }, MAINTENANCE_INTERVAL_MS);
            maintenanceTimer.unref?.();
        }
        return getVerificationDiagnostics();
    })().finally(() => {
        runtimeStartPromise = null;
    });
    return runtimeStartPromise;
}

async function stopVerificationRuntime() {
    if (runtimeStartPromise) await runtimeStartPromise.catch(() => {});
    if (maintenanceTimer) maintenanceClearInterval(maintenanceTimer);
    maintenanceTimer = null;
    maintenanceClearInterval = clearInterval;
    await waitForMaintenanceIdle();
}

function getVerificationDiagnostics() {
    return {
        ready: lastRunAt !== null && !lastError,
        timerActive: !!maintenanceTimer,
        inFlight: maintenanceInFlight,
        lastRunAt,
        lastStartedAt,
        lastFinishedAt,
        lastSuccessAt,
        lastDurationMs,
        runCount,
        failCount,
        lastError,
        lastSummary,
        retentionCursor: retentionCursor ? String(retentionCursor) : null,
        snapshotCleanup: {
            config: getSnapshotCleanupConfig(),
            lastSummary: lastSummary?.snapshotCleanup || null
        },
        automaticMigration: {
            config: getAutomaticMigrationConfig(),
            lastRunAt: lastAutomaticMigrationAt,
            lastError: lastAutomaticMigrationError,
            lastSummary: lastAutomaticMigrationSummary
        },
        oauthTokenRefresh: {
            config: getOAuthRefreshConfig(),
            lastRunAt: lastOAuthRefreshAt,
            lastError: lastOAuthRefreshError,
            lastSummary: lastOAuthRefreshSummary
        }
    };
}

module.exports = {
    startVerificationRuntime,
    stopVerificationRuntime,
    runVerificationMaintenance,
    getVerificationDiagnostics,
    waitForMaintenanceIdle,
    retentionDays,
    retentionFilters
};
