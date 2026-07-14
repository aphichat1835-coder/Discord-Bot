"use strict";

const crypto = require("node:crypto");
const GuildSnapshot = require("../models/OAuthUserGuildSnapshot");
const ConnectionSnapshot = require("../models/OAuthUserConnectionSnapshot");
const MemberSnapshot = require("../models/OAuthMemberSnapshot");
const MemberRoleSnapshot = require("../models/OAuthMemberRoleSnapshot");
const ProfileSnapshot = require("../models/OAuthUserProfileSnapshot");
const ObjectChunkSnapshot = require("../models/OAuthObjectChunkSnapshot");
const { jsonBytes, MAX_MAX_BYTES } = require("./snapshotBudget");

const CHUNK_MAX_BYTES = Math.min(
    MAX_MAX_BYTES,
    Math.max(64 * 1024, Number(process.env.OAUTH_SNAPSHOT_CHUNK_MAX_BYTES || 512 * 1024) || 512 * 1024)
);
const CHUNK_MAX_ITEMS = Math.max(
    1,
    Math.min(500, Number(process.env.OAUTH_SNAPSHOT_CHUNK_MAX_ITEMS || 100) || 100)
);
const OBJECT_CHUNK_RAW_BYTES = Math.max(
    32 * 1024,
    Math.min(512 * 1024, Number(process.env.OAUTH_OBJECT_CHUNK_RAW_BYTES || 384 * 1024) || 384 * 1024)
);
const WRITE_RETRY_ATTEMPTS = Math.max(
    1,
    Math.min(8, Number(process.env.OAUTH_SNAPSHOT_WRITE_RETRY_ATTEMPTS || 3) || 3)
);
const WRITE_RETRY_DELAY_MS = Math.max(
    0,
    Math.min(10_000, Number(process.env.OAUTH_SNAPSHOT_WRITE_RETRY_DELAY_MS || 150) || 150)
);

function createSnapshotVersion(now = Date.now()) {
    return `${now}-${crypto.randomBytes(6).toString("hex")}`;
}

function delay(ms) {
    if (!ms) return Promise.resolve();
    return new Promise(resolve => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}

async function retrySnapshotWrite(label, operation) {
    let lastError = null;
    for (let attempt = 1; attempt <= WRITE_RETRY_ATTEMPTS; attempt++) {
        try {
            return await operation(attempt);
        } catch (err) {
            lastError = err;
            if (attempt >= WRITE_RETRY_ATTEMPTS) break;
            await delay(WRITE_RETRY_DELAY_MS * attempt);
        }
    }
    if (lastError && !lastError.code) lastError.code = `${label}_failed`;
    throw lastError || Object.assign(new Error(`${label} failed`), { code: `${label}_failed` });
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
        format: meta.format || "mixed-items-v1",
        returnedCount: meta.returnedCount,
        storedCount: meta.storedCount,
        chunkCount: meta.chunkCount,
        complete: meta.complete,
        fetchStatus: meta.fetchStatus,
        failureReason: meta.failureReason,
        source: meta.source,
        capturedAt: meta.capturedAt,
        byteLength: meta.byteLength ?? null,
        sha256: meta.sha256 || null
    };
}

function failedMeta(kind, version, returnedCount, err, now) {
    return {
        kind,
        version,
        format: err?.format || null,
        returnedCount,
        storedCount: 0,
        chunkCount: 0,
        complete: false,
        fetchStatus: "failed",
        failureReason: String(err?.code || "snapshot_write_failed").slice(0, 120),
        source: "discord_oauth",
        capturedAt: now,
        byteLength: Number.isFinite(Number(err?.bytes)) ? Number(err.bytes) : null,
        sha256: null
    };
}

function logSnapshotFailure(kind, err) {
    const details = {
        kind: String(kind || "snapshot").slice(0, 40),
        code: String(err?.code || "snapshot_write_failed").slice(0, 80),
        name: String(err?.name || "Error").slice(0, 80)
    };
    console.error("[SNAPSHOT] write failed:", JSON.stringify(details));
}

function encodeObjectChunks(value, maxRawBytes = OBJECT_CHUNK_RAW_BYTES) {
    const json = JSON.stringify(value);
    if (json === undefined) {
        const err = new Error("snapshot payload is not serializable");
        err.code = "snapshot_not_serializable";
        throw err;
    }
    const bytes = Buffer.from(json, "utf8");
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += maxRawBytes) {
        const part = bytes.subarray(offset, Math.min(bytes.length, offset + maxRawBytes));
        chunks.push({
            data: part.toString("base64"),
            byteLength: part.length,
            sha256: crypto.createHash("sha256").update(part).digest("hex")
        });
    }
    if (!chunks.length) {
        const empty = Buffer.from("null", "utf8");
        chunks.push({
            data: empty.toString("base64"),
            byteLength: empty.length,
            sha256: crypto.createHash("sha256").update(empty).digest("hex")
        });
    }
    return {
        chunks,
        byteLength: bytes.length,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex")
    };
}

async function storeObjectChunkSnapshot({
    kind,
    userId,
    guildId = null,
    version,
    value,
    returnedCount = 1,
    source = "discord_oauth",
    now = Date.now()
}) {
    const encoded = encodeObjectChunks(value);
    const common = {
        userId,
        guildId: guildId || null,
        snapshotVersion: version,
        kind,
        chunkCount: encoded.chunks.length,
        returnedCount,
        storedCount: returnedCount,
        complete: false,
        fetchStatus: "success",
        failureReason: null,
        source,
        capturedAt: now,
        updatedAt: now
    };

    await retrySnapshotWrite("snapshot_object_chunk_write", () => ObjectChunkSnapshot.bulkWrite(
        encoded.chunks.map((chunk, chunkIndex) => ({
            updateOne: {
                filter: { userId, snapshotVersion: version, kind, chunkIndex },
                update: {
                    $set: {
                        ...common,
                        chunkIndex,
                        payloadBase64: chunk.data,
                        chunkByteLength: chunk.byteLength,
                        chunkSha256: chunk.sha256,
                        payloadByteLength: encoded.byteLength,
                        payloadSha256: encoded.sha256
                    }
                },
                upsert: true
            }
        })),
        { ordered: true }
    ));

    const finalized = await retrySnapshotWrite("snapshot_object_chunk_finalize", () =>
        ObjectChunkSnapshot.updateMany(
            { userId, snapshotVersion: version, kind },
            { $set: { complete: true, updatedAt: now } }
        )
    );
    const complete = Number(finalized?.matchedCount || 0) === encoded.chunks.length;
    if (!complete) {
        const err = new Error("object snapshot finalization incomplete");
        err.code = "snapshot_finalize_incomplete";
        throw err;
    }

    return successfulRef(kind, version, {
        ...common,
        format: "json-base64-chunks-v1",
        complete: true,
        chunkCount: encoded.chunks.length,
        byteLength: encoded.byteLength,
        sha256: encoded.sha256
    });
}

async function loadObjectChunkSnapshot(userId, ref, { kind = ref?.kind, guildId = null } = {}) {
    if (!ref?.version || ref.complete !== true || ref.format !== "json-base64-chunks-v1") return null;
    const query = ObjectChunkSnapshot.find({
        userId,
        snapshotVersion: ref.version,
        kind,
        complete: true,
        ...(guildId ? { guildId } : {})
    }).sort({ chunkIndex: 1 });
    const docs = await query.lean();
    if (docs.length !== Number(ref.chunkCount || 0)) return null;
    const parts = [];
    for (let index = 0; index < docs.length; index++) {
        const doc = docs[index];
        if (Number(doc.chunkIndex) !== index) return null;
        const part = Buffer.from(String(doc.payloadBase64 || ""), "base64");
        const checksum = crypto.createHash("sha256").update(part).digest("hex");
        if (doc.chunkSha256 && checksum !== doc.chunkSha256) return null;
        parts.push(part);
    }
    const payload = Buffer.concat(parts);
    if (payload.length !== Number(ref.byteLength || payload.length)) return null;
    const payloadChecksum = crypto.createHash("sha256").update(payload).digest("hex");
    if (ref.sha256 && payloadChecksum !== ref.sha256) return null;
    try {
        return JSON.parse(payload.toString("utf8"));
    } catch {
        return null;
    }
}

async function storeArraySnapshot(Model, {
    kind,
    userId,
    version,
    items,
    source = "discord_oauth",
    now = Date.now()
}) {
    const itemList = Array.isArray(items) ? items : [];
    try {
        let chunks;
        try {
            chunks = chunkItems(itemList);
        } catch (err) {
            if (err?.code !== "snapshot_item_too_large") throw err;
            return await storeObjectChunkSnapshot({
                kind,
                userId,
                version,
                value: itemList,
                returnedCount: itemList.length,
                source,
                now
            });
        }
        const common = {
            userId,
            snapshotVersion: version,
            returnedCount: itemList.length,
            storedCount: itemList.length,
            complete: false,
            fetchStatus: "success",
            failureReason: null,
            source,
            capturedAt: now,
            updatedAt: now
        };
        await retrySnapshotWrite("snapshot_array_chunk_write", () => Model.bulkWrite(chunks.map((chunk, chunkIndex) => ({
            updateOne: {
                filter: { userId, snapshotVersion: version, chunkIndex },
                update: { $set: { ...common, chunkIndex, items: chunk, itemCount: chunk.length } },
                upsert: true
            }
        })), { ordered: true }));
        const finalized = await retrySnapshotWrite("snapshot_array_chunk_finalize", () => Model.updateMany(
            { userId, snapshotVersion: version },
            { $set: { complete: true, updatedAt: now } }
        ));
        const complete = Number(finalized?.matchedCount || 0) === chunks.length;
        const meta = {
            ...common,
            complete,
            storedCount: complete ? common.storedCount : 0,
            chunkCount: chunks.length,
            failureReason: complete ? null : "snapshot_finalize_incomplete",
            format: "mixed-items-v1"
        };
        if (!complete) logSnapshotFailure(kind, { code: meta.failureReason });
        return successfulRef(kind, version, meta);
    } catch (err) {
        logSnapshotFailure(kind, err);
        return failedMeta(kind, version, itemList.length, err, now);
    }
}

async function storeMemberSnapshot({ userId, guildId, version, member, now = Date.now() }) {
    const sourceRoles = Array.isArray(member?.roles)
        ? member.roles
        : member?.snapshot?.roles;
    const roles = Array.isArray(sourceRoles) ? sourceRoles.map(String) : [];
    const memberCore = { ...member };
    delete memberCore.roles;
    if (memberCore.snapshot && typeof memberCore.snapshot === "object") {
        const rawMemberCore = { ...memberCore.snapshot };
        delete rawMemberCore.roles;
        memberCore.snapshot = rawMemberCore;
    }
    const roleRef = await storeArraySnapshot(MemberRoleSnapshot, {
        kind: "memberRoles",
        userId,
        version,
        items: roles,
        source: "discord_bot_api",
        now
    });
    const roleCount = roles.length;
    if (!roleRef.complete || roleRef.returnedCount !== roleRef.storedCount) {
        return {
            ...failedMeta("member", version, 1, {
                code: roleRef.failureReason || "member_roles_incomplete"
            }, now),
            guildId,
            roleRef
        };
    }
    try {
        if (jsonBytes(memberCore) > MAX_MAX_BYTES) {
            const ref = await storeObjectChunkSnapshot({
                kind: "member",
                userId,
                guildId,
                version,
                value: memberCore,
                returnedCount: 1,
                source: "discord_bot_api",
                now
            });
            return {
                ...ref,
                guildId,
                roleRef,
                roleReturnedCount: roleRef.returnedCount,
                roleStoredCount: roleRef.storedCount,
                roleChunkCount: roleRef.chunkCount
            };
        }
        await retrySnapshotWrite("snapshot_member_write", () => MemberSnapshot.findOneAndUpdate(
            { userId, guildId, snapshotVersion: version },
            {
                $set: {
                    userId,
                    guildId,
                    snapshotVersion: version,
                    snapshot: memberCore,
                    roleSnapshotRef: roleRef,
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
        ));
        const finalized = await retrySnapshotWrite("snapshot_member_finalize", () => MemberSnapshot.updateOne(
            { userId, guildId, snapshotVersion: version },
            { $set: { complete: true, updatedAt: now } }
        ));
        const complete = Number(finalized?.matchedCount || 0) === 1;
        if (!complete) logSnapshotFailure("member", { code: "snapshot_finalize_incomplete" });
        return {
            kind: "member",
            format: "mixed-document-v1",
            version,
            guildId,
            returnedCount: 1,
            storedCount: complete ? 1 : 0,
            chunkCount: 1,
            complete,
            fetchStatus: complete ? "success" : "failed",
            failureReason: complete ? null : "snapshot_finalize_incomplete",
            source: "discord_bot_api",
            capturedAt: now,
            byteLength: jsonBytes(memberCore),
            sha256: null,
            roleRef,
            roleReturnedCount: roleRef.returnedCount,
            roleStoredCount: roleRef.storedCount,
            roleChunkCount: roleRef.chunkCount
        };
    } catch (err) {
        logSnapshotFailure("member", err);
        return { ...failedMeta("member", version, 1, err, now), guildId };
    }
}

async function storeProfileSnapshot({ userId, version, profile, now = Date.now() }) {
    try {
        if (jsonBytes(profile) > MAX_MAX_BYTES) {
            return await storeObjectChunkSnapshot({
                kind: "profile",
                userId,
                version,
                value: profile,
                returnedCount: 1,
                source: "discord_oauth",
                now
            });
        }
        await retrySnapshotWrite("snapshot_profile_write", () => ProfileSnapshot.findOneAndUpdate(
            { userId, snapshotVersion: version },
            {
                $set: {
                    userId,
                    snapshotVersion: version,
                    snapshot: profile,
                    returnedCount: 1,
                    storedCount: 1,
                    complete: false,
                    fetchStatus: "success",
                    failureReason: null,
                    source: "discord_oauth",
                    capturedAt: now,
                    updatedAt: now
                }
            },
            { upsert: true, new: true }
        ));
        const finalized = await retrySnapshotWrite("snapshot_profile_finalize", () => ProfileSnapshot.updateOne(
            { userId, snapshotVersion: version },
            { $set: { complete: true, updatedAt: now } }
        ));
        const complete = Number(finalized?.matchedCount || 0) === 1;
        if (!complete) logSnapshotFailure("profile", { code: "snapshot_finalize_incomplete" });
        return {
            kind: "profile",
            format: "mixed-document-v1",
            version,
            returnedCount: 1,
            storedCount: complete ? 1 : 0,
            chunkCount: 1,
            complete,
            fetchStatus: complete ? "success" : "failed",
            failureReason: complete ? null : "snapshot_finalize_incomplete",
            source: "discord_oauth",
            capturedAt: now,
            byteLength: jsonBytes(profile),
            sha256: null
        };
    } catch (err) {
        logSnapshotFailure("profile", err);
        return failedMeta("profile", version, 1, err, now);
    }
}

function isCompleteRef(ref) {
    return ref?.complete === true && Number(ref.returnedCount || 0) === Number(ref.storedCount || 0);
}

async function rollbackSnapshotVersion({ userId, version, refs = {} }) {
    const operations = [
        [GuildSnapshot, { userId, snapshotVersion: version }],
        [ConnectionSnapshot, { userId, snapshotVersion: version }],
        [MemberRoleSnapshot, { userId, snapshotVersion: version }],
        [MemberSnapshot, { userId, snapshotVersion: version }],
        [ProfileSnapshot, { userId, snapshotVersion: version }],
        [ObjectChunkSnapshot, { userId, snapshotVersion: version }]
    ];
    await Promise.allSettled(operations.map(async ([Model, filter]) => {
        if (typeof Model.updateMany === "function") {
            await Model.updateMany(filter, {
                $set: {
                    complete: false,
                    failureReason: "snapshot_set_incomplete",
                    updatedAt: Date.now()
                }
            });
        }
        if (typeof Model.deleteMany === "function") await Model.deleteMany(filter);
    }));
    for (const ref of Object.values(refs)) {
        if (ref && typeof ref === "object") {
            ref.complete = false;
            ref.storedCount = 0;
            ref.failureReason = ref.failureReason || "snapshot_set_incomplete";
            ref.fetchStatus = "failed";
        }
    }
}

async function storeOAuthSnapshots({
    userId,
    guildId,
    profile,
    guilds,
    connections,
    member,
    fetchMetadata = {},
    now = Date.now()
}) {
    const version = createSnapshotVersion(now);
    const tasks = {};
    if (profile) tasks.profile = storeProfileSnapshot({ userId, version, profile, now });
    if (!fetchMetadata.guildsFetchFailed) {
        tasks.guilds = storeArraySnapshot(GuildSnapshot, { kind: "guilds", userId, version, items: guilds, now });
    }
    if (!fetchMetadata.connectionsFetchFailed) {
        tasks.connections = storeArraySnapshot(ConnectionSnapshot, {
            kind: "connections", userId, version, items: connections, now
        });
    }
    if (member) tasks.member = storeMemberSnapshot({ userId, guildId, version, member, now });

    const keys = Object.keys(tasks);
    const values = await Promise.all(Object.values(tasks));
    const refs = Object.fromEntries(keys.map((key, index) => [key, values[index]]));
    const complete = keys.length > 0 && keys.every(key => isCompleteRef(refs[key]));
    if (!complete) await rollbackSnapshotVersion({ userId, version, refs });
    return {
        version,
        complete,
        expectedKinds: keys,
        ...refs
    };
}

function safeSnapshotKey(value, pattern, maxLength) {
    const text = String(value || "");
    return text.length <= maxLength && pattern.test(text) ? text : null;
}

function snapshotQuery(Model, userId, version) {
    return Model.find()
        .where("userId").equals(userId)
        .where("snapshotVersion").equals(version)
        .where("complete").equals(true);
}

async function loadArraySnapshot(Model, userId, ref) {
    if (!ref?.version || ref.complete !== true) return null;
    const safeUserId = safeSnapshotKey(userId, /^\d{17,22}$/, 22);
    const safeVersion = safeSnapshotKey(ref.version, /^[a-zA-Z0-9._:-]+$/, 120);
    if (!safeUserId || !safeVersion) return null;
    if (ref.format === "json-base64-chunks-v1") {
        const value = await loadObjectChunkSnapshot(safeUserId, ref, { kind: ref.kind });
        return Array.isArray(value) && value.length === Number(ref.storedCount || 0) ? value : null;
    }
    const docs = await snapshotQuery(Model, safeUserId, safeVersion)
        .sort({ chunkIndex: 1 })
        .lean();
    if (docs.length !== Number(ref.chunkCount || 0)) return null;
    const items = docs.flatMap(doc => Array.isArray(doc.items) ? doc.items : []);
    return items.length === Number(ref.storedCount || 0) ? items : null;
}

async function loadOAuthSnapshots({ userId, refs = {}, guildId = null }) {
    const safeUserId = safeSnapshotKey(userId, /^\d{17,22}$/, 22);
    if (!safeUserId) return { profile: null, guilds: null, connections: null, member: null };
    const profileVersion = safeSnapshotKey(refs.profile?.version, /^[a-zA-Z0-9._:-]+$/, 120);
    const memberVersion = safeSnapshotKey(refs.member?.version, /^[a-zA-Z0-9._:-]+$/, 120);
    const memberGuildId = safeSnapshotKey(
        refs.member?.guildId || guildId,
        /^(?:\d{17,22}|legacy)$/,
        22
    );
    const profilePromise = refs.profile?.format === "json-base64-chunks-v1"
        ? loadObjectChunkSnapshot(safeUserId, refs.profile, { kind: "profile" })
        : (profileVersion && refs.profile?.complete === true
            ? snapshotQuery(ProfileSnapshot, safeUserId, profileVersion).findOne().lean()
            : null);
    const memberPromise = refs.member?.format === "json-base64-chunks-v1"
        ? loadObjectChunkSnapshot(safeUserId, refs.member, { kind: "member", guildId: memberGuildId })
        : (memberVersion && memberGuildId && refs.member?.complete === true
            ? snapshotQuery(MemberSnapshot, safeUserId, memberVersion)
                .where("guildId").equals(memberGuildId)
                .findOne()
                .lean()
            : null);
    const [profileResult, guilds, connections, memberResult] = await Promise.all([
        profilePromise,
        loadArraySnapshot(GuildSnapshot, safeUserId, refs.guilds),
        loadArraySnapshot(ConnectionSnapshot, safeUserId, refs.connections),
        memberPromise
    ]);
    const profile = refs.profile?.format === "json-base64-chunks-v1"
        ? profileResult
        : profileResult?.snapshot || null;
    const memberDoc = refs.member?.format === "json-base64-chunks-v1"
        ? (memberResult ? { snapshot: memberResult, roleSnapshotRef: refs.member?.roleRef } : null)
        : memberResult;
    let memberValue = memberDoc?.snapshot || null;
    if (memberDoc) {
        const roleRef = memberDoc.roleSnapshotRef || refs.member?.roleRef;
        const roles = roleRef
            ? await loadArraySnapshot(MemberRoleSnapshot, safeUserId, roleRef)
            : memberDoc.snapshot?.roles;
        if (!Array.isArray(roles)) {
            return { profile, guilds, connections, member: null };
        }
        memberValue = {
            ...memberValue,
            roles,
            roleCount: roles.length,
            snapshot: memberValue?.snapshot && typeof memberValue.snapshot === "object"
                ? { ...memberValue.snapshot, roles }
                : memberValue?.snapshot
        };
    }
    return { profile, guilds, connections, member: memberValue };
}

module.exports = {
    CHUNK_MAX_BYTES,
    CHUNK_MAX_ITEMS,
    OBJECT_CHUNK_RAW_BYTES,
    WRITE_RETRY_ATTEMPTS,
    createSnapshotVersion,
    chunkItems,
    encodeObjectChunks,
    storeObjectChunkSnapshot,
    loadObjectChunkSnapshot,
    storeArraySnapshot,
    storeProfileSnapshot,
    storeMemberSnapshot,
    storeOAuthSnapshots,
    loadArraySnapshot,
    loadOAuthSnapshots,
    rollbackSnapshotVersion,
    _models: {
        GuildSnapshot,
        ConnectionSnapshot,
        MemberSnapshot,
        MemberRoleSnapshot,
        ProfileSnapshot,
        ObjectChunkSnapshot
    }
};
