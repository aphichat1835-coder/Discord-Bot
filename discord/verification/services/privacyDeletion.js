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

const MANIFEST_VERSION = 2;
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
        // A snapshot-set activation that referenced the removed member snapshot
        // is no longer complete. Keep the global profile/guild/connection refs,
        // but force the next verification to activate a fresh complete set.
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
        const users = (Array.isArray(link.users) ? link.users : [])
            .filter(item => String(item?.userId || "") !== String(userId));
        const deviceFingerprints = (Array.isArray(link.deviceFingerprints) ? link.deviceFingerprints : [])
            .filter(item => String(item?.userId || "") !== String(userId));
        const roleSnapshots = (Array.isArray(link.roleSnapshots) ? link.roleSnapshots : [])
            .filter(item => String(item?.userId || "") !== String(userId));
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
        const result = await LinkModel.updateOne({ _id: link._id }, update, { session });
        if (uniqueUsers === 0) deleted += resultCount(result);
        else updated += resultCount(result);
    }
    return { deleted, updated };
}

async function runMemberPrivacyDeletion({
    guildId,
    userId,
    requestedBy,
    now = Date.now(),
    models = DEFAULT_MODELS,
    mongooseInstance = mongoose
}) {
    const safeGuildId = String(guildId || "");
    const safeUserId = String(userId || "");
    const safeRequestedBy = String(requestedBy || "dashboard-control").slice(0, 120);
    const hash = subjectHash(safeGuildId, safeUserId);
    const jobId = crypto.randomUUID();
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
        VerificationRecovery: VerificationRecoveryModel,
        PrivacyDeletionJob: PrivacyDeletionJobModel
    } = models;

    await PrivacyDeletionJobModel.create({
        jobId,
        guildId: safeGuildId,
        userId: safeUserId,
        subjectHash: hash,
        requestedBy: safeRequestedBy,
        status: "pending",
        manifestVersion: MANIFEST_VERSION,
        createdAt: now,
        updatedAt: now
    });

    const dbSession = await mongooseInstance.startSession();
    const manifest = {
        version: MANIFEST_VERSION,
        scope: "guild_member",
        preservedGlobalSnapshots: true
    };
    try {
        await PrivacyDeletionJobModel.updateOne(
            { jobId },
            { $set: { status: "running", updatedAt: Date.now() } }
        );
        await dbSession.withTransaction(async () => {
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
            manifest.verifyLogsRedacted = resultCount(verifyLogResult);

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
                    : Promise.resolve({ deletedCount: 0 })],
                ["verificationRecovery", () => VerificationRecoveryModel.deleteMany(
                    { guildId: safeGuildId, userId: safeUserId }, { session: dbSession }
                )]
            ];
            for (const [name, operation] of operations) manifest[name] = resultCount(await operation());

            const identity = await scrubIdentityLinks({
                LinkModel: IpIdentityLinkModel,
                guildId: safeGuildId,
                userId: safeUserId,
                requestedBy: safeRequestedBy,
                now,
                session: dbSession
            });
            manifest.ipIdentityLinksDeleted = identity.deleted;
            manifest.ipIdentityLinksUpdated = identity.updated;

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
                manifest.oauthUserUpdated = resultCount(oauthResult);
            } else {
                manifest.oauthUserUpdated = 0;
            }

            manifest.migrationArchivesRedacted = await redactMigrationArchives({
                ArchiveModel: VerificationMigrationArchiveModel,
                userId: safeUserId,
                guildId: safeGuildId,
                requestedBy: safeRequestedBy,
                now,
                session: dbSession
            });
        });

        const remainingChecks = await Promise.all([
            VerifyLogModel.countDocuments({ guildId: safeGuildId, userId: safeUserId }),
            OAuthMemberSnapshotModel.countDocuments({ guildId: safeGuildId, userId: safeUserId }),
            IpIdentityUserHistoryModel.countDocuments({ guildId: safeGuildId, userId: safeUserId }),
            IpIdentityDeviceHistoryModel.countDocuments({ guildId: safeGuildId, userId: safeUserId }),
            IpIdentityRoleHistoryModel.countDocuments({ guildId: safeGuildId, userId: safeUserId }),
            OAuthObjectChunkSnapshotModel.countDocuments({ guildId: safeGuildId, userId: safeUserId }),
            VerificationRecoveryModel.countDocuments({ guildId: safeGuildId, userId: safeUserId }),
            IpIdentityLinkModel.countDocuments({
                guildId: safeGuildId,
                $or: [
                    { "users.userId": safeUserId },
                    { "deviceFingerprints.userId": safeUserId },
                    { "roleSnapshots.userId": safeUserId }
                ]
            })
        ]);
        manifest.remainingReferences = remainingChecks.reduce((sum, value) => sum + Number(value || 0), 0);
        if (manifest.remainingReferences !== 0) {
            const error = new Error("Privacy deletion left remaining guild-scoped references");
            error.code = "PRIVACY_DELETION_INCOMPLETE";
            throw error;
        }

        await PrivacyDeletionJobModel.updateOne(
            { jobId },
            {
                $set: {
                    userId: deletedSubjectId(hash),
                    subjectHash: hash,
                    status: "completed",
                    manifest,
                    completedAt: Date.now(),
                    updatedAt: Date.now()
                }
            }
        );
        return { success: true, jobId, manifest };
    } catch (error) {
        await PrivacyDeletionJobModel.updateOne(
            { jobId },
            {
                $set: {
                    status: "failed",
                    manifest,
                    errorCode: error.code || error.name || "PRIVACY_DELETION_FAILED",
                    updatedAt: Date.now()
                }
            }
        ).catch(() => {});
        throw error;
    } finally {
        await dbSession.endSession();
    }
}

module.exports = {
    MANIFEST_VERSION,
    VERIFY_LOG_SENSITIVE_PATHS,
    buildOAuthUserPrivacyUpdate,
    redactArchivedOAuthPayload,
    runMemberPrivacyDeletion,
    subjectHash
};
