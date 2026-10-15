"use strict";

const crypto = require("node:crypto");
const mongoose = require("mongoose");
const VerifyLog = require("../models/VerifyLog");
const OAuthUser = require("../models/OAuthUser");
const IpIdentityLink = require("../models/IpIdentityLink");
const IpIdentityUserHistory = require("../models/IpIdentityUserHistory");
const IpIdentityDeviceHistory = require("../models/IpIdentityDeviceHistory");
const IpIdentityRoleHistory = require("../models/IpIdentityRoleHistory");
const OAuthMemberSnapshot = require("../models/OAuthMemberSnapshot");
const OAuthMemberRoleSnapshot = require("../models/OAuthMemberRoleSnapshot");
const OAuthObjectChunkSnapshot = require("../models/OAuthObjectChunkSnapshot");
const OAuthSnapshotRecovery = require("../models/OAuthSnapshotRecovery");
const VerificationMigrationArchive = require("../models/VerificationMigrationArchive");
const VerificationRecovery = require("../models/VerificationRecovery");
const PrivacyDeletionJob = require("../models/PrivacyDeletionJob");

const MANIFEST_VERSION = 3;
const VERIFY_LOG_SENSITIVE_PATHS = Object.freeze([
    "roleId",
    "requestId",
    "oauthScope",
    "stateMode",
    "policySnapshot",
    "discordSnapshot",
    "guildSnapshot",
    "memberSnapshot",
    "joinResult",
    "roleAssignResult",
    "trackingSnapshot",
    "dataQuality",
    "snapshotRef",
    "snapshotVersion",
    "attemptedSnapshotVersion",
    "ipHistoryMigrationVersion",
    "ipHistoryMigratedAt",
    "ipInfo",
    "device"
]);

const DEFAULT_MODELS = Object.freeze({
    VerifyLog,
    OAuthUser,
    IpIdentityLink,
    IpIdentityUserHistory,
    IpIdentityDeviceHistory,
    IpIdentityRoleHistory,
    OAuthMemberSnapshot,
    OAuthMemberRoleSnapshot,
    OAuthObjectChunkSnapshot,
    OAuthSnapshotRecovery,
    VerificationMigrationArchive,
    VerificationRecovery,
    PrivacyDeletionJob
});

function resultCount(result) {
    return Number(result?.deletedCount ?? result?.modifiedCount ?? result?.matchedCount ?? 0);
}

function subjectHash(guildId, userId) {
    return crypto.createHash("sha256")
        .update(`verification-privacy-v2:${String(guildId)}:${String(userId)}`)
        .digest("hex");
}

function deletedSubjectId(hash) {
    return `deleted:${String(hash).slice(0, 32)}`;
}

function sensitiveVerifyLogUnset() {
    return Object.fromEntries(VERIFY_LOG_SENSITIVE_PATHS.map(path => [path, ""]));
}

function belongsToGuild(value, guildId) {
    return String(value?.guildId || "") === String(guildId || "");
}

function buildOAuthUserPrivacyUpdate(document, guildId, now) {
    const unset = {};
    const refs = document?.snapshotRefs && typeof document.snapshotRefs === "object"
        ? document.snapshotRefs
        : {};

    if (belongsToGuild(document?.lastMember, guildId)) unset.lastMember = "";
    if (belongsToGuild(document?.lastVerify, guildId)) {
        unset.lastVerify = "";
        unset.lastIpTracking = "";
    }
    if (belongsToGuild(refs.member, guildId)) {
        unset["snapshotRefs.member"] = "";
        unset["snapshotMeta.member"] = "";
        unset["snapshotRefs.snapshotSet"] = "";
        unset["snapshotMeta.activation"] = "";
    }

    return {
        $pull: { guilds: { id: String(guildId) } },
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
        $set: { updatedAt: now }
    };
}

function redactArchivedOAuthPayload(payload, { guildId, now }) {
    if (!payload || typeof payload !== "object") return { changed: false, payload };
    const next = structuredClone(payload);
    let changed = false;

    if (Array.isArray(next.guilds)) {
        const filtered = next.guilds.filter(guild => String(guild?.id || "") !== String(guildId));
        changed ||= filtered.length !== next.guilds.length;
        next.guilds = filtered;
    }
    if (belongsToGuild(next.lastMember, guildId)) {
        delete next.lastMember;
        changed = true;
    }
    if (belongsToGuild(next.lastVerify, guildId)) {
        delete next.lastVerify;
        delete next.lastIpTracking;
        changed = true;
    }
    if (belongsToGuild(next.snapshotRefs?.member, guildId)) {
        delete next.snapshotRefs.member;
        delete next.snapshotRefs.snapshotSet;
        if (next.snapshotMeta && typeof next.snapshotMeta === "object") {
            delete next.snapshotMeta.member;
            delete next.snapshotMeta.activation;
        }
        changed = true;
    }
    if (changed) next.updatedAt = Math.max(Number(next.updatedAt || 0), Number(now || 0));
    return { changed, payload: next };
}

function archiveContentHash(payload) {
    return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function redactMigrationArchives({ ArchiveModel, userId, guildId, requestedBy, now, session }) {
    const archives = await ArchiveModel.find({ "payload.discord.userId": String(userId) })
        .select("_id payload privacyRedactions")
        .session(session)
        .lean();
    let redacted = 0;
    for (const archive of archives) {
        const next = redactArchivedOAuthPayload(archive.payload, { guildId, now });
        if (!next.changed) continue;
        const privacyRedactions = Array.isArray(archive.privacyRedactions)
            ? archive.privacyRedactions
            : [];
        privacyRedactions.push({
            guildId: String(guildId),
            subjectHash: subjectHash(guildId, userId),
            requestedBy: String(requestedBy || "dashboard-control").slice(0, 120),
            at: now
        });
        const result = await ArchiveModel.updateOne(
            { _id: archive._id },
            {
                $set: {
                    payload: next.payload,
                    contentHash: archiveContentHash(next.payload),
                    privacyRedactions
                }
            },
            { session }
        );
        redacted += resultCount(result);
    }
    return redacted;
}

function filterLinkUserItems(items, userId) {
    return (Array.isArray(items) ? items : []).filter(item => String(item?.userId || "") !== String(userId));
}

function buildScrubbedLinkUpdate(link, userId, requestedBy, now) {
    const users = filterLinkUserItems(link.users, userId);
    const deviceFingerprints = filterLinkUserItems(link.deviceFingerprints, userId);
    const roleSnapshots = filterLinkUserItems(link.roleSnapshots, userId);
    const uniqueUsers = new Set(users.map(item => String(item?.userId || "")).filter(Boolean)).size;

    const update = {
        $set: { users, deviceFingerprints, roleSnapshots, uniqueUsers, updatedAt: now }
    };
    if (uniqueUsers === 0) {
        Object.assign(update.$set, { deletedAt: now, deletedBy: requestedBy });
        update.$unset = { encryptedRawIp: "", lastIpInfo: "", lastDevice: "" };
    } else {
        update.$unset = { deletedAt: "", deletedBy: "" };
    }
    return { update, isDeleted: uniqueUsers === 0 };
}

async function scrubIdentityLinks({ LinkModel, guildId, userId, requestedBy, now, session }) {
    const links = await LinkModel.find({
        guildId: String(guildId),
        $or: [
            { "users.userId": String(userId) },
            { "deviceFingerprints.userId": String(userId) },
            { "roleSnapshots.userId": String(userId) }
        ]
    }).session(session).lean();

    let deleted = 0;
    let updated = 0;
    for (const link of links) {
        const { update, isDeleted } = buildScrubbedLinkUpdate(link, userId, requestedBy, now);
        const result = await LinkModel.updateOne({ _id: link._id }, update, { session });
        if (isDeleted) deleted += resultCount(result);
        else updated += resultCount(result);
    }
    return { deleted, updated };
}

function createManifest() {
    return {
        schema: `privacy-deletion-v${MANIFEST_VERSION}`,
        scope: "guild_member",
        metadata: {
            preservedGlobalSnapshots: true
        },
        phases: {
            mongo: "pending",
            sqlite: "pending"
        },
        counts: {},
        verification: {
            checks: {},
            remainingReferences: null
        },
        deletedCount: 0
    };
}

function totalDeletionCount(counts = {}) {
    return Object.values(counts).reduce((sum, value) => {
        const numeric = Number(value);
        return Number.isFinite(numeric) && numeric > 0 ? sum + numeric : sum;
    }, 0);
}

async function countDocumentsWithSession(Model, filter, session) {
    let query = Model.countDocuments(filter);
    if (query && typeof query.session === "function") query = query.session(session);
    return Number(await query || 0);
}

async function verifyNoRemainingReferences({
    models,
    guildId,
    userId,
    memberVersions = [],
    session = null
}) {
    const {
        VerifyLog: VerifyLogModel,
        OAuthUser: OAuthUserModel,
        IpIdentityLink: IpIdentityLinkModel,
        IpIdentityUserHistory: IpIdentityUserHistoryModel,
        IpIdentityDeviceHistory: IpIdentityDeviceHistoryModel,
        IpIdentityRoleHistory: IpIdentityRoleHistoryModel,
        OAuthMemberSnapshot: OAuthMemberSnapshotModel,
        OAuthMemberRoleSnapshot: OAuthMemberRoleSnapshotModel,
        OAuthObjectChunkSnapshot: OAuthObjectChunkSnapshotModel,
        OAuthSnapshotRecovery: OAuthSnapshotRecoveryModel,
        VerificationMigrationArchive: VerificationMigrationArchiveModel,
        VerificationRecovery: VerificationRecoveryModel
    } = models;

    const checks = {
        verifyLogs: await countDocumentsWithSession(VerifyLogModel, { guildId, userId }, session),
        memberSnapshots: await countDocumentsWithSession(OAuthMemberSnapshotModel, { guildId, userId }, session),
        memberRoleSnapshots: memberVersions.length
            ? await countDocumentsWithSession(OAuthMemberRoleSnapshotModel, { userId, snapshotVersion: { $in: memberVersions } }, session)
            : 0,
        ipUserHistory: await countDocumentsWithSession(IpIdentityUserHistoryModel, { guildId, userId }, session),
        ipDeviceHistory: await countDocumentsWithSession(IpIdentityDeviceHistoryModel, { guildId, userId }, session),
        ipRoleHistory: await countDocumentsWithSession(IpIdentityRoleHistoryModel, { guildId, userId }, session),
        objectChunks: await countDocumentsWithSession(OAuthObjectChunkSnapshotModel, { guildId, userId }, session),
        snapshotRecovery: memberVersions.length
            ? await countDocumentsWithSession(OAuthSnapshotRecoveryModel, { userId, snapshotVersion: { $in: memberVersions } }, session)
            : 0,
        verificationRecovery: await countDocumentsWithSession(VerificationRecoveryModel, { guildId, userId }, session),
        identityLinks: await countDocumentsWithSession(IpIdentityLinkModel, {
            guildId,
            $or: [
                { "users.userId": userId },
                { "deviceFingerprints.userId": userId },
                { "roleSnapshots.userId": userId }
            ]
        }, session),
        oauthUserReferences: await countDocumentsWithSession(OAuthUserModel, {
            "discord.userId": userId,
            $or: [
                { "guilds.id": guildId },
                { "lastMember.guildId": guildId },
                { "lastVerify.guildId": guildId },
                { "snapshotRefs.member.guildId": guildId }
            ]
        }, session),
        migrationArchiveReferences: await countDocumentsWithSession(VerificationMigrationArchiveModel, {
            "payload.discord.userId": userId,
            $or: [
                { "payload.guilds.id": guildId },
                { "payload.lastMember.guildId": guildId },
                { "payload.lastVerify.guildId": guildId },
                { "payload.snapshotRefs.member.guildId": guildId }
            ]
        }, session)
    };
    return {
        checks,
        remainingReferences: Object.values(checks).reduce((sum, value) => sum + Number(value || 0), 0)
    };
}


const DEFAULT_PRIVACY_DELETION_STALE_MS = 15 * 60 * 1000;
const DEFAULT_PRIVACY_DELETION_REUSE_MS = 5 * 60 * 1000;
const ACTIVE_PRIVACY_DELETION_STATUSES = new Set(["pending", "running"]);

function deletionOperationKey(guildId, userId) {
    return crypto.createHash("sha256")
        .update(`privacy-deletion:v1:guild_member:${String(guildId)}:${String(userId)}`)
        .digest("hex");
}

function isMongoDuplicateKey(error) {
    return Number(error?.code) === 11000;
}

async function leanLatest(Model, filter) {
    let query = Model.findOne(filter);
    if (query && typeof query.sort === "function") query = query.sort({ updatedAt: -1, createdAt: -1 });
    if (query && typeof query.lean === "function") return await query.lean();
    return await query;
}

function deletionJobResult(job, reused) {
    const status = String(job?.status || "pending");
    return {
        success: true,
        jobId: String(job?.jobId || ""),
        manifest: job?.manifest && typeof job.manifest === "object" ? job.manifest : createManifest(),
        reused: reused === true,
        status,
        pending: status === "pending" || status === "running"
    };
}

async function resolveActiveOrStaleJob(Model, latest, operationKey, now, staleJobMs) {
    if (!latest || !ACTIVE_PRIVACY_DELETION_STATUSES.has(String(latest.status))) {
        return null;
    }
    const latestUpdatedAt = Number(latest.updatedAt || latest.createdAt || 0);
    const stale = !Number.isFinite(latestUpdatedAt) || latestUpdatedAt <= now - staleJobMs;
    if (!stale) {
        return { reused: true, operationKey, result: deletionJobResult(latest, true) };
    }
    await Model.updateOne(
        { jobId: latest.jobId, activeKey: operationKey, status: latest.status },
        {
            $set: {
                status: "failed",
                errorCode: "PRIVACY_DELETION_STALE",
                updatedAt: now
            },
            $unset: { activeKey: "" }
        }
    );
    return null;
}

function isCompletedJobReusable(latest, now, completedReuseMs) {
    const completedAt = Number(latest?.completedAt || 0);
    return Boolean(
        latest?.status === "completed" &&
        Number.isFinite(completedAt) &&
        completedAt > 0 &&
        completedAt >= now - completedReuseMs
    );
}

async function reservePrivacyDeletionJob({
    Model,
    guildId,
    userId,
    requestedBy,
    subjectHash: hash,
    now,
    staleJobMs,
    completedReuseMs
}) {
    const operationKey = deletionOperationKey(guildId, userId);
    let latest = await leanLatest(Model, { operationKey });

    const activeResolution = await resolveActiveOrStaleJob(Model, latest, operationKey, now, staleJobMs);
    if (activeResolution) return activeResolution;

    if (isCompletedJobReusable(latest, now, completedReuseMs)) {
        return { reused: true, operationKey, result: deletionJobResult(latest, true) };
    }

    const attempt = Math.max(1, Number(latest?.attempt || 0) + 1);
    const jobId = crypto.randomUUID();
    const job = {
        jobId,
        guildId,
        userId,
        subjectHash: hash,
        operationKey,
        activeKey: operationKey,
        attempt,
        requestedBy,
        status: "pending",
        manifestVersion: MANIFEST_VERSION,
        createdAt: now,
        updatedAt: now
    };

    try {
        await Model.create(job);
    } catch (error) {
        if (!isMongoDuplicateKey(error)) throw error;
        const active = await leanLatest(Model, { activeKey: operationKey });
        if (!active) throw error;
        return { reused: true, operationKey, result: deletionJobResult(active, true) };
    }

    return { reused: false, operationKey, jobId, attempt, result: null };
}

async function executePrivacyDeletionOperations(models, safeGuildId, safeUserId, memberVersions, dbSession) {
    const {
        IpIdentityUserHistory: IpIdentityUserHistoryModel,
        IpIdentityDeviceHistory: IpIdentityDeviceHistoryModel,
        IpIdentityRoleHistory: IpIdentityRoleHistoryModel,
        OAuthMemberSnapshot: OAuthMemberSnapshotModel,
        OAuthMemberRoleSnapshot: OAuthMemberRoleSnapshotModel,
        OAuthObjectChunkSnapshot: OAuthObjectChunkSnapshotModel,
        OAuthSnapshotRecovery: OAuthSnapshotRecoveryModel,
        VerificationRecovery: VerificationRecoveryModel
    } = models;

    const operations = [
        ["ipUserHistory", () => IpIdentityUserHistoryModel.deleteMany(
            { guildId: safeGuildId, userId: safeUserId }, { session: dbSession }
        )],
        ["ipDeviceHistory", () => IpIdentityDeviceHistoryModel.deleteMany(
            { guildId: safeGuildId, userId: safeUserId }, { session: dbSession }
        )],
        ["ipRoleHistory", () => IpIdentityRoleHistoryModel.deleteMany(
            { guildId: safeGuildId, userId: safeUserId }, { session: dbSession }
        )],
        ["memberSnapshots", () => OAuthMemberSnapshotModel.deleteMany(
            { guildId: safeGuildId, userId: safeUserId }, { session: dbSession }
        )],
        ["memberRoleSnapshots", () => memberVersions.length
            ? OAuthMemberRoleSnapshotModel.deleteMany(
                { userId: safeUserId, snapshotVersion: { $in: memberVersions } },
                { session: dbSession }
            )
            : Promise.resolve({ deletedCount: 0 })],
        ["objectChunks", () => OAuthObjectChunkSnapshotModel.deleteMany(
            { userId: safeUserId, guildId: safeGuildId }, { session: dbSession }
        )],
        ["snapshotRecovery", () => memberVersions.length
            ? OAuthSnapshotRecoveryModel.deleteMany(
                { userId: safeUserId, snapshotVersion: { $in: memberVersions } },
                { session: dbSession }
            )
            : Promise.resolve({ deletedCount: 0 })]
    ];
    const counts = {};
    for (const [name, operation] of operations) {
        counts[name] = resultCount(await operation());
    }
    return counts;
}

async function executePrivacyDeletionTransaction({
    models,
    safeGuildId,
    safeUserId,
    safeRequestedBy,
    hash,
    jobId,
    operationKey,
    now,
    manifest,
    dbSession
}) {
    const {
        VerifyLog: VerifyLogModel,
        OAuthUser: OAuthUserModel,
        IpIdentityLink: IpIdentityLinkModel,
        OAuthMemberSnapshot: OAuthMemberSnapshotModel,
        VerificationMigrationArchive: VerificationMigrationArchiveModel,
        PrivacyDeletionJob: PrivacyDeletionJobModel
    } = models;

    await PrivacyDeletionJobModel.updateOne(
        { jobId, activeKey: operationKey },
        { $set: { status: "running", updatedAt: Date.now() } },
        { session: dbSession }
    );

    const memberSnapshots = await OAuthMemberSnapshotModel.find({ userId: safeUserId, guildId: safeGuildId })
        .select("snapshotVersion")
        .session(dbSession)
        .lean();
    const memberVersions = [...new Set(memberSnapshots
        .map(item => String(item?.snapshotVersion || ""))
        .filter(Boolean))];

    const verifyLogResult = await VerifyLogModel.updateMany(
        { guildId: safeGuildId, userId: safeUserId },
        {
            $set: {
                userId: deletedSubjectId(hash),
                result: "failed",
                reason: "privacy_deleted",
                findings: [],
                deletedAt: now,
                deletedBy: safeRequestedBy
            },
            $unset: sensitiveVerifyLogUnset()
        },
        { session: dbSession }
    );
    manifest.counts.verifyLogsRedacted = resultCount(verifyLogResult);

    const opCounts = await executePrivacyDeletionOperations(models, safeGuildId, safeUserId, memberVersions, dbSession);
    Object.assign(manifest.counts, opCounts);

    const identity = await scrubIdentityLinks({
        LinkModel: IpIdentityLinkModel,
        guildId: safeGuildId,
        userId: safeUserId,
        requestedBy: safeRequestedBy,
        now,
        session: dbSession
    });
    manifest.counts.ipIdentityLinksDeleted = identity.deleted;
    manifest.counts.ipIdentityLinksUpdated = identity.updated;

    const oauthDocument = await OAuthUserModel.findOne({ "discord.userId": safeUserId })
        .select("guilds lastMember lastVerify lastIpTracking snapshotMeta snapshotRefs")
        .session(dbSession)
        .lean();
    if (oauthDocument) {
        const oauthResult = await OAuthUserModel.updateOne(
            { _id: oauthDocument._id },
            buildOAuthUserPrivacyUpdate(oauthDocument, safeGuildId, now),
            { session: dbSession }
        );
        manifest.counts.oauthUserUpdated = resultCount(oauthResult);
    } else {
        manifest.counts.oauthUserUpdated = 0;
    }

    manifest.counts.migrationArchivesRedacted = await redactMigrationArchives({
        ArchiveModel: VerificationMigrationArchiveModel,
        userId: safeUserId,
        guildId: safeGuildId,
        requestedBy: safeRequestedBy,
        now,
        session: dbSession
    });

    manifest.phases.mongo = "completed";
    await PrivacyDeletionJobModel.updateOne(
        { jobId, activeKey: operationKey },
        {
            $set: {
                status: "running",
                manifest,
                updatedAt: Date.now()
            }
        },
        { session: dbSession }
    );

    return { memberVersions };
}

async function cleanupDeletionSession(dbSession, operationError, manifest, jobId, PrivacyDeletionJobModel) {
    if (!dbSession) return;
    try {
        await dbSession.endSession();
    } catch (endError) {
        const cleanupMessage = endError?.message || String(endError);
        if (operationError) {
            operationError.endSessionError = cleanupMessage;
        } else {
            manifest.metadata.sessionCleanupWarning = cleanupMessage;
            await PrivacyDeletionJobModel.updateOne(
                { jobId, status: "completed" },
                {
                    $set: {
                        "manifest.metadata.sessionCleanupWarning": cleanupMessage,
                        updatedAt: Date.now()
                    }
                }
            ).catch(() => {});
        }
    }
}

async function runMemberPrivacyDeletion({
    guildId,
    userId,
    requestedBy,
    now = Date.now(),
    models = DEFAULT_MODELS,
    mongooseInstance = mongoose,
    staleJobMs = DEFAULT_PRIVACY_DELETION_STALE_MS,
    completedReuseMs = DEFAULT_PRIVACY_DELETION_REUSE_MS
}) {
    const safeGuildId = String(guildId || "");
    const safeUserId = String(userId || "");
    const safeRequestedBy = String(requestedBy || "dashboard-control").slice(0, 120);
    const hash = subjectHash(safeGuildId, safeUserId);
    const safeStaleJobMs = Math.max(1000, Number(staleJobMs) || DEFAULT_PRIVACY_DELETION_STALE_MS);
    const safeCompletedReuseMs = Math.max(0, Number(completedReuseMs) || 0);
    const manifest = createManifest();
    const { PrivacyDeletionJob: PrivacyDeletionJobModel } = models;

    const reservation = await reservePrivacyDeletionJob({
        Model: PrivacyDeletionJobModel,
        guildId: safeGuildId,
        userId: safeUserId,
        requestedBy: safeRequestedBy,
        subjectHash: hash,
        now,
        staleJobMs: safeStaleJobMs,
        completedReuseMs: safeCompletedReuseMs
    });
    if (reservation.reused) return reservation.result;
    const { jobId, operationKey } = reservation;

    let dbSession = null;
    let operationError = null;
    let result = null;
    let txResult = null;
    try {
        dbSession = await mongooseInstance.startSession();
        try {
            await dbSession.withTransaction(async () => {
                txResult = await executePrivacyDeletionTransaction({
                    models,
                    safeGuildId,
                    safeUserId,
                    safeRequestedBy,
                    hash,
                    jobId,
                    operationKey,
                    now,
                    manifest,
                    dbSession
                });
            });
        } catch (txError) {
            if (/replica set|standalone|Transaction numbers/i.test(txError?.message || "")) {
                dbSession = null;
                txResult = await executePrivacyDeletionTransaction({
                    models,
                    safeGuildId,
                    safeUserId,
                    safeRequestedBy,
                    hash,
                    jobId,
                    operationKey,
                    now,
                    manifest,
                    dbSession: null
                });
            } else {
                throw txError;
            }
        }

        // Phase B: Execute SQLite Deletion outside Mongo transaction (idempotent step)
        try {
            const recoveryResult = await models.VerificationRecovery.deleteMany({
                guildId: safeGuildId,
                userId: safeUserId
            });
            manifest.counts.verificationRecovery = resultCount(recoveryResult);
            manifest.phases.sqlite = "completed";
        } catch (sqliteErr) {
            manifest.phases.sqlite = "failed";
            const error = new Error(`SQLite verification recovery deletion failed: ${sqliteErr.message}`);
            error.code = "PRIVACY_DELETION_SQLITE_FAILED";
            await PrivacyDeletionJobModel.updateOne(
                { jobId, activeKey: operationKey },
                {
                    $set: {
                        status: "failed",
                        errorCode: error.code,
                        manifest,
                        updatedAt: Date.now()
                    },
                    $unset: { activeKey: "" }
                }
            ).catch(() => {});
            throw error;
        }

        // Phase C: Final verification across all storages
        const verification = await verifyNoRemainingReferences({
            models,
            guildId: safeGuildId,
            userId: safeUserId,
            memberVersions: txResult?.memberVersions || [],
            session: null
        });
        manifest.verification = verification;
        manifest.deletedCount = totalDeletionCount(manifest.counts);
        if (verification.remainingReferences !== 0) {
            const error = new Error("Privacy deletion left remaining guild-scoped references");
            error.code = "PRIVACY_DELETION_INCOMPLETE";
            await PrivacyDeletionJobModel.updateOne(
                { jobId, activeKey: operationKey },
                {
                    $set: {
                        status: "failed",
                        errorCode: error.code,
                        manifest,
                        updatedAt: Date.now()
                    },
                    $unset: { activeKey: "" }
                }
            ).catch(() => {});
            throw error;
        }

        // Phase D: Atomically mark job completed
        const completedNow = Date.now();
        await PrivacyDeletionJobModel.updateOne(
            { jobId, activeKey: operationKey },
            {
                $set: {
                    userId: deletedSubjectId(hash),
                    subjectHash: hash,
                    status: "completed",
                    manifest,
                    completedAt: completedNow,
                    updatedAt: completedNow
                },
                $unset: { activeKey: "" }
            },
            dbSession ? { session: dbSession } : undefined
        );
        result = { success: true, jobId, manifest, reused: false, status: "completed", pending: false };
    } catch (error) {
        operationError = error;
        await PrivacyDeletionJobModel.updateOne(
            { jobId },
            {
                $set: {
                    status: "failed",
                    manifest,
                    errorCode: error.code || error.name || "PRIVACY_DELETION_FAILED",
                    updatedAt: Date.now()
                },
                $unset: { activeKey: "" }
            }
        ).catch(() => {});
    }

    await cleanupDeletionSession(dbSession, operationError, manifest, jobId, PrivacyDeletionJobModel);

    if (operationError) throw operationError;
    return result;
}

function isEligiblePrivacyRecoveryJob(job, now, safeStaleJobMs) {
    const safeGuildId = String(job.guildId || "");
    const safeUserId = String(job.userId || "");
    if (!safeGuildId || !safeUserId || safeUserId.startsWith("deleted:")) {
        return false;
    }

    const status = String(job.status || "");
    const manifest = job.manifest && typeof job.manifest === "object"
        ? job.manifest
        : {};
    const phases = manifest.phases || {};

    if (status === "failed") {
        return phases.mongo === "completed" && phases.sqlite !== "completed";
    }
    if (status === "pending" || status === "running" || !status) {
        const updatedAt = Number(job.updatedAt || job.createdAt || 0);
        return !Number.isFinite(updatedAt) || updatedAt <= 0 || (now - updatedAt) >= safeStaleJobMs;
    }
    return false;
}

async function claimPrivacyRecoveryJob(PrivacyDeletionJobModel, job, opKey, claimTime) {
    const claimFilter = { jobId: job.jobId };
    if (job.status !== undefined) claimFilter.status = job.status;
    if (job.updatedAt !== undefined) claimFilter.updatedAt = job.updatedAt;

    const claimUpdate = {
        $set: {
            status: "running",
            updatedAt: claimTime
        }
    };
    if (opKey && !job.activeKey) {
        claimUpdate.$set.activeKey = opKey;
    }

    try {
        const claimResult = await PrivacyDeletionJobModel.updateOne(claimFilter, claimUpdate);
        return resultCount(claimResult) > 0;
    } catch (err) {
        if (!isMongoDuplicateKey(err)) {
            console.error(`[PRIVACY_DELETION_RECOVERY] Failed to claim job ${job.jobId}:`, err);
        }
        return false;
    }
}

async function executeRecoveryMongoPhase({
    job,
    models,
    safeGuildId,
    safeUserId,
    hash,
    opKey,
    claimTime,
    manifest,
    mongooseInstance
}) {
    const { PrivacyDeletionJob: PrivacyDeletionJobModel } = models;
    let memberVersions = [];
    let dbSession = null;
    let mongoError = null;

    try {
        if (mongooseInstance && typeof mongooseInstance.startSession === "function") {
            try {
                dbSession = await mongooseInstance.startSession();
            } catch (_) {
                dbSession = null;
            }
        }

        if (dbSession) {
            try {
                await dbSession.withTransaction(async () => {
                    const txResult = await executePrivacyDeletionTransaction({
                        models,
                        safeGuildId,
                        safeUserId,
                        safeRequestedBy: job.requestedBy || "recovery-worker",
                        hash,
                        jobId: job.jobId,
                        operationKey: opKey,
                        now: claimTime,
                        manifest,
                        dbSession
                    });
                    if (Array.isArray(txResult?.memberVersions)) {
                        memberVersions = txResult.memberVersions;
                    }
                });
            } catch (txError) {
                if (/replica set|standalone|Transaction numbers/i.test(txError?.message || "")) {
                    dbSession = null;
                    const txResult = await executePrivacyDeletionTransaction({
                        models,
                        safeGuildId,
                        safeUserId,
                        safeRequestedBy: job.requestedBy || "recovery-worker",
                        hash,
                        jobId: job.jobId,
                        operationKey: opKey,
                        now: claimTime,
                        manifest,
                        dbSession: null
                    });
                    if (Array.isArray(txResult?.memberVersions)) {
                        memberVersions = txResult.memberVersions;
                    }
                } else {
                    throw txError;
                }
            }
        } else {
            const txResult = await executePrivacyDeletionTransaction({
                models,
                safeGuildId,
                safeUserId,
                safeRequestedBy: job.requestedBy || "recovery-worker",
                hash,
                jobId: job.jobId,
                operationKey: opKey,
                now: claimTime,
                manifest,
                dbSession: null
            });
            if (Array.isArray(txResult?.memberVersions)) {
                memberVersions = txResult.memberVersions;
            }
        }
    } catch (err) {
        mongoError = err;
    } finally {
        if (dbSession) {
            try { await dbSession.endSession(); } catch (_) {}
        }
    }

    if (mongoError) {
        manifest.phases.mongo = "failed";
        const errCode = mongoError.code || mongoError.name || "PRIVACY_DELETION_FAILED";
        await PrivacyDeletionJobModel.updateOne(
            { jobId: job.jobId },
            {
                $set: {
                    status: "failed",
                    errorCode: errCode,
                    manifest,
                    updatedAt: Date.now()
                },
                $unset: { activeKey: "" }
            }
        ).catch(() => {});
        return { ok: false, errorResult: { jobId: job.jobId, status: "failed", errorCode: errCode } };
    }

    return { ok: true, memberVersions };
}

async function executePrivacyRecoveryJobPhases({
    job,
    models,
    safeGuildId,
    safeUserId,
    hash,
    opKey,
    claimTime,
    manifest,
    mongooseInstance
}) {
    const { PrivacyDeletionJob: PrivacyDeletionJobModel } = models;
    let memberVersions = [];

    // Phase A: Complete MongoDB deletion if not already completed
    if (manifest.phases.mongo !== "completed") {
        const mongoPhase = await executeRecoveryMongoPhase({
            job,
            models,
            safeGuildId,
            safeUserId,
            hash,
            opKey,
            claimTime,
            manifest,
            mongooseInstance
        });
        if (!mongoPhase.ok) {
            return mongoPhase.errorResult;
        }
        memberVersions = mongoPhase.memberVersions;
    }

    // Phase B: Execute SQLite Deletion outside Mongo transaction
    if (manifest.phases.sqlite !== "completed") {
        try {
            const recoveryResult = await models.VerificationRecovery.deleteMany({
                guildId: safeGuildId,
                userId: safeUserId
            });
            manifest.counts.verificationRecovery = resultCount(recoveryResult);
            manifest.phases.sqlite = "completed";
        } catch (sqliteErr) {
            manifest.phases.sqlite = "failed";
            const errCode = "PRIVACY_DELETION_SQLITE_FAILED";
            await PrivacyDeletionJobModel.updateOne(
                { jobId: job.jobId },
                {
                    $set: {
                        status: "failed",
                        errorCode: errCode,
                        manifest,
                        updatedAt: Date.now()
                    },
                    $unset: { activeKey: "" }
                }
            ).catch(() => {});
            return { jobId: job.jobId, status: "failed", errorCode: errCode };
        }
    }

    // Phase C: Verification across all storages - fail closed if references remain
    let verification;
    try {
        verification = await verifyNoRemainingReferences({
            models,
            guildId: safeGuildId,
            userId: safeUserId,
            memberVersions,
            session: null
        });
    } catch (vErr) {
        const errCode = vErr.code || vErr.name || "PRIVACY_DELETION_VERIFICATION_FAILED";
        await PrivacyDeletionJobModel.updateOne(
            { jobId: job.jobId },
            {
                $set: {
                    status: "failed",
                    errorCode: errCode,
                    manifest,
                    updatedAt: Date.now()
                },
                $unset: { activeKey: "" }
            }
        ).catch(() => {});
        return { jobId: job.jobId, status: "failed", errorCode: errCode };
    }

    manifest.verification = verification;
    manifest.deletedCount = totalDeletionCount(manifest.counts);

    if (verification.remainingReferences !== 0) {
        const errCode = "PRIVACY_DELETION_INCOMPLETE";
        await PrivacyDeletionJobModel.updateOne(
            { jobId: job.jobId },
            {
                $set: {
                    status: "failed",
                    errorCode: errCode,
                    manifest,
                    updatedAt: Date.now()
                },
                $unset: { activeKey: "" }
            }
        ).catch(() => {});
        return {
            jobId: job.jobId,
            status: "failed",
            errorCode: errCode,
            remainingReferences: verification.remainingReferences
        };
    }

    // Phase D: Atomically mark completed
    const completedNow = Date.now();
    await PrivacyDeletionJobModel.updateOne(
        { jobId: job.jobId },
        {
            $set: {
                userId: deletedSubjectId(hash),
                subjectHash: hash,
                status: "completed",
                manifest,
                completedAt: completedNow,
                updatedAt: completedNow
            },
            $unset: { activeKey: "" }
        }
    );
    return { jobId: job.jobId, status: "completed" };
}

async function recoverSinglePrivacyJob({
    job,
    models,
    now,
    safeStaleJobMs,
    mongooseInstance
}) {
    if (!isEligiblePrivacyRecoveryJob(job, now, safeStaleJobMs)) {
        return null;
    }

    const safeGuildId = String(job.guildId || "");
    const safeUserId = String(job.userId || "");
    const opKey = job.operationKey || deletionOperationKey(safeGuildId, safeUserId);
    const claimTime = Date.now();

    const claimed = await claimPrivacyRecoveryJob(models.PrivacyDeletionJob, job, opKey, claimTime);
    if (!claimed) {
        return null;
    }

    const manifest = job.manifest && typeof job.manifest === "object"
        ? structuredClone(job.manifest)
        : createManifest();
    manifest.phases = manifest.phases || {};
    manifest.counts = manifest.counts || {};

    const hash = job.subjectHash || subjectHash(safeGuildId, safeUserId);

    return executePrivacyRecoveryJobPhases({
        job,
        models,
        safeGuildId,
        safeUserId,
        hash,
        opKey,
        claimTime,
        manifest,
        mongooseInstance
    });
}

async function recoverPendingPrivacyDeletions({
    models = DEFAULT_MODELS,
    now = Date.now(),
    staleJobMs = DEFAULT_PRIVACY_DELETION_STALE_MS,
    mongooseInstance = mongoose
} = {}) {
    const { PrivacyDeletionJob: PrivacyDeletionJobModel } = models;
    if (!PrivacyDeletionJobModel || typeof PrivacyDeletionJobModel.find !== "function") {
        return [];
    }

    if (PrivacyDeletionJobModel.db && typeof PrivacyDeletionJobModel.db.readyState === "number" && PrivacyDeletionJobModel.db.readyState !== 1) {
        return [];
    }

    const safeStaleJobMs = Number.isFinite(Number(staleJobMs)) && Number(staleJobMs) >= 0
        ? Number(staleJobMs)
        : DEFAULT_PRIVACY_DELETION_STALE_MS;

    let candidateJobs = [];
    try {
        const query = PrivacyDeletionJobModel.find({
            status: { $in: ["pending", "running", "failed"] }
        });
        candidateJobs = await (typeof query.lean === "function" ? query.lean() : query);
    } catch (_) {
        return [];
    }

    if (!Array.isArray(candidateJobs) || candidateJobs.length === 0) {
        return [];
    }

    const recovered = [];
    for (const job of candidateJobs) {
        // eslint-disable-next-line no-await-in-loop -- sequential processing prevents db connection and transaction contention
        const result = await recoverSinglePrivacyJob({
            job,
            models,
            now,
            safeStaleJobMs,
            mongooseInstance
        });
        if (result) {
            recovered.push(result);
        }
    }

    return recovered;
}

module.exports = {
    ACTIVE_PRIVACY_DELETION_STATUSES,
    DEFAULT_PRIVACY_DELETION_REUSE_MS,
    DEFAULT_PRIVACY_DELETION_STALE_MS,
    MANIFEST_VERSION,
    VERIFY_LOG_SENSITIVE_PATHS,
    buildOAuthUserPrivacyUpdate,
    createManifest,
    deletionOperationKey,
    deletionJobResult,
    redactArchivedOAuthPayload,
    recoverPendingPrivacyDeletions,
    reservePrivacyDeletionJob,
    runMemberPrivacyDeletion,
    subjectHash,
    totalDeletionCount,
    verifyNoRemainingReferences
};