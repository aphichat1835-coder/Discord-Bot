"use strict";

const crypto = require("node:crypto");
const GuildSnapshot = require("../models/OAuthUserGuildSnapshot");
const ConnectionSnapshot = require("../models/OAuthUserConnectionSnapshot");
const MemberSnapshot = require("../models/OAuthMemberSnapshot");
const { jsonBytes, MAX_MAX_BYTES } = require("./snapshotBudget");

const CHUNK_MAX_BYTES = Math.min(
    MAX_MAX_BYTES,
    Math.max(64 * 1024, Number(process.env.OAUTH_SNAPSHOT_CHUNK_MAX_BYTES || 512 * 1024) || 512 * 1024)
);
const CHUNK_MAX_ITEMS = Math.max(
    1,
    Math.min(500, Number(process.env.OAUTH_SNAPSHOT_CHUNK_MAX_ITEMS || 100) || 100)
);

function createSnapshotVersion(now = Date.now()) {
    return `${now}-${crypto.randomBytes(6).toString("hex")}`;
}

function chunkItems(items = [], { maxBytes = CHUNK_MAX_BYTES, maxItems = CHUNK_MAX_ITEMS } = {}) {
    const source = Array.isArray(items) ? items : [];
    const chunks = [];
    let current = [];
    let currentBytes = 2;

    for (const item of source) {
        const itemBytes = jsonBytes(item);
        if (!Number.isFinite(itemBytes) || itemBytes > MAX_MAX_BYTES) {
            const error = new Error("snapshot item exceeds per-document maximum");
            error.code = "snapshot_item_too_large";
            error.bytes = itemBytes;
            throw error;
        }
        const wouldOverflow = current.length > 0 &&
            (current.length >= maxItems || currentBytes + itemBytes + 1 > maxBytes);
        if (wouldOverflow) {
            chunks.push(current);
            current = [];
            currentBytes = 2;
        }
        current.push(item);
        currentBytes += itemBytes + 1;
    }

    if (current.length || source.length === 0) chunks.push(current);
    return chunks;
}

function successfulRef(kind, version, meta) {
    return {
        kind,
        version,
        returnedCount: meta.returnedCount,
        storedCount: meta.storedCount,
        chunkCount: meta.chunkCount,
        complete: meta.complete,
        fetchStatus: meta.fetchStatus,
        failureReason: meta.failureReason,
        source: meta.source,
        capturedAt: meta.capturedAt
    };
}

function failedMeta(kind, version, returnedCount, err, now) {
    return {
        kind,
        version,
        returnedCount,
        storedCount: 0,
        chunkCount: 0,
        complete: false,
        fetchStatus: "failed",
        failureReason: String(err?.code || "snapshot_write_failed").slice(0, 120),
        source: "discord_oauth",
        capturedAt: now
    };
}

async function storeArraySnapshot(Model, { kind, userId, version, items, now = Date.now() }) {
    const source = Array.isArray(items) ? items : [];
    try {
        const chunks = chunkItems(source);
        const common = {
            userId,
            snapshotVersion: version,
            returnedCount: source.length,
            storedCount: source.length,
            complete: false,
            fetchStatus: "success",
            failureReason: null,
            source: "discord_oauth",
            capturedAt: now,
            updatedAt: now
        };
        await Model.bulkWrite(chunks.map((chunk, chunkIndex) => ({
            updateOne: {
                filter: { userId, snapshotVersion: version, chunkIndex },
                update: { $set: { ...common, chunkIndex, items: chunk, itemCount: chunk.length } },
                upsert: true
            }
        })), { ordered: true });
        const finalized = await Model.updateMany(
            { userId, snapshotVersion: version },
            { $set: { complete: true, updatedAt: now } }
        );
        const complete = Number(finalized?.matchedCount || 0) === chunks.length;
        const meta = {
            ...common,
            complete,
            chunkCount: chunks.length,
            failureReason: complete ? null : "snapshot_finalize_incomplete"
        };
        return successfulRef(kind, version, meta);
    } catch (err) {
        return failedMeta(kind, version, source.length, err, now);
    }
}

async function storeMemberSnapshot({ userId, guildId, version, member, now = Date.now() }) {
    const roleCount = Array.isArray(member?.roles) ? member.roles.length : 0;
    try {
        if (jsonBytes(member) > MAX_MAX_BYTES) {
            const error = new Error("member snapshot exceeds per-document maximum");
            error.code = "snapshot_item_too_large";
            throw error;
        }
        await MemberSnapshot.findOneAndUpdate(
            { userId, guildId, snapshotVersion: version },
            {
                $set: {
                    userId,
                    guildId,
                    snapshotVersion: version,
                    snapshot: member,
                    roleCount,
                    returnedCount: 1,
                    storedCount: 1,
                    complete: false,
                    fetchStatus: "success",
                    failureReason: null,
                    source: "discord_bot_api",
                    capturedAt: now,
                    updatedAt: now
                }
            },
            { upsert: true, new: true }
        );
        const finalized = await MemberSnapshot.updateOne(
            { userId, guildId, snapshotVersion: version },
            { $set: { complete: true, updatedAt: now } }
        );
        const complete = Number(finalized?.matchedCount || 0) === 1;
        return {
            kind: "member",
            version,
            guildId,
            returnedCount: 1,
            storedCount: complete ? 1 : 0,
            chunkCount: 1,
            complete,
            fetchStatus: complete ? "success" : "failed",
            failureReason: complete ? null : "snapshot_finalize_incomplete",
            source: "discord_bot_api",
            capturedAt: now
        };
    } catch (err) {
        return { ...failedMeta("member", version, 1, err, now), guildId };
    }
}

async function storeOAuthSnapshots({ userId, guildId, guilds, connections, member, fetchMetadata = {}, now = Date.now() }) {
    const version = createSnapshotVersion(now);
    const tasks = {};
    if (!fetchMetadata.guildsFetchFailed) {
        tasks.guilds = storeArraySnapshot(GuildSnapshot, { kind: "guilds", userId, version, items: guilds, now });
    }
    if (!fetchMetadata.connectionsFetchFailed) {
        tasks.connections = storeArraySnapshot(ConnectionSnapshot, {
            kind: "connections", userId, version, items: connections, now
        });
    }
    if (member) {
        tasks.member = storeMemberSnapshot({ userId, guildId, version, member, now });
    }
    const keys = Object.keys(tasks);
    const values = await Promise.all(Object.values(tasks));
    return { version, ...Object.fromEntries(keys.map((key, index) => [key, values[index]])) };
}

async function loadArraySnapshot(Model, userId, ref) {
    if (!ref?.version || ref.complete !== true) return null;
    const docs = await Model.find({
        userId,
        snapshotVersion: ref.version,
        complete: true
    }).sort({ chunkIndex: 1 }).lean();
    if (docs.length !== Number(ref.chunkCount || 0)) return null;
    const items = docs.flatMap(doc => Array.isArray(doc.items) ? doc.items : []);
    return items.length === Number(ref.storedCount || 0) ? items : null;
}

async function loadOAuthSnapshots({ userId, refs = {}, guildId = null }) {
    const [guilds, connections, memberDoc] = await Promise.all([
        loadArraySnapshot(GuildSnapshot, userId, refs.guilds),
        loadArraySnapshot(ConnectionSnapshot, userId, refs.connections),
        refs.member?.version && refs.member.complete === true
            ? MemberSnapshot.findOne({
                userId,
                guildId: refs.member.guildId || guildId,
                snapshotVersion: refs.member.version,
                complete: true
            }).lean()
            : null
    ]);
    return {
        guilds,
        connections,
        member: memberDoc?.snapshot || null
    };
}

module.exports = {
    CHUNK_MAX_BYTES,
    CHUNK_MAX_ITEMS,
    createSnapshotVersion,
    chunkItems,
    storeArraySnapshot,
    storeMemberSnapshot,
    storeOAuthSnapshots,
    loadArraySnapshot,
    loadOAuthSnapshots,
    _models: { GuildSnapshot, ConnectionSnapshot, MemberSnapshot }
};
