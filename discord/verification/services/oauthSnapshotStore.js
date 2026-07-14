"use strict";

const crypto = require("node:crypto");
const GuildSnapshot = require("../models/OAuthUserGuildSnapshot");
const ConnectionSnapshot = require("../models/OAuthUserConnectionSnapshot");
const MemberSnapshot = require("../models/OAuthMemberSnapshot");
const MemberRoleSnapshot = require("../models/OAuthMemberRoleSnapshot");
const ProfileSnapshot = require("../models/OAuthUserProfileSnapshot");
const ObjectChunkSnapshot = require("../models/OAuthObjectChunkSnapshot");
const SnapshotRecovery = require("../models/OAuthSnapshotRecovery");
const { jsonBytes, DEFAULT_MAX_BYTES, MAX_MAX_BYTES } = require("./snapshotBudget");

const DOCUMENT_MAX_BYTES = DEFAULT_MAX_BYTES;
const DOCUMENT_SAFETY_MARGIN_BYTES = Math.min(
    32 * 1024,
    Math.max(1024, Math.floor(DOCUMENT_MAX_BYTES * 0.01))
);
const DOCUMENT_WRITE_MAX_BYTES = Math.max(
    64 * 1024,
    DOCUMENT_MAX_BYTES - DOCUMENT_SAFETY_MARGIN_BYTES
);
const CHUNK_MAX_BYTES = Math.min(
    DOCUMENT_WRITE_MAX_BYTES,
    Math.max(64 * 1024, Number(process.env.OAUTH_SNAPSHOT_CHUNK_MAX_BYTES || 512 * 1024) || 512 * 1024)
);
const CHUNK_MAX_ITEMS = Math.max(
    1,
    Math.min(500, Number(process.env.OAUTH_SNAPSHOT_CHUNK_MAX_ITEMS || 100) || 100)
);
const OBJECT_CHUNK_RAW_BYTES = Math.max(
    8 * 1024,
    Math.min(
        512 * 1024,
        Math.floor(DOCUMENT_WRITE_MAX_BYTES * 0.55),
        Number(process.env.OAUTH_OBJECT_CHUNK_RAW_BYTES || 384 * 1024) || 384 * 1024
    )
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

function sanitizedFailureCode(err, fallback = "operation_failed") {
    const code = String(err?.code || err?.name || fallback)
        .replace(/[^a-zA-Z0-9._:-]/g, "_")
        .slice(0, 80);
    return code || fallback;
}

function documentSetBytes(documentSet) {
    return jsonBytes(documentSet);
}

function isDocumentSetSafe(documentSet, maxBytes = DOCUMENT_WRITE_MAX_BYTES) {
    const bytes = documentSetBytes(documentSet);
    return Number.isFinite(bytes) && bytes < maxBytes;
}

function assertDocumentSetSafe(documentSet, label = "snapshot_document") {
    const bytes = documentSetBytes(documentSet);
    if (!Number.isFinite(bytes) || bytes >= DOCUMENT_WRITE_MAX_BYTES) {
        const error = new Error(`${label} exceeds the per-document budget`);
        error.code = "snapshot_document_too_large";
        error.bytes = bytes;
        error.maxBytes = DOCUMENT_WRITE_MAX_BYTES;
        throw error;
    }
    return { ok: true, bytes, maxBytes: DOCUMENT_WRITE_MAX_BYTES };
}

function chunkItems(items = [], {
    maxBytes = CHUNK_MAX_BYTES,
    maxItems = CHUNK_MAX_ITEMS,
    hardMaxBytes = DOCUMENT_WRITE_MAX_BYTES,
    buildDocument = (chunk, chunkIndex) => ({ chunkIndex, items: chunk })
} = {}) {
    const source = Array.isArray(items) ? items : [];
    const chunks = [];
    let current = [];

    const assertSingleItemFits = (item, chunkIndex) => {
        const documentSet = buildDocument([item], chunkIndex);
        const bytes = documentSetBytes(documentSet);
        if (!Number.isFinite(bytes) || bytes >= hardMaxBytes) {
            const error = new Error("snapshot item cannot fit in a normal document envelope");
            error.code = "snapshot_item_document_too_large";
            error.bytes = bytes;
            error.maxBytes = hardMaxBytes;
            throw error;
        }
    };

    for (const item of source) {
        assertSingleItemFits(item, chunks.length);
        const candidate = [...current, item];
        const candidateBytes = documentSetBytes(buildDocument(candidate, chunks.length));
        const wouldOverflowTarget = current.length > 0 && (
            current.length >= maxItems ||
            !Number.isFinite(candidateBytes) ||
            candidateBytes > maxBytes
        );
        if (wouldOverflowTarget) {
            chunks.push(current);
            current = [item];
        } else {
            current = candidate;
        }
    }

    if (current.length || source.length === 0) chunks.push(current);
    for (let index = 0; index < chunks.length; index++) {
        const bytes = documentSetBytes(buildDocument(chunks[index], index));
        if (!Number.isFinite(bytes) || bytes >= hardMaxBytes) {
            const error = new Error("snapshot chunk exceeds the normal document envelope");
            error.code = "snapshot_document_too_large";
            error.bytes = bytes;
            error.maxBytes = hardMaxBytes;
            throw error;
        }
    }
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
    const safeRawBytes = Math.max(1, Math.floor(Number(maxRawBytes) || OBJECT_CHUNK_RAW_BYTES));
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += safeRawBytes) {
        const part = bytes.subarray(offset, Math.min(bytes.length, offset + safeRawBytes));
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

function buildObjectChunkSet(common, encoded, chunk, chunkIndex) {
    return {
        ...common,
        chunkIndex,
        payloadBase64: chunk.data,
        chunkByteLength: chunk.byteLength,
        chunkSha256: chunk.sha256,
        payloadByteLength: encoded.byteLength,
        payloadSha256: encoded.sha256
    };
}

function prepareObjectChunkWrites({
    kind,
    userId,
    guildId,
    version,
    value,
    returnedCount,
    source,
    now
}) {
    let rawBytes = OBJECT_CHUNK_RAW_BYTES;
    for (let attempt = 0; attempt < 12; attempt++) {
        const encoded = encodeObjectChunks(value, rawBytes);
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
        const documentSets = encoded.chunks.map((chunk, chunkIndex) =>
            buildObjectChunkSet(common, encoded, chunk, chunkIndex)
        );
        if (documentSets.every(documentSet => isDocumentSetSafe(documentSet))) {
            return { encoded, common, documentSets };
        }
        rawBytes = Math.floor(rawBytes * 0.7);
        if (rawBytes < 1024) break;
    }
    const error = new Error("object snapshot chunks cannot fit the per-document budget");
    error.code = "snapshot_object_chunk_document_too_large";
    error.maxBytes = DOCUMENT_WRITE_MAX_BYTES;
    throw error;
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
    const prepared = prepareObjectChunkWrites({
        kind,
        userId,
        guildId,
        version,
        value,
        returnedCount,
        source,
        now
    });
    const { encoded, common, documentSets } = prepared;
    documentSets.forEach(documentSet => assertDocumentSetSafe(documentSet, `${kind}_object_chunk`));

    await retrySnapshotWrite("snapshot_object_chunk_write", () => ObjectChunkSnapshot.bulkWrite(
        documentSets.map((documentSet, chunkIndex) => ({
            updateOne: {
                filter: { userId, snapshotVersion: version, kind, chunkIndex },
                update: { $set: documentSet },
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

function buildArrayChunkSet(common, chunk, chunkIndex) {
    return {
        ...common,
        chunkIndex,
        items: chunk,
        itemCount: chunk.length
    };
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
    try {
        let chunks;
        try {
            chunks = chunkItems(itemList, {
                buildDocument: (chunk, chunkIndex) => buildArrayChunkSet(common, chunk, chunkIndex)
            });
        } catch (err) {
            if (!["snapshot_item_document_too_large", "snapshot_document_too_large"].includes(err?.code)) {
                throw err;
            }
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
        const documentSets = chunks.map((chunk, chunkIndex) =>
            buildArrayChunkSet(common, chunk, chunkIndex)
        );
        documentSets.forEach(documentSet => assertDocumentSetSafe(documentSet, `${kind}_array_chunk`));
        await retrySnapshotWrite("snapshot_array_chunk_write", () => Model.bulkWrite(
            documentSets.map((documentSet, chunkIndex) => ({
                updateOne: {
                    filter: { userId, snapshotVersion: version, chunkIndex },
                    update: { $set: documentSet },
                    upsert: true
                }
            })),
            { ordered: true }
        ));
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

function buildMemberDocumentSet({ userId, guildId, version, memberCore, roleRef, roleCount, now }) {
    return {
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
    };
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
        const documentSet = buildMemberDocumentSet({
            userId,
            guildId,
            version,
            memberCore,
            roleRef,
            roleCount,
            now
        });
        if (!isDocumentSetSafe(documentSet)) {
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
        assertDocumentSetSafe(documentSet, "member_snapshot");
        await retrySnapshotWrite("snapshot_member_write", () => MemberSnapshot.findOneAndUpdate(
            { userId, guildId, snapshotVersion: version },
            { $set: documentSet },
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
            documentBytes: documentSetBytes(documentSet),
            sha256: null,
            roleRef,
            roleReturnedCount: roleRef.returnedCount,
            roleStoredCount: roleRef.storedCount,
            roleChunkCount: roleRef.chunkCount
        };
    } catch (err) {
        logSnapshotFailure("member", err);
        return { ...failedMeta("member", version, 1, err, now), guildId, roleRef };
    }
}

function buildProfileDocumentSet({ userId, version, profile, now }) {
    return {
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
    };
}

async function storeProfileSnapshot({ userId, version, profile, now = Date.now() }) {
    try {
        const documentSet = buildProfileDocumentSet({ userId, version, profile, now });
        if (!isDocumentSetSafe(documentSet)) {
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
        assertDocumentSetSafe(documentSet, "profile_snapshot");
        await retrySnapshotWrite("snapshot_profile_write", () => ProfileSnapshot.findOneAndUpdate(
            { userId, snapshotVersion: version },
            { $set: documentSet },
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
            documentBytes: documentSetBytes(documentSet),
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

function defaultRollbackModels() {
    return {
        guilds: GuildSnapshot,
        connections: ConnectionSnapshot,
        memberRoles: MemberRoleSnapshot,
        member: MemberSnapshot,
        profile: ProfileSnapshot,
        objectChunks: ObjectChunkSnapshot
    };
}

function invalidateSnapshotRefs(value, version) {
    if (!value || typeof value !== "object") return;
    if (value.version === version) {
        value.complete = false;
        value.storedCount = 0;
        value.failureReason = value.failureReason || "snapshot_set_incomplete";
        value.fetchStatus = "failed";
    }
    for (const child of Object.values(value)) invalidateSnapshotRefs(child, version);
}

async function rollbackModel(name, Model, filter, now) {
    const result = {
        model: name,
        complete: false,
        markIncomplete: { attempted: false, complete: false, code: null },
        delete: { attempted: false, complete: false, code: null, deletedCount: 0 },
        failureCodes: []
    };
    if (typeof Model?.updateMany === "function") {
        result.markIncomplete.attempted = true;
        try {
            await retrySnapshotWrite(`rollback_${name}_mark`, () => Model.updateMany(filter, {
                $set: {
                    complete: false,
                    failureReason: "snapshot_set_incomplete",
                    updatedAt: now
                }
            }));
            result.markIncomplete.complete = true;
        } catch (err) {
            result.markIncomplete.code = sanitizedFailureCode(err, `rollback_${name}_mark_failed`);
            result.failureCodes.push(result.markIncomplete.code);
        }
    }
    if (typeof Model?.deleteMany === "function") {
        result.delete.attempted = true;
        try {
            const deleted = await retrySnapshotWrite(`rollback_${name}_delete`, () => Model.deleteMany(filter));
            result.delete.complete = true;
            result.delete.deletedCount = Number(deleted?.deletedCount || 0);
        } catch (err) {
            result.delete.code = sanitizedFailureCode(err, `rollback_${name}_delete_failed`);
            result.failureCodes.push(result.delete.code);
        }
    }
    const markComplete = !result.markIncomplete.attempted || result.markIncomplete.complete === true;
    const deleteComplete = !result.delete.attempted || result.delete.complete === true;
    result.complete = markComplete && deleteComplete && result.delete.attempted;
    return result;
}

async function persistRecoveryMetadata(RecoveryModel, metadata, now) {
    if (typeof RecoveryModel?.findOneAndUpdate !== "function") return false;
    await retrySnapshotWrite("rollback_recovery_metadata", () => RecoveryModel.findOneAndUpdate(
        { userId: metadata.userId, snapshotVersion: metadata.version },
        {
            $set: {
                complete: false,
                attemptedModels: metadata.attemptedModels,
                failedModels: metadata.failedModels,
                failureCodes: metadata.failureCodes,
                operationResults: metadata.operationResults,
                lastAttemptAt: now,
                updatedAt: now
            },
            $inc: { retryCount: 1 },
            $setOnInsert: { createdAt: now }
        },
        { upsert: true, new: true }
    ));
    return true;
}

async function clearRecoveryMetadata(RecoveryModel, userId, version) {
    if (typeof RecoveryModel?.deleteOne !== "function") return false;
    await retrySnapshotWrite("rollback_recovery_clear", () =>
        RecoveryModel.deleteOne({ userId, snapshotVersion: version })
    );
    return true;
}

function logRollbackWarning(metadata) {
    console.warn("[SNAPSHOT] rollback incomplete:", JSON.stringify({
        failedModels: metadata.failedModels,
        failureCodes: metadata.failureCodes,
        recoveryPersisted: metadata.recoveryPersisted
    }));
}

async function rollbackSnapshotVersion({
    userId,
    version,
    refs = {},
    models = defaultRollbackModels(),
    RecoveryModel = SnapshotRecovery,
    persistRecovery = true,
    now = Date.now()
}) {
    const entries = Object.entries(models);
    const operationResults = await Promise.all(entries.map(([name, Model]) =>
        rollbackModel(name, Model, { userId, snapshotVersion: version }, now)
    ));
    const attemptedModels = operationResults.map(result => result.model);
    const failedModels = operationResults
        .filter(result => result.complete !== true)
        .map(result => result.model);
    const failureCodes = [...new Set(operationResults.flatMap(result => result.failureCodes))];
    const complete = failedModels.length === 0;
    invalidateSnapshotRefs(refs, version);

    const metadata = {
        userId,
        version,
        complete,
        attemptedModels,
        failedModels,
        failureCodes,
        operationResults: Object.fromEntries(operationResults.map(result => [result.model, result])),
        recoveryRequired: !complete,
        recoveryPersisted: false,
        recoveryRecordCleared: false
    };

    if (complete) {
        try {
            metadata.recoveryRecordCleared = await clearRecoveryMetadata(RecoveryModel, userId, version);
        } catch (err) {
            metadata.failureCodes.push(sanitizedFailureCode(err, "rollback_recovery_clear_failed"));
        }
        return metadata;
    }

    if (persistRecovery) {
        try {
            metadata.recoveryPersisted = await persistRecoveryMetadata(RecoveryModel, metadata, now);
        } catch (err) {
            metadata.recoveryPersisted = false;
            metadata.failureCodes.push(sanitizedFailureCode(err, "rollback_recovery_metadata_failed"));
        }
    } else {
        metadata.recoveryPersisted = false;
    }
    logRollbackWarning(metadata);
    return metadata;
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
    const rollback = complete
        ? null
        : await rollbackSnapshotVersion({ userId, version, refs, now });
    return {
        version,
        complete,
        expectedKinds: keys,
        rollback,
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

function emptySnapshotResult() {
    return { profile: null, guilds: null, connections: null, member: null };
}

async function resolveProfileSnapshot(safeUserId, ref) {
    if (!ref?.version || ref.complete !== true) return null;
    if (ref.format === "json-base64-chunks-v1") {
        return loadObjectChunkSnapshot(safeUserId, ref, { kind: "profile" });
    }
    const version = safeSnapshotKey(ref.version, /^[a-zA-Z0-9._:-]+$/, 120);
    if (!version) return null;
    const document = await snapshotQuery(ProfileSnapshot, safeUserId, version).findOne().lean();
    return document?.snapshot || null;
}

async function resolveMemberSnapshot(safeUserId, ref, guildId) {
    if (!ref?.version || ref.complete !== true) return null;
    const safeGuildId = safeSnapshotKey(ref.guildId || guildId, /^(?:\d{17,22}|legacy)$/, 22);
    if (!safeGuildId) return null;
    if (ref.format === "json-base64-chunks-v1") {
        const snapshot = await loadObjectChunkSnapshot(safeUserId, ref, {
            kind: "member",
            guildId: safeGuildId
        });
        return snapshot ? { snapshot, roleSnapshotRef: ref.roleRef } : null;
    }
    const version = safeSnapshotKey(ref.version, /^[a-zA-Z0-9._:-]+$/, 120);
    if (!version) return null;
    return snapshotQuery(MemberSnapshot, safeUserId, version)
        .where("guildId").equals(safeGuildId)
        .findOne()
        .lean();
}

async function hydrateMemberRoles(safeUserId, memberDocument, memberRef) {
    if (!memberDocument) return null;
    const memberValue = memberDocument.snapshot || null;
    const roleRef = memberDocument.roleSnapshotRef || memberRef?.roleRef;
    const roles = roleRef
        ? await loadArraySnapshot(MemberRoleSnapshot, safeUserId, roleRef)
        : memberDocument.snapshot?.roles;
    if (!Array.isArray(roles)) return null;
    return {
        ...memberValue,
        roles,
        roleCount: roles.length,
        snapshot: memberValue?.snapshot && typeof memberValue.snapshot === "object"
            ? { ...memberValue.snapshot, roles }
            : memberValue?.snapshot
    };
}

async function loadOAuthSnapshots({ userId, refs = {}, guildId = null }) {
    const safeUserId = safeSnapshotKey(userId, /^\d{17,22}$/, 22);
    if (!safeUserId) return emptySnapshotResult();
    const [profile, guilds, connections, memberDocument] = await Promise.all([
        resolveProfileSnapshot(safeUserId, refs.profile),
        loadArraySnapshot(GuildSnapshot, safeUserId, refs.guilds),
        loadArraySnapshot(ConnectionSnapshot, safeUserId, refs.connections),
        resolveMemberSnapshot(safeUserId, refs.member, guildId)
    ]);
    const member = await hydrateMemberRoles(safeUserId, memberDocument, refs.member);
    return { profile, guilds, connections, member };
}

module.exports = {
    CHUNK_MAX_BYTES,
    CHUNK_MAX_ITEMS,
    OBJECT_CHUNK_RAW_BYTES,
    WRITE_RETRY_ATTEMPTS,
    DOCUMENT_MAX_BYTES,
    DOCUMENT_WRITE_MAX_BYTES,
    MAX_MAX_BYTES,
    createSnapshotVersion,
    documentSetBytes,
    isDocumentSetSafe,
    assertDocumentSetSafe,
    chunkItems,
    encodeObjectChunks,
    prepareObjectChunkWrites,
    storeObjectChunkSnapshot,
    loadObjectChunkSnapshot,
    storeArraySnapshot,
    storeProfileSnapshot,
    storeMemberSnapshot,
    storeOAuthSnapshots,
    loadArraySnapshot,
    emptySnapshotResult,
    resolveProfileSnapshot,
    resolveMemberSnapshot,
    hydrateMemberRoles,
    loadOAuthSnapshots,
    rollbackSnapshotVersion,
    _models: {
        GuildSnapshot,
        ConnectionSnapshot,
        MemberSnapshot,
        MemberRoleSnapshot,
        ProfileSnapshot,
        ObjectChunkSnapshot,
        SnapshotRecovery
    }
};
