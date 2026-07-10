#!/usr/bin/env node
"use strict";

const mongoose = require("mongoose");
const OAuthUser = require("../discord/verification/models/OAuthUser");
const snapshotStore = require("../discord/verification/services/oauthSnapshotStore");

const APPLY = process.argv.includes("--apply");
const DRY_RUN = process.argv.includes("--dry-run");
const BATCH_SIZE = Math.max(
    10,
    Math.min(500, Number(process.env.VERIFICATION_MIGRATION_BATCH_SIZE || 100) || 100)
);

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
        "discord.badgeFlags": badgeFlags(discord),
        snapshotMeta: legacySnapshotMeta(doc, now)
    };
    applyStoredSnapshots(patch, doc, storedSnapshots, now);
    return patch;
}

function migrationProfile(discord) {
    return {
        ...discord,
        ...discord.profileSnapshot,
        id: discord.profileSnapshot?.id || discord.userId
    };
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

async function migrateCursor({
    cursor,
    apply = false,
    batchSize = BATCH_SIZE,
    bulkWrite = (operations, options) => OAuthUser.bulkWrite(operations, options),
    snapshotWriter = null,
    now = Date.now
}) {
    const summary = {
        mode: apply ? "apply" : "dry-run",
        scanned: 0,
        eligible: 0,
        updated: 0,
        batches: 0,
        snapshotCategoriesComplete: 0,
        snapshotCategoriesFailed: 0
    };
    let operations = [];

    async function flush() {
        if (!operations.length) return;
        summary.batches++;
        if (apply) {
            const result = await bulkWrite(operations, { ordered: false });
            summary.updated += result?.modifiedCount || 0;
        }
        operations = [];
    }

    for await (const doc of cursor) {
        summary.scanned++;
        const timestamp = now();
        const storedSnapshots = apply
            ? await writeLegacySnapshots(doc, snapshotWriter, timestamp)
            : null;
        countSnapshotResults(summary, storedSnapshots);
        const patch = buildPatch(doc, timestamp, storedSnapshots);
        summary.eligible++;
        operations.push({
            updateOne: {
                filter: { _id: doc._id },
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
    const cursor = OAuthUser.find({
        $or: [
            { "snapshotMeta.version": { $ne: 2 } },
            { "discord.displayTag": { $exists: false } },
            { "discord.avatarUrl": { $exists: false } },
            { "discord.badgeFlags": { $exists: false } },
            { snapshotRefs: { $exists: false } },
            { "snapshotRefs.profile": { $exists: false } },
            { "snapshotRefs.connections": { $exists: false } },
            { "snapshotRefs.guilds": { $exists: false } },
            {
                $and: [
                    { lastMember: { $ne: null } },
                    { "snapshotRefs.member": { $exists: false } }
                ]
            },
            {
                $and: [
                    { lastMember: { $ne: null } },
                    { "snapshotRefs.member.roleRef": { $exists: false } }
                ]
            }
        ]
    })
        .select("discord connections guilds lastMember lastVerify snapshotMeta snapshotRefs")
        .lean()
        .cursor();
    const summary = await migrateCursor({
        cursor,
        apply: APPLY,
        snapshotWriter: snapshotStore.storeOAuthSnapshots
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
    badgeFlags,
    displayTag,
    avatarUrl,
    bannerUrl,
    completeRefs
};
