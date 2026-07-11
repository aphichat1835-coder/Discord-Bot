"use strict";

const OAuthUser = require("../models/OAuthUser");
const VerifyLog = require("../models/VerifyLog");
const GuildSnapshot = require("../models/OAuthUserGuildSnapshot");
const ConnectionSnapshot = require("../models/OAuthUserConnectionSnapshot");
const MemberSnapshot = require("../models/OAuthMemberSnapshot");
const MemberRoleSnapshot = require("../models/OAuthMemberRoleSnapshot");
const ProfileSnapshot = require("../models/OAuthUserProfileSnapshot");

const HOUR_MS = 60 * 60 * 1000;
const CLEANUP_GRACE_HOURS = Math.max(
    1,
    Number(process.env.OAUTH_SNAPSHOT_CLEANUP_GRACE_HOURS || 24) || 24
);
const CLEANUP_SCAN_MAX = Math.max(
    10,
    Math.min(1000, Number(process.env.OAUTH_SNAPSHOT_CLEANUP_SCAN_MAX || 200) || 200)
);
const DEFAULT_MODELS = Object.freeze({
    profile: ProfileSnapshot,
    guilds: GuildSnapshot,
    connections: ConnectionSnapshot,
    member: MemberSnapshot,
    memberRoles: MemberRoleSnapshot
});
const scanCursors = new Map();

function snapshotKey(userId, version) {
    return `${String(userId || "")}\u0000${String(version || "")}`;
}

function validCandidate(doc) {
    return !!doc?.userId && !!doc?.snapshotVersion;
}

function staleSnapshotFilter(cutoff, complete) {
    return {
        complete: complete === true ? true : { $ne: true },
        $or: [
            { updatedAt: { $lt: cutoff } },
            { updatedAt: { $exists: false }, capturedAt: { $lt: cutoff } }
        ]
    };
}

async function findCandidateDocs(Model, filter, cursor, limit) {
    let query = Model.find(filter);
    if (cursor) query = query.where("_id").gt(cursor);
    return query
        .select("userId snapshotVersion")
        .sort({ _id: 1 })
        .limit(limit)
        .lean();
}

async function scanCandidates(models, cutoff, scanMax) {
    const candidates = new Map();
    const entries = Object.entries(models);
    const perModelLimit = Math.max(1, Math.floor(scanMax / Math.max(1, entries.length)));
    for (const [name, Model] of entries) {
        const filter = staleSnapshotFilter(cutoff, true);
        const cursor = scanCursors.get(name) || null;
        let docs = await findCandidateDocs(Model, filter, cursor, perModelLimit);
        if (!docs.length && cursor) docs = await findCandidateDocs(Model, filter, null, perModelLimit);
        for (const doc of docs) {
            if (!validCandidate(doc)) continue;
            candidates.set(snapshotKey(doc.userId, doc.snapshotVersion), {
                userId: String(doc.userId),
                version: String(doc.snapshotVersion)
            });
        }
        const nextCursor = docs.length >= perModelLimit ? docs.at(-1)?._id : null;
        if (nextCursor) scanCursors.set(name, nextCursor);
        else scanCursors.delete(name);
    }
    return [...candidates.values()];
}

function referencedVersions(refs) {
    const versions = new Set();
    const visit = value => {
        if (!value || typeof value !== "object") return;
        if (typeof value.version === "string" && value.version) versions.add(value.version);
        for (const child of Object.values(value)) visit(child);
    };
    visit(refs);
    return versions;
}

async function loadReferenceKeys(candidates, { OAuthUserModel, VerifyLogModel }) {
    if (!candidates.length) return new Set();
    const userIds = [...new Set(candidates.map(item => item.userId))];
    const versions = [...new Set(candidates.map(item => item.version))];
    const [oauthUsers, verifyLogs] = await Promise.all([
        OAuthUserModel.find()
            .where("discord.userId").in(userIds)
            .select("discord.userId snapshotRefs")
            .lean(),
        VerifyLogModel.find()
            .where("userId").in(userIds)
            .or([
                { snapshotVersion: { $in: versions } },
                { "snapshotRef.profile.version": { $in: versions } },
                { "snapshotRef.guilds.version": { $in: versions } },
                { "snapshotRef.connections.version": { $in: versions } },
                { "snapshotRef.member.version": { $in: versions } },
                { "snapshotRef.member.roleRef.version": { $in: versions } }
            ])
            .select("userId snapshotVersion snapshotRef")
            .lean()
    ]);
    const referenced = new Set();
    for (const user of oauthUsers) {
        const userId = String(user.discord?.userId || "");
        for (const version of referencedVersions(user.snapshotRefs)) {
            referenced.add(snapshotKey(userId, version));
        }
    }
    for (const log of verifyLogs) {
        const userId = String(log.userId || "");
        if (log.snapshotVersion) referenced.add(snapshotKey(userId, log.snapshotVersion));
        for (const version of referencedVersions(log.snapshotRef)) {
            referenced.add(snapshotKey(userId, version));
        }
    }
    return referenced;
}

function orphanFilter(candidates) {
    const byUser = new Map();
    for (const candidate of candidates) {
        const versions = byUser.get(candidate.userId) || [];
        versions.push(candidate.version);
        byUser.set(candidate.userId, versions);
    }
    return {
        complete: true,
        $or: [...byUser].map(([userId, versions]) => ({
            userId,
            snapshotVersion: { $in: versions }
        }))
    };
}

async function applyModelCleanup(Model, { cutoff, orphanCandidates, dryRun, batchLimit = CLEANUP_SCAN_MAX }) {
    const incompleteFilter = staleSnapshotFilter(cutoff, false);
    const orphanedFilter = orphanCandidates.length ? orphanFilter(orphanCandidates) : null;
    const safeBatchLimit = Math.max(1, Number(batchLimit || CLEANUP_SCAN_MAX));
    const incompleteDocs = await Model.find(incompleteFilter)
        .select("_id")
        .sort({ _id: 1 })
        .limit(safeBatchLimit)
        .lean();
    const incompleteIds = incompleteDocs.map(doc => doc?._id).filter(Boolean);
    if (dryRun) {
        const [incompleteTotal, orphaned] = await Promise.all([
            Model.countDocuments(incompleteFilter),
            orphanedFilter ? Model.countDocuments(orphanedFilter) : 0
        ]);
        return {
            incomplete: incompleteTotal,
            incompleteBatchSize: incompleteIds.length,
            incompleteRemaining: Math.max(0, incompleteTotal - incompleteIds.length),
            orphaned
        };
    }
    const incompleteResult = incompleteIds.length
        ? await Model.deleteMany({ _id: { $in: incompleteIds } })
        : { deletedCount: 0 };
    const orphanedResult = orphanedFilter
        ? await Model.deleteMany(orphanedFilter)
        : { deletedCount: 0 };
    return {
        incomplete: Number(incompleteResult?.deletedCount || 0),
        incompleteBatchSize: incompleteIds.length,
        orphaned: Number(orphanedResult?.deletedCount || 0)
    };
}

async function cleanupSnapshotGarbage(options = {}) {
    const now = Number(options.now || Date.now());
    const graceHours = Math.max(1, Number(options.graceHours || CLEANUP_GRACE_HOURS));
    const scanMax = Math.max(1, Number(options.scanMax || CLEANUP_SCAN_MAX));
    const dryRun = options.dryRun === true;
    const models = options.models || DEFAULT_MODELS;
    const references = {
        OAuthUserModel: options.OAuthUserModel || OAuthUser,
        VerifyLogModel: options.VerifyLogModel || VerifyLog
    };
    const cutoff = now - graceHours * HOUR_MS;

    const candidates = await scanCandidates(models, cutoff, scanMax);
    const referenced = await loadReferenceKeys(candidates, references);
    const orphanCandidates = candidates.filter(candidate =>
        !referenced.has(snapshotKey(candidate.userId, candidate.version))
    );
    const summary = {
        mode: "permanent_history",
        dryRun,
        graceHours,
        scanMax,
        candidatesScanned: candidates.length,
        referencedVersionsKept: candidates.length - orphanCandidates.length,
        orphanVersions: orphanCandidates.length,
        incompleteDocuments: 0,
        incompleteBatchCapacity: scanMax,
        orphanDocuments: 0,
        byModel: {}
    };
    const modelEntries = Object.entries(models);
    const incompleteBatchLimit = Math.max(1, Math.floor(scanMax / Math.max(1, modelEntries.length)));
    for (const [name, Model] of modelEntries) {
        const result = await applyModelCleanup(Model, {
            cutoff,
            orphanCandidates,
            dryRun,
            batchLimit: incompleteBatchLimit
        });
        summary.byModel[name] = result;
        summary.incompleteDocuments += result.incomplete;
        summary.orphanDocuments += result.orphaned;
    }
    return summary;
}

module.exports = {
    cleanupSnapshotGarbage,
    getSnapshotCleanupConfig: () => ({
        mode: "permanent_history",
        graceHours: CLEANUP_GRACE_HOURS,
        scanMax: CLEANUP_SCAN_MAX
    }),
    _test: {
        snapshotKey,
        staleSnapshotFilter,
        referencedVersions,
        orphanFilter,
        scanCandidates,
        loadReferenceKeys,
        resetScanCursors: () => scanCursors.clear()
    }
};
