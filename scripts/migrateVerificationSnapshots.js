#!/usr/bin/env node
"use strict";

const mongoose = require("mongoose");
const OAuthUser = require("../discord/verification/models/OAuthUser");
const snapshotStore = require("../discord/verification/services/oauthSnapshotStore");
const { archiveSourceDocument } = require("../discord/verification/services/migrationArchive");
const { readFiniteInteger } = require("../discord/core/numbers");

const APPLY = process.argv.includes("--apply");
const DRY_RUN = process.argv.includes("--dry-run");
const BATCH_SIZE = readFiniteInteger(process.env.VERIFICATION_MIGRATION_BATCH_SIZE, { fallback: 100, min: 10, max: 500 });

function migrationFilter() {
    return {
        $or: [
            { "snapshotMeta.version": { $exists: false } },
            { "snapshotMeta.version": { $lt: 2 } },
            { "discord.displayTag": { $exists: false } },
            { "discord.avatarUrl": { $exists: false } },
            { "discord.badgeFlags": { $exists: false } },
            { snapshotRefs: { $exists: false } },
            { "snapshotRefs.profile": { $exists: false } },
            { "snapshotRefs.connections": { $exists: false } },
            { "snapshotRefs.guilds": { $exists: false } },
            { $and: [{ lastMember: { $ne: null } }, { "snapshotRefs.member": { $exists: false } }] },
            { $and: [{ lastMember: { $ne: null } }, { "snapshotRefs.member.roleRef": { $exists: false } }] }
        ]
    };
}

const BADGES = Object.freeze([
    [2 ** 0, "STAFF"],
    [2 ** 1, "PARTNER"],
    [2 ** 2, "HYPESQUAD"],
    [2 ** 3, "BUG_HUNTER_LEVEL_1"],
    [2 ** 6, "HYPESQUAD_BRAVERY"],
    [2 ** 7, "HYPESQUAD_BRILLIANCE"],
    [2 ** 8, "HYPESQUAD_BALANCE"],
    [2 ** 9, "PREMIUM_EARLY_SUPPORTER"],
    [2 ** 10, "TEAM_PSEUDO_USER"],
    [2 ** 14, "BUG_HUNTER_LEVEL_2"],
    [2 ** 16, "VERIFIED_BOT"],
    [2 ** 17, "VERIFIED_DEVELOPER"],
    [2 ** 18, "CERTIFIED_MODERATOR"],
    [2 ** 19, "BOT_HTTP_INTERACTIONS"]
]);

function badgeFlags(discord = {}) {
    const flags = Number(discord.publicFlags ?? discord.flags ?? 0) || 0;
    return BADGES.filter(([bit]) => (flags & bit) === bit).map(([, label]) => label);
}

function displayTag(discord = {}) {
    const username = String(discord.username || "");
    const discriminator = String(discord.discriminator ?? "");
    if (!username) return null;
    return discriminator && discriminator !== "0"
        ? `${username}#${discriminator}`
        : username;
}

function avatarUrl(discord = {}) {
    if (!discord.userId || !discord.avatarHash) return null;
    const ext = String(discord.avatarHash).startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${discord.userId}/${discord.avatarHash}.${ext}?size=256`;
}

function bannerUrl(discord = {}) {
    if (!discord.userId || !discord.bannerHash) return null;
    const ext = String(discord.bannerHash).startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/banners/${discord.userId}/${discord.bannerHash}.${ext}?size=512`;
}

function isCompleteRef(ref) {
    return ref?.complete === true && ref.returnedCount === ref.storedCount;
}

function completeRefs(previousRefs = {}, stored = {}) {
    const refs = { ...previousRefs };
    for (const kind of ["profile", "connections", "guilds", "member"]) {
        const ref = stored?.[kind];
        if (isCompleteRef(ref)) refs[kind] = ref;
    }
    return refs;
}

function legacySnapshotMeta(doc, now) {
    const existingMeta = doc.snapshotMeta || {};
    const connectionsCount = Array.isArray(doc.connections) ? doc.connections.length : 0;
    const guildsCount = Array.isArray(doc.guilds) ? doc.guilds.length : 0;
    return {
        ...existingMeta,
        version: 2,
        migratedAt: existingMeta.migratedAt || now,
        profile: existingMeta.profile || {
            status: "legacy",
            source: "discord_oauth"
        },
        connections: existingMeta.connections || {
            status: "legacy",
            returnedCount: connectionsCount,
            storedCount: connectionsCount,
            truncated: false,
            source: "discord_oauth"
        },
        guilds: existingMeta.guilds || {
            status: "legacy",
            returnedCount: guildsCount,
            storedCount: guildsCount,
            truncated: false,
            source: "discord_oauth"
        }
    };
}

function roleCountMeta(ref) {
    if (!Number.isFinite(Number(ref.roleReturnedCount))) return {};
    return {
        roleReturnedCount: Number(ref.roleReturnedCount),
        roleStoredCount: Number(ref.roleStoredCount || 0),
        roleChunkCount: Number(ref.roleChunkCount || 0)
    };
}

function storedSnapshotMeta(previous, ref, now) {
    const complete = isCompleteRef(ref);
    return {
        ...previous,
        status: complete ? "success" : "failed",
        returnedCount: ref.returnedCount,
        storedCount: ref.storedCount,
        chunkCount: ref.chunkCount,
        complete,
        ...roleCountMeta(ref),
        snapshotVersion: ref.version,
        failureReason: ref.failureReason || null,
        source: ref.source || "migration",
        migratedAt: now
    };
}

function applyStoredSnapshots(patch, doc, storedSnapshots, now) {
    if (!storedSnapshots) return;
    patch.snapshotRefs = completeRefs(doc.snapshotRefs, storedSnapshots);
    for (const kind of ["profile", "connections", "guilds", "member"]) {
        const ref = storedSnapshots[kind];
        if (!ref) continue;
        patch.snapshotMeta[kind] = storedSnapshotMeta(patch.snapshotMeta[kind], ref, now);
    }
}

function buildPatch(doc, now = Date.now(), storedSnapshots = null) {
    const discord = doc.discord || {};

    const patch = {
        "discord.displayTag": discord.displayTag || displayTag(discord),
        "discord.avatarUrl": discord.avatarUrl || avatarUrl(discord),
        "discord.bannerUrl": discord.bannerUrl || bannerUrl(discord),
        "discord.badgeFlags": Array.isArray(discord.badgeFlags)
            ? discord.badgeFlags
            : badgeFlags(discord),
        snapshotMeta: legacySnapshotMeta(doc, now),
        updatedAt: now
    };
    applyStoredSnapshots(patch, doc, storedSnapshots, now);
    return patch;
}

function optimisticSourceFilter(doc = {}) {
    const filter = { _id: doc._id };
    filter.updatedAt = Object.hasOwn(doc, "updatedAt")
        ? doc.updatedAt
        : { $exists: false };
    return filter;
}

function sanitizeMigrationProfile(value) {
    const blocked = new Set(["token", "accesstoken", "refreshtoken", "encryptedaccesstoken",
        "encryptedrefreshtoken", "authorization", "clientsecret", "credential", "rawip", "encryptedrawip"]);
    const json = JSON.stringify(value, (key, item) => {
        const normalized = String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        const sensitive = blocked.has(normalized) || normalized.endsWith("token") ||
            normalized.endsWith("secret") || normalized.endsWith("credential") || normalized.endsWith("apikey");
        return sensitive ? undefined : item;
    });
    return json ? JSON.parse(json) : {};
}

function migrationProfile(discord = {}) {
    return sanitizeMigrationProfile({
        ...discord,
        ...discord.profileSnapshot,
        id: discord.profileSnapshot?.id || discord.userId
    });
}

async function writeLegacySnapshots(doc, snapshotWriter, timestamp) {
    if (!snapshotWriter || !doc.discord?.userId) return null;
    return snapshotWriter({
        userId: doc.discord.userId,
        guildId: doc.lastMember?.guildId || doc.lastVerify?.guildId || "legacy",
        profile: migrationProfile(doc.discord),
        connections: Array.isArray(doc.connections) ? doc.connections : [],
        guilds: Array.isArray(doc.guilds) ? doc.guilds : [],
        member: doc.lastMember || null,
        fetchMetadata: {},
        now: timestamp
    });
}

function countSnapshotResults(summary, storedSnapshots) {
    if (!storedSnapshots) return;
    for (const kind of ["profile", "connections", "guilds", "member"]) {
        const ref = storedSnapshots[kind];
        if (!ref) continue;
        if (isCompleteRef(ref)) {
            summary.snapshotCategoriesComplete++;
        } else {
            summary.snapshotCategoriesFailed++;
        }
    }
}

function reportedBulkWriteErrors(error) {
    const candidates = [
        error?.writeErrors,
        error?.result?.writeErrors,
        error?.result?.result?.writeErrors
    ];
    if (typeof error?.result?.getWriteErrors === "function") {
        try { candidates.push(error.result.getWriteErrors()); } catch {}
    }
    return candidates.find(value => Array.isArray(value) && value.length > 0) || null;
}

function bulkWriteSuccessCount(error) {
    const result = error?.result || {};
    const matched = Number(result.matchedCount ?? result.nMatched);
    const upserted = Number(result.upsertedCount ?? result.nUpserted);
    if (Number.isFinite(matched) || Number.isFinite(upserted)) {
        return Math.max(0,
            (Number.isFinite(matched) ? matched : 0) +
            (Number.isFinite(upserted) ? upserted : 0)
        );
    }
    const modified = Number(result.modifiedCount ?? result.nModified);
    return Number.isFinite(modified) ? Math.max(0, modified) : null;
}

function bulkWriteFailureCount(error, batchLength) {
    const total = Math.max(0, Number(batchLength) || 0);
    const writeErrors = reportedBulkWriteErrors(error);
    if (writeErrors) return Math.min(total, writeErrors.length);
    const successful = bulkWriteSuccessCount(error);
    if (successful === null) return total;
    return Math.max(1, Math.min(total, total - successful));
}

async function migrateCursor({
    cursor,
    apply = false,
    batchSize = BATCH_SIZE,
    bulkWrite = (operations, options) => OAuthUser.bulkWrite(operations, options),
    snapshotWriter = null,
    now = Date.now,
    beforeMigrate = null
}) {
    const summary = {
        mode: apply ? "apply" : "dry-run",
        scanned: 0,
        eligible: 0,
        updated: 0,
        batches: 0,
        batchErrors: 0,
        failedOperations: 0,
        snapshotCategoriesComplete: 0,
        snapshotCategoriesFailed: 0,
        lastScannedId: null
    };
    let operations = [];

    async function flush() {
        if (!operations.length) return;
        const batch = operations;
        operations = [];
        summary.batches++;
        if (apply) {
            try {
                const result = await bulkWrite(batch, { ordered: false });
                summary.updated += result?.modifiedCount || 0;
            } catch (err) {
                summary.updated += Number(err?.result?.modifiedCount || err?.result?.nModified || 0);
                summary.batchErrors++;
                summary.failedOperations += bulkWriteFailureCount(err, batch.length);
                console.error("[VERIFICATION-MIGRATION] batch write failed:", JSON.stringify({
                    code: String(err?.code || "migration_batch_write_failed").slice(0, 80),
                    name: String(err?.name || "Error").slice(0, 80),
                    operations: batch.length
                }));
            }
        }
    }

    for await (const doc of cursor) {
        summary.scanned++;
        summary.lastScannedId = doc?._id ? String(doc._id) : summary.lastScannedId;
        const timestamp = now();
        if (beforeMigrate) await beforeMigrate(doc, summary);
        const storedSnapshots = apply
            ? await writeLegacySnapshots(doc, snapshotWriter, timestamp)
            : null;
        countSnapshotResults(summary, storedSnapshots);
        const patch = buildPatch(doc, timestamp, storedSnapshots);
        summary.eligible++;
        operations.push({
            updateOne: {
                filter: optimisticSourceFilter(doc),
                update: { $set: patch }
            }
        });
        if (operations.length >= batchSize) await flush();
    }
    await flush();
    return summary;
}

async function run() {
    if (APPLY && DRY_RUN) {
        throw new Error("Choose only one migration mode: --dry-run or --apply");
    }
    const mongoUri = String(process.env.MONGO_URI || "").trim();
    if (!mongoUri) throw new Error("MONGO_URI is required");

    await mongoose.connect(mongoUri, { maxPoolSize: 2 });
    const cursor = OAuthUser.find(migrationFilter())
        .select("discord connections guilds lastMember lastVerify snapshotMeta snapshotRefs updatedAt")
        .lean()
        .cursor();
    const summary = await migrateCursor({
        cursor,
        apply: APPLY,
        snapshotWriter: snapshotStore.storeOAuthSnapshots,
        beforeMigrate: APPLY ? doc => archiveSourceDocument(doc._id, { migrationVersion: 2 }) : null
    });

    console.log("[VERIFICATION-MIGRATION]", JSON.stringify(summary));
}

if (require.main === module) {
    run()
        .catch(err => {
            console.error("[VERIFICATION-MIGRATION] failed:", err?.message || "unknown error");
            process.exitCode = 1;
        })
        .finally(async () => {
            await mongoose.connection.close(false).catch(() => {});
        });
}

module.exports = {
    buildPatch,
    migrateCursor,
    bulkWriteFailureCount,
    badgeFlags,
    displayTag,
    avatarUrl,
    bannerUrl,
    completeRefs,
    migrationFilter,
    optimisticSourceFilter,
    migrationProfile
};
