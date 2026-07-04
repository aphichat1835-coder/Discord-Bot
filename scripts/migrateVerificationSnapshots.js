#!/usr/bin/env node
"use strict";

const mongoose = require("mongoose");
const OAuthUser = require("../discord/verification/models/OAuthUser");

const APPLY = process.argv.includes("--apply");
const DRY_RUN = process.argv.includes("--dry-run");
const BATCH_SIZE = Math.max(
    10,
    Math.min(500, Number(process.env.VERIFICATION_MIGRATION_BATCH_SIZE || 100) || 100)
);

const BADGES = Object.freeze([
    [1 << 0, "STAFF"],
    [1 << 1, "PARTNER"],
    [1 << 2, "HYPESQUAD"],
    [1 << 3, "BUG_HUNTER_LEVEL_1"],
    [1 << 6, "HYPESQUAD_BRAVERY"],
    [1 << 7, "HYPESQUAD_BRILLIANCE"],
    [1 << 8, "HYPESQUAD_BALANCE"],
    [1 << 9, "PREMIUM_EARLY_SUPPORTER"],
    [1 << 10, "TEAM_PSEUDO_USER"],
    [1 << 14, "BUG_HUNTER_LEVEL_2"],
    [1 << 16, "VERIFIED_BOT"],
    [1 << 17, "VERIFIED_DEVELOPER"],
    [1 << 18, "CERTIFIED_MODERATOR"],
    [1 << 19, "BOT_HTTP_INTERACTIONS"]
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

function buildPatch(doc, now = Date.now()) {
    const discord = doc.discord || {};
    const existingMeta = doc.snapshotMeta || {};
    const connectionsCount = Array.isArray(doc.connections) ? doc.connections.length : 0;
    const guildsCount = Array.isArray(doc.guilds) ? doc.guilds.length : 0;

    return {
        "discord.displayTag": discord.displayTag || displayTag(discord),
        "discord.avatarUrl": discord.avatarUrl || avatarUrl(discord),
        "discord.bannerUrl": discord.bannerUrl || bannerUrl(discord),
        "discord.badgeFlags": badgeFlags(discord),
        snapshotMeta: {
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
        }
    };
}

async function migrateCursor({
    cursor,
    apply = false,
    batchSize = BATCH_SIZE,
    bulkWrite = (operations, options) => OAuthUser.bulkWrite(operations, options),
    now = Date.now
}) {
    const summary = {
        mode: apply ? "apply" : "dry-run",
        scanned: 0,
        eligible: 0,
        updated: 0,
        batches: 0
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
        const patch = buildPatch(doc, now());
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
    const cursor = OAuthUser.find({})
        .select("discord connections guilds snapshotMeta")
        .lean()
        .cursor();
    const summary = await migrateCursor({ cursor, apply: APPLY });

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
    bannerUrl
};
