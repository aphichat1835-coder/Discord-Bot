"use strict";

const crypto = require("node:crypto");
const OAuthUser = require("../models/OAuthUser");
const MigrationArchive = require("../models/VerificationMigrationArchive");
const MigrationState = require("../models/VerificationMigrationState");
const snapshotStore = require("./oauthSnapshotStore");
const migration = require("../../../scripts/migrateVerificationSnapshots");
const { safeError } = require("../utils/safeLogger");

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
        scanMax: Math.max(1, Math.min(1000, Number(env.AUTO_VERIFICATION_MIGRATION_SCAN_MAX || DEFAULT_SCAN_MAX) || DEFAULT_SCAN_MAX)),
        batchSize: Math.max(10, Math.min(500, Number(env.VERIFICATION_MIGRATION_BATCH_SIZE || 100) || 100))
    };
}

function contentHash(document) {
    return crypto.createHash("sha256").update(JSON.stringify(document)).digest("hex");
}

async function archiveSourceDocument(sourceId, options = {}) {
    const OAuthUserModel = options.OAuthUserModel || OAuthUser;
    const ArchiveModel = options.ArchiveModel || MigrationArchive;
    const source = await OAuthUserModel.findById(sourceId).lean();
    if (!source) {
        const error = new Error("migration source document disappeared before backup");
        error.code = "migration_source_missing";
        throw error;
    }
    const hash = contentHash(source);
    const result = await ArchiveModel.updateOne({
        migrationVersion: TARGET_VERSION,
        sourceCollection: OAuthUserModel.collection?.name || "oauthusers",
        sourceId: String(source._id)
    }, {
        $setOnInsert: {
            contentHash: hash,
            payload: source,
            backedUpAt: Date.now()
        }
    }, { upsert: true });
    return { hash, created: Number(result?.upsertedCount || 0) > 0 };
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

function migrationCursor(OAuthUserModel, filter, scanMax) {
    return OAuthUserModel.find(filter)
        .select("discord connections guilds lastMember lastVerify snapshotMeta snapshotRefs")
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
        const migrateCursor = options.migrateCursor || migration.migrateCursor;
        const summary = await migrateCursor({
            cursor: migrationCursor(OAuthUserModel, filter, settings.scanMax),
            apply: true,
            batchSize: settings.batchSize,
            bulkWrite: (operations, writeOptions) => OAuthUserModel.bulkWrite(operations, writeOptions),
            snapshotWriter: options.snapshotWriter || snapshotStore.storeOAuthSnapshots,
            beforeMigrate: async doc => {
                await renewLock(StateModel, owner);
                const archived = await archiveSourceDocument(doc._id, { OAuthUserModel, ArchiveModel });
                if (archived.created) backup.created++;
                else backup.reused++;
            }
        });
        const remaining = await OAuthUserModel.countDocuments(filter);
        const finishedAt = Date.now();
        const result = { ...summary, backup, eligible, remaining, complete: remaining === 0, ...settings };
        await StateModel.updateOne({ _id: STATE_ID, lockOwner: owner }, {
            $set: {
                status: result.complete ? "complete" : "pending",
                lockOwner: null,
                lockUntil: null,
                lastFinishedAt: finishedAt,
                lastSuccessAt: finishedAt,
                lastSummary: result,
                updatedAt: finishedAt
            }
        });
        return result;
    } catch (err) {
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
        throw err;
    }
}

module.exports = {
    runAutomaticMigration,
    archiveSourceDocument,
    contentHash,
    config,
    _test: { acquireLock, renewLock, migrationCursor, TARGET_VERSION, STATE_ID }
};
