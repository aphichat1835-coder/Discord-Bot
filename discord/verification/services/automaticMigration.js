"use strict";

const crypto = require("node:crypto");
const OAuthUser = require("../models/OAuthUser");
const MigrationState = require("../models/VerificationMigrationState");
const snapshotStore = require("./oauthSnapshotStore");
const { archiveSourceDocument, contentHash } = require("./migrationArchive");
const MigrationArchive = require("../models/VerificationMigrationArchive");
const migration = require("../../../scripts/migrateVerificationSnapshots");
const { safeError } = require("../utils/safeLogger");
const { readFiniteInteger } = require("../../core/numbers");

const TARGET_VERSION = 2;
const STATE_ID = "verification_oauth_snapshot_v2";
const LOCK_MS = 30 * 60 * 1000;
const DEFAULT_SCAN_MAX = 200;

function enabled(env = process.env) {
    const value = String(env.AUTO_VERIFICATION_MIGRATION ?? "true").trim().toLowerCase();
    return !["0", "false", "no", "off"].includes(value);
}

function config(env = process.env) {
    return {
        enabled: enabled(env),
        targetVersion: TARGET_VERSION,
        scanMax: readFiniteInteger(env.AUTO_VERIFICATION_MIGRATION_SCAN_MAX, { fallback: DEFAULT_SCAN_MAX, min: 1, max: 1000 }),
        batchSize: readFiniteInteger(env.VERIFICATION_MIGRATION_BATCH_SIZE, { fallback: 100, min: 10, max: 500 })
    };
}

async function acquireLock(StateModel, now, owner) {
    try {
        return await StateModel.findOneAndUpdate({
            _id: STATE_ID,
            $or: [
                { lockUntil: { $exists: false } },
                { lockUntil: null },
                { lockUntil: { $lte: now } },
                { lockOwner: owner }
            ]
        }, {
            $set: {
                targetVersion: TARGET_VERSION,
                status: "running",
                lockOwner: owner,
                lockUntil: now + LOCK_MS,
                lastStartedAt: now,
                lastError: null,
                updatedAt: now
            }
        }, { upsert: true, new: true });
    } catch (err) {
        if (err?.code === 11000) return null;
        throw err;
    }
}

function migrationCursor(OAuthUserModel, filter, scanMax, afterId = null) {
    const cursorFilter = afterId
        ? { $and: [filter, { _id: { $gt: afterId } }] }
        : filter;
    return OAuthUserModel.find(cursorFilter)
        .select("discord connections guilds lastMember lastVerify snapshotMeta snapshotRefs updatedAt")
        .sort({ _id: 1 })
        .limit(scanMax)
        .lean()
        .cursor();
}

async function renewLock(StateModel, owner) {
    const now = Date.now();
    const result = await StateModel.updateOne({ _id: STATE_ID, lockOwner: owner }, {
        $set: { lockUntil: now + LOCK_MS, updatedAt: now }
    });
    if (Number(result?.matchedCount || 0) > 0) return;
    const error = new Error("automatic migration lock was lost");
    error.code = "migration_lock_lost";
    throw error;
}

function createBatchRunner({ options, settings, OAuthUserModel, ArchiveModel, filter, StateModel, owner, backup }) {
    const migrateCursor = options.migrateCursor || migration.migrateCursor;
    return afterId => migrateCursor({
        cursor: migrationCursor(OAuthUserModel, filter, settings.scanMax, afterId),
        apply: true,
        batchSize: settings.batchSize,
        bulkWrite: (operations, writeOptions) => OAuthUserModel.bulkWrite(operations, writeOptions),
        snapshotWriter: options.snapshotWriter || snapshotStore.storeOAuthSnapshots,
        beforeMigrate: async doc => {
            await renewLock(StateModel, owner);
            const archived = await archiveSourceDocument(doc._id, {
                OAuthUserModel,
                ArchiveModel,
                migrationVersion: TARGET_VERSION
            });
            if (archived.created) backup.created++;
            else backup.reused++;
        }
    });
}

async function runCursorCycle(migrateBatch, previousCursor) {
    const first = await migrateBatch(previousCursor);
    if (!previousCursor || Number(first.scanned || 0) > 0) {
        return { summary: first, cursorWrapped: false };
    }
    return { summary: await migrateBatch(null), cursorWrapped: true };
}

async function saveMigrationSuccess(StateModel, owner, result, finishedAt) {
    await StateModel.updateOne({ _id: STATE_ID, lockOwner: owner }, {
        $set: {
            status: result.complete ? "complete" : "pending",
            lockOwner: null,
            lockUntil: null,
            lastFinishedAt: finishedAt,
            lastSuccessAt: finishedAt,
            lastSummary: result,
            cursorSourceId: result.nextCursor,
            ...(result.cursorWrapped ? { cursorWrappedAt: finishedAt } : {}),
            updatedAt: finishedAt
        }
    });
}

async function saveMigrationFailure(StateModel, owner, err) {
    const finishedAt = Date.now();
    await StateModel.updateOne({ _id: STATE_ID, lockOwner: owner }, {
        $set: {
            status: "failed",
            lockOwner: null,
            lockUntil: null,
            lastFinishedAt: finishedAt,
            lastError: safeError(err),
            updatedAt: finishedAt
        }
    }).catch(() => {});
}

async function runAutomaticMigration(options = {}) {
    const env = options.env || process.env;
    const settings = { ...config(env), ...options.settings };
    const OAuthUserModel = options.OAuthUserModel || OAuthUser;
    const ArchiveModel = options.ArchiveModel || MigrationArchive;
    const StateModel = options.StateModel || MigrationState;
    const filter = migration.migrationFilter();
    if (!settings.enabled) return { skipped: true, reason: "disabled", ...settings };

    const eligible = await OAuthUserModel.countDocuments(filter);
    if (options.dryRun === true) {
        return { skipped: false, dryRun: true, eligible, ...settings };
    }
    if (!eligible) return { skipped: true, reason: "no_legacy_documents", eligible: 0, ...settings };

    const now = Date.now();
    const owner = crypto.randomUUID();
    const lock = await acquireLock(StateModel, now, owner);
    if (!lock) return { skipped: true, reason: "migration_locked", eligible, ...settings };

    const backup = { created: 0, reused: 0 };
    try {
        const migrateBatch = createBatchRunner({
            options, settings, OAuthUserModel, ArchiveModel, filter, StateModel, owner, backup
        });
        const previousCursor = lock.cursorSourceId || null;
        const { summary, cursorWrapped } = await runCursorCycle(migrateBatch, previousCursor);
        const remaining = await OAuthUserModel.countDocuments(filter);
        const finishedAt = Date.now();
        const nextCursor = remaining === 0 ? null : (summary.lastScannedId || null);
        const result = {
            ...summary,
            backup,
            eligible,
            remaining,
            complete: remaining === 0,
            cursorWrapped,
            nextCursor,
            ...settings
        };
        await saveMigrationSuccess(StateModel, owner, result, finishedAt);
        return result;
    } catch (err) {
        await saveMigrationFailure(StateModel, owner, err);
        throw err;
    }
}

module.exports = {
    runAutomaticMigration,
    contentHash,
    config,
    _test: {
        acquireLock,
        renewLock,
        migrationCursor,
        createBatchRunner,
        runCursorCycle,
        saveMigrationSuccess,
        saveMigrationFailure,
        TARGET_VERSION,
        STATE_ID
    }
};
