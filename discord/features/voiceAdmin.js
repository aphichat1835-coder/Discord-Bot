"use strict";

const mongoose = require("mongoose");
const { ActionRowBuilder, AuditLogEvent, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, EmbedBuilder, PermissionFlagsBits } = require("discord.js");
const config = require("../config.json");
const { isConfiguredOwner } = require("../core/env");
const { markCommandAccepted } = require("../guards/commandGuards");
const { sendWebhookEvent } = require("../core/webhooks");

const ACTION_WORKER_LIMIT = 8;
const GLOBAL_ACTION_WORKER_LIMIT = 12;
const ACTION_MAX_DURATION_MS = 14 * 60 * 1000;
const NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const AUDIT_WAIT_MS = 1500;
const AUDIT_CACHE_WINDOW_MS = 5000;
const PROCESSED_AUDIT_WINDOW_MS = 15000;
const STOP_DRAIN_MS = 4000;
const ENFORCEMENT_RETRY_DELAYS_MS = Object.freeze([0, 1000, 3000]);
const MAX_AUDIT_CACHE_KEYS = 2000;
const MAX_PROCESSED_AUDIT_ENTRIES = 5000;
const MAX_NOTICE_POINTERS = 5000;
const IDS = Object.freeze({
    PREFIX: "voiceadmin:", DISCONNECT: "voiceadmin:disconnect", LOCK_MUTE: "voiceadmin:lock-mute",
    LOCK_DEAF: "voiceadmin:lock-deaf", UNLOCK_MUTE: "voiceadmin:unlock-mute",
    UNLOCK_DEAF: "voiceadmin:unlock-deaf", REFRESH: "voiceadmin:refresh", MOVE: "voiceadmin:move"
});

const voiceAdminLockSchema = new mongoose.Schema({
    guildId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    muteLocked: { type: Boolean, default: false },
    deafLocked: { type: Boolean, default: false },
    // Keep these two fields for records made by the first /voiceadmin release.
    lockedBy: { type: String, default: null },
    updatedAt: { type: Number, default: Date.now },
    muteLockedBy: { type: String, default: null },
    muteLockedAt: { type: Number, default: null },
    muteVersion: { type: String, default: null },
    muteOwnerForced: { type: Boolean, default: false },
    deafLockedBy: { type: String, default: null },
    deafLockedAt: { type: Number, default: null },
    deafVersion: { type: String, default: null }
}, { versionKey: false });
voiceAdminLockSchema.index({ guildId: 1, userId: 1 }, { unique: true });

const voiceAdminNoticeSchema = new mongoose.Schema({
    guildId: { type: String, required: true, index: true },
    actorId: { type: String, required: true, index: true },
    targetId: { type: String, required: true, index: true },
    channelId: { type: String, required: true },
    messageId: { type: String, required: true },
    notifiedAt: { type: Date, required: true }
}, { versionKey: false });
voiceAdminNoticeSchema.index({ guildId: 1, actorId: 1, targetId: 1 }, { unique: true });
voiceAdminNoticeSchema.index({ notifiedAt: 1 }, { expireAfterSeconds: 86400 });

const VoiceAdminLock = mongoose.models.VoiceAdminLock || mongoose.model("VoiceAdminLock", voiceAdminLockSchema);
const VoiceAdminNotice = mongoose.models.VoiceAdminNotice || mongoose.model("VoiceAdminNotice", voiceAdminNoticeSchema);
const locksByGuild = new Map();
const notices = new Map();
const activeGuildActions = new Map();
const pendingEnforcement = new Map();
const cachedAuditUnlocks = new Map();
const processedAuditEntries = new Map();
const auditWatermarks = new Map();
const noticeQueues = new Map();
const enforcementActions = new Map();
const sleepTimers = new Set();
const retiredGuilds = new Set();
const retiredMembers = new Set();
const globalActionWaiters = [];
let activeGlobalMemberOperations = 0;
let initialized = false;
let stopping = false;
let actionSequence = 0;
const BULK_SKIPPED = Symbol("VOICE_ADMIN_BULK_SKIPPED");

function lockKey(guildId, userId) { return `${guildId}:${userId}`; }
function noticeKey(guildId, actorId, targetId) { return `${guildId}:${actorId}:${targetId}`; }
function pendingKey(guildId, userId, type) { return `${guildId}:${userId}:${type}`; }
function isVoiceChannel(channel) { return channel?.type === ChannelType.GuildVoice; }
function fieldFor(type) { return type === "mute" ? "muteLocked" : "deafLocked"; }
function metadataFor(type) { return type === "mute" ? { by: "muteLockedBy", at: "muteLockedAt", version: "muteVersion" } : { by: "deafLockedBy", at: "deafLockedAt", version: "deafVersion" }; }
function createVersion() { return `${Date.now().toString(36)}-${(++actionSequence).toString(36)}`; }
function isRetiredTarget(guildId, userId) { return retiredGuilds.has(String(guildId)) || retiredMembers.has(lockKey(guildId, userId)); }
function retireMember(guildId, userId) {
    const key = lockKey(guildId, userId);
    retiredMembers.add(key);
    const active = activeGuildActions.get(String(guildId));
    if (!active) return false;
    active.promise.catch(() => {}).finally(() => retiredMembers.delete(key));
    return true;
}

function isAdministrator(member, guild = null) {
    if (!member) return false;
    if (guild?.ownerId && String(member.id) === String(guild.ownerId)) return true;
    try { return member.permissions?.has?.(PermissionFlagsBits.Administrator) === true; } catch { return false; }
}
function getGuildLocks(guildId) {
    const id = String(guildId);
    if (!locksByGuild.has(id)) locksByGuild.set(id, new Map());
    return locksByGuild.get(id);
}
function getLock(guildId, userId) { return getGuildLocks(guildId).get(String(userId)) || null; }
function legacyLockActor(lock, field) {
    if (lock[field]) return String(lock[field]);
    if (lock.lockedBy) return String(lock.lockedBy);
    return null;
}
function normalizeLock(lock) {
    const updatedAt = Number(lock.updatedAt || Date.now());
    return {
        guildId: String(lock.guildId), userId: String(lock.userId), muteLocked: lock.muteLocked === true, deafLocked: lock.deafLocked === true,
        lockedBy: lock.lockedBy ? String(lock.lockedBy) : null, updatedAt,
        muteLockedBy: legacyLockActor(lock, "muteLockedBy"),
        muteLockedAt: Number(lock.muteLockedAt || updatedAt), muteVersion: lock.muteVersion ? String(lock.muteVersion) : null,
        muteOwnerForced: lock.muteOwnerForced === true,
        deafLockedBy: legacyLockActor(lock, "deafLockedBy"),
        deafLockedAt: Number(lock.deafLockedAt || updatedAt), deafVersion: lock.deafVersion ? String(lock.deafVersion) : null
    };
}
function setCachedLock(lock) {
    const normalized = normalizeLock(lock);
    const guildLocks = getGuildLocks(normalized.guildId);
    if (normalized.muteLocked || normalized.deafLocked) guildLocks.set(normalized.userId, normalized);
    else guildLocks.delete(normalized.userId);
    if (!guildLocks.size) locksByGuild.delete(normalized.guildId);
    return normalized;
}
function makeError(code, operation, cause = null) {
    const error = new Error(code);
    error.code = code; error.operation = operation; error.cause = cause;
    return error;
}
function trimOldestEntries(map, maxSize) {
    while (map.size > maxSize) map.delete(map.keys().next().value);
}
function pruneRuntimeCaches(now = Date.now()) {
    for (const [key, entries] of cachedAuditUnlocks) {
        const fresh = entries.filter(entry => now - Number(entry?.createdTimestamp || 0) <= AUDIT_CACHE_WINDOW_MS);
        if (fresh.length) cachedAuditUnlocks.set(key, fresh.slice(-8));
        else cachedAuditUnlocks.delete(key);
    }
    for (const [id, details] of processedAuditEntries) {
        const at = typeof details === "object" ? Number(details.at) : Number(details);
        if (now - at > PROCESSED_AUDIT_WINDOW_MS) processedAuditEntries.delete(id);
    }
    for (const [key, at] of auditWatermarks) {
        if (now - Number(at) > PROCESSED_AUDIT_WINDOW_MS) auditWatermarks.delete(key);
    }
    for (const [key, notice] of notices) {
        if (now - Number(notice?.notifiedAt || 0) >= NOTICE_WINDOW_MS) notices.delete(key);
    }
    trimOldestEntries(cachedAuditUnlocks, MAX_AUDIT_CACHE_KEYS);
    trimOldestEntries(processedAuditEntries, MAX_PROCESSED_AUDIT_ENTRIES);
    trimOldestEntries(notices, MAX_NOTICE_POINTERS);
}
function buildPersistenceFailureContext(operation, context = {}) {
    const errorCode = context.error?.code || context.error?.name || context.code || "unknown";
    return {
        "การทำงาน": String(operation),
        "Guild ID": String(context.guildId || "unknown"),
        "User ID": String(context.userId || "unknown"),
        "ประเภท": context.type || "unknown",
        "รหัสข้อผิดพลาด": String(errorCode)
    };
}
async function reportPersistenceFailure(operation, context = {}) {
    await sendWebhookEvent({
        severity: "ERROR", category: "VOICE_ADMIN", code: "voiceadmin.persistence_failed", state: "OPEN",
        title: "บันทึก Voice Admin lock ไม่สำเร็จ",
        description: "ระบบไม่ยืนยันสถานะ lock จากฐานข้อมูล จึงไม่อ้างว่างานสำเร็จ",
        impact: "สถานะใน Discord และ lock ถาวรอาจต้องตรวจสอบ",
        action: "ตรวจ MongoDB และลองคำสั่งใหม่หลังระบบกลับมาปกติ",
        context: buildPersistenceFailureContext(operation, context),
        dedupeKey: `voiceadmin-persistence:${operation}:${context.guildId || "unknown"}:${context.userId || "unknown"}:${context.type || "unknown"}`,
        dedupeMs: 15 * 60 * 1000
    }).catch(() => {});
}
async function reportEnforcementFailure(operation, context = {}) {
    await sendWebhookEvent({
        severity: "ERROR", category: "VOICE_ADMIN", code: "voiceadmin.enforcement_failed", state: "OPEN",
        title: "บังคับ Voice Admin lock ไม่สำเร็จ",
        description: "บอตยังยืนยันการปิดสถานะใน Discord ไม่ได้หลังลองซ้ำตามจำนวนที่กำหนด",
        impact: "lock ยังคงถูกเก็บไว้ แต่สถานะเสียงอาจยังไม่ตรงตาม lock ชั่วคราว",
        action: "ตรวจสิทธิ์บอตและ Discord API แล้วระบบจะลองอีกครั้งเมื่อมี Voice event ใหม่",
        context: { "การทำงาน": String(operation), "Guild ID": String(context.guildId || "unknown"), "User ID": String(context.userId || "unknown"), "ประเภท": String(context.type || "unknown"), "รหัสข้อผิดพลาด": String(context.code || "discord_api_failed") },
        dedupeKey: `voiceadmin-enforcement:${operation}:${context.guildId || "unknown"}:${context.userId || "unknown"}:${context.type || "unknown"}`,
        dedupeMs: 15 * 60 * 1000
    }).catch(() => {});
}
function operationWasAcknowledged(result, { allowUpsert = false, allowDeleteZero = false } = {}) {
    if (result?.acknowledged !== true) return false;
    if (allowDeleteZero) return true;
    return Number(result.matchedCount || 0) > 0 || (allowUpsert && Number(result.upsertedCount || 0) > 0);
}
async function initialize() {
    const [lockDocs, noticeDocs] = await Promise.all([
        VoiceAdminLock.find({ $or: [{ muteLocked: true }, { deafLocked: true }] }).lean(),
        VoiceAdminNotice.find({ notifiedAt: { $gte: new Date(Date.now() - NOTICE_WINDOW_MS) } }).lean()
    ]);
    locksByGuild.clear(); notices.clear(); retiredGuilds.clear(); retiredMembers.clear();
    for (const lock of lockDocs) setCachedLock(lock);
    for (const notice of noticeDocs) notices.set(noticeKey(notice.guildId, notice.actorId, notice.targetId), notice);
    initialized = true; stopping = false;
    return { locks: lockDocs.length, notices: noticeDocs.length };
}
function assertRunnable() {
    if (initialized && !stopping) return;
    throw makeError(stopping ? "VOICE_ADMIN_STOPPING" : "VOICE_ADMIN_NOT_INITIALIZED");
}

function buildLockWrite(guildId, userId, type, actorId, expectedVersion, options = {}) {
    const field = fieldFor(type); const meta = metadataFor(type); const version = createVersion(); const now = Date.now();
    const requestedLockedAt = Number(options.lockedAt);
    const lockedAt = Number.isFinite(requestedLockedAt) && requestedLockedAt > 0 ? requestedLockedAt : now;
    const filter = { guildId: String(guildId), userId: String(userId) };
    if (expectedVersion !== undefined) filter[meta.version] = expectedVersion;
    const upsert = expectedVersion === undefined;
    const update = {
        $set: {
            [field]: true, [meta.by]: String(actorId), [meta.at]: lockedAt, [meta.version]: version,
            ...(type === "mute" ? { muteOwnerForced: options.ownerForced === true } : {}),
            lockedBy: String(actorId), updatedAt: now
        }
    };
    // Keep insert-only defaults disjoint from the field that this write enables.
    // This prevents MongoDB from rejecting the update as an overlapping path.
    if (upsert) {
        update.$setOnInsert = type === "mute"
            ? { guildId: String(guildId), userId: String(userId), deafLocked: false }
            : { guildId: String(guildId), userId: String(userId), muteLocked: false, muteOwnerForced: false };
    }
    return {
        field, meta, version, now, lockedAt, filter, update, upsert,
        databaseOptions: upsert ? { upsert: true, setDefaultsOnInsert: false } : { upsert: false }
    };
}
function cacheWrittenLock(guildId, userId, type, actorId, options, write) {
    const previous = getLock(guildId, userId) || { guildId, userId, muteLocked: false, deafLocked: false };
    return setCachedLock({
        ...previous, [write.field]: true, [write.meta.by]: actorId, [write.meta.at]: write.lockedAt, [write.meta.version]: write.version,
        ...(type === "mute" ? { muteOwnerForced: options.ownerForced === true } : {}),
        lockedBy: actorId, updatedAt: write.now
    });
}
async function discardRetiredLock(guildId, userId, type, write) {
    try {
        const removed = await VoiceAdminLock.deleteOne({ guildId: String(guildId), userId: String(userId), [write.meta.version]: write.version });
        if (!operationWasAcknowledged(removed, { allowDeleteZero: true })) throw makeError("VOICE_ADMIN_PERSISTENCE_FAILED", "discard_retired_lock");
    } catch (error) {
        await reportPersistenceFailure("discard_retired_lock", { guildId, userId, type, error });
        throw makeError("VOICE_ADMIN_PERSISTENCE_FAILED", "discard_retired_lock", error);
    }
}
async function writeLock(guildId, userId, type, actorId, expectedVersion = undefined, options = {}) {
    if (isRetiredTarget(guildId, userId)) throw makeError("VOICE_ADMIN_TARGET_RETIRED", "write_lock");
    const write = buildLockWrite(guildId, userId, type, actorId, expectedVersion, options);
    let result;
    try {
        result = await VoiceAdminLock.updateOne(write.filter, write.update, write.databaseOptions);
    } catch (error) {
        await reportPersistenceFailure("write_lock", { guildId, userId, type, error });
        throw makeError("VOICE_ADMIN_PERSISTENCE_FAILED", "write_lock", error);
    }
    if (!operationWasAcknowledged(result, { allowUpsert: write.upsert })) {
        if (expectedVersion !== undefined) throw makeError("VOICE_ADMIN_LOCK_CONFLICT", "write_lock");
        await reportPersistenceFailure("write_lock", { guildId, userId, type });
        throw makeError("VOICE_ADMIN_PERSISTENCE_FAILED", "write_lock");
    }
    if (isRetiredTarget(guildId, userId)) {
        await discardRetiredLock(guildId, userId, type, write);
        throw makeError("VOICE_ADMIN_TARGET_RETIRED", "write_lock");
    }
    return { version: write.version, lock: cacheWrittenLock(guildId, userId, type, actorId, options, write) };
}
async function clearLockField(guildId, userId, type, expectedVersion = undefined) {
    const field = fieldFor(type); const meta = metadataFor(type); const version = createVersion(); const now = Date.now();
    const filter = { guildId: String(guildId), userId: String(userId) };
    if (expectedVersion !== undefined) filter[meta.version] = expectedVersion;
    const previous = getLock(guildId, userId) || { guildId, userId, muteLocked: false, deafLocked: false };
    let result;
    try {
        result = await VoiceAdminLock.updateOne(filter, { $set: {
            [field]: false, [meta.by]: null, [meta.at]: null, [meta.version]: version,
            ...(type === "mute" ? { muteOwnerForced: false } : {}),
            updatedAt: now
        } });
    }
    catch (error) { await reportPersistenceFailure("clear_lock", { guildId, userId, type, error }); throw makeError("VOICE_ADMIN_PERSISTENCE_FAILED", "clear_lock", error); }
    if (!operationWasAcknowledged(result)) {
        if (expectedVersion !== undefined) throw makeError("VOICE_ADMIN_LOCK_CONFLICT", "clear_lock");
        await reportPersistenceFailure("clear_lock", { guildId, userId, type }); throw makeError("VOICE_ADMIN_PERSISTENCE_FAILED", "clear_lock");
    }
    const current = getLock(guildId, userId);
    // A newer operation has already advanced the in-memory version while this
    // MongoDB write was in flight. Do not replace that newer cache entry or
    // issue a Discord state change based on this stale clear.
    if (expectedVersion !== undefined && current?.[meta.version] !== expectedVersion) {
        throw makeError("VOICE_ADMIN_LOCK_CONFLICT", "clear_lock");
    }
    return {
        version, previous,
        lock: setCachedLock({
            ...previous, [field]: false, [meta.by]: null, [meta.at]: null, [meta.version]: version,
            ...(type === "mute" ? { muteOwnerForced: false } : {}),
            updatedAt: now
        })
    };
}
async function clearBothLocks(guildId, userId, expectedVersions = undefined) {
    const previous = getLock(guildId, userId);
    const expected = expectedVersions === undefined && previous
        ? { mute: previous.muteVersion, deaf: previous.deafVersion }
        : expectedVersions;
    const now = Date.now(); const versions = { mute: createVersion(), deaf: createVersion() };
    const filter = { guildId: String(guildId), userId: String(userId) };
    if (expected) {
        filter.muteVersion = expected.mute ?? null;
        filter.deafVersion = expected.deaf ?? null;
    }
    let result;
    try { result = await VoiceAdminLock.updateOne(filter, { $set: { muteLocked: false, deafLocked: false, muteLockedBy: null, deafLockedBy: null, muteLockedAt: null, deafLockedAt: null, muteVersion: versions.mute, deafVersion: versions.deaf, muteOwnerForced: false, updatedAt: now } }); }
    catch (error) { await reportPersistenceFailure("clear_both", { guildId, userId, type: "both", error }); throw makeError("VOICE_ADMIN_PERSISTENCE_FAILED", "clear_both", error); }
    if (!operationWasAcknowledged(result)) {
        if (expected) throw makeError("VOICE_ADMIN_LOCK_CONFLICT", "clear_both");
        await reportPersistenceFailure("clear_both", { guildId, userId, type: "both" }); throw makeError("VOICE_ADMIN_PERSISTENCE_FAILED", "clear_both");
    }
    const current = getLock(guildId, userId);
    if (expected && (current?.muteVersion !== expected.mute || current?.deafVersion !== expected.deaf)) {
        throw makeError("VOICE_ADMIN_LOCK_CONFLICT", "clear_both");
    }
    return { versions, previous, lock: setCachedLock({ ...(previous || { guildId, userId }), muteLocked: false, deafLocked: false, muteVersion: versions.mute, deafVersion: versions.deaf, updatedAt: now }) };
}
function cancelEnforcement(guildId, userId, type) {
    const key = pendingKey(guildId, userId, type);
    const controller = enforcementActions.get(key);
    if (controller) {
        cancelController(controller);
        enforcementActions.delete(key);
    }
}
function clearMemberRuntimeState(guildId, userId) {
    for (const type of ["mute", "deaf"]) {
        clearPending(guildId, userId, type);
        cancelEnforcement(guildId, userId, type);
        cachedAuditUnlocks.delete(pendingKey(guildId, userId, type));
        auditWatermarks.delete(pendingKey(guildId, userId, type));
    }
    for (const [id, details] of processedAuditEntries) {
        if (details?.guildId === String(guildId) && details?.userId === String(userId)) processedAuditEntries.delete(id);
    }
    for (const key of notices.keys()) {
        const [noticeGuildId, actorId, targetId] = key.split(":");
        if (noticeGuildId === String(guildId) && (actorId === String(userId) || targetId === String(userId))) notices.delete(key);
    }
}
async function clearAllLocksForMember(guildId, userId, { retire = false } = {}) {
    const retainedUntilActionFinishes = retire ? retireMember(guildId, userId) : false;
    clearMemberRuntimeState(guildId, userId);
    let result;
    try {
        result = await Promise.all([
            VoiceAdminLock.deleteOne({ guildId: String(guildId), userId: String(userId) }),
            VoiceAdminNotice.deleteMany({ guildId: String(guildId), $or: [{ actorId: String(userId) }, { targetId: String(userId) }] })
        ]);
    }
    catch (error) { await reportPersistenceFailure("member_cleanup", { guildId, userId, error }); throw makeError("VOICE_ADMIN_PERSISTENCE_FAILED", "member_cleanup", error); }
    finally {
        if (retire && !retainedUntilActionFinishes) retiredMembers.delete(lockKey(guildId, userId));
    }
    if (!result.every(item => operationWasAcknowledged(item, { allowDeleteZero: true }))) { await reportPersistenceFailure("member_cleanup", { guildId, userId }); throw makeError("VOICE_ADMIN_PERSISTENCE_FAILED", "member_cleanup"); }
    const locks = getGuildLocks(guildId); locks.delete(String(userId)); if (!locks.size) locksByGuild.delete(String(guildId));
}
function deleteMapKeysWithPrefix(map, prefix) {
    for (const key of map.keys()) {
        if (key.startsWith(prefix)) map.delete(key);
    }
}
function deleteProcessedAuditEntriesForGuild(guildId) {
    for (const [id, details] of processedAuditEntries) {
        if (details?.guildId === guildId) processedAuditEntries.delete(id);
    }
}
function clearGuildRuntimeState(guildId) {
    for (const lock of getGuildLocks(guildId).values()) clearMemberRuntimeState(guildId, lock.userId);
    locksByGuild.delete(guildId);
    const prefix = `${guildId}:`;
    deleteMapKeysWithPrefix(cachedAuditUnlocks, prefix);
    deleteMapKeysWithPrefix(auditWatermarks, prefix);
    deleteProcessedAuditEntriesForGuild(guildId);
    deleteMapKeysWithPrefix(notices, prefix);
    deleteMapKeysWithPrefix(noticeQueues, prefix);
}
function cancelGuildEnforcement(guildId) {
    for (const [key, pending] of pendingEnforcement) {
        if (!key.startsWith(`${guildId}:`)) continue;
        clearTimeout(pending.timer); pendingEnforcement.delete(key);
    }
    for (const [key, controller] of enforcementActions) {
        if (!key.startsWith(`${guildId}:`)) continue;
        cancelController(controller); enforcementActions.delete(key);
    }
}
async function deleteGuildRecords(guildId) {
    let result;
    try { result = await Promise.all([VoiceAdminLock.deleteMany({ guildId }), VoiceAdminNotice.deleteMany({ guildId })]); }
    catch (error) { await reportPersistenceFailure("guild_cleanup", { guildId, error }); throw makeError("VOICE_ADMIN_PERSISTENCE_FAILED", "guild_cleanup", error); }
    if (!result.every(item => operationWasAcknowledged(item, { allowDeleteZero: true }))) {
        await reportPersistenceFailure("guild_cleanup", { guildId });
        throw makeError("VOICE_ADMIN_PERSISTENCE_FAILED", "guild_cleanup");
    }
}
async function clearGuildData(guildId) {
    const normalizedGuildId = String(guildId);
    retiredGuilds.add(normalizedGuildId);
    const active = activeGuildActions.get(normalizedGuildId);
    if (active) cancelController(active);
    await deleteGuildRecords(normalizedGuildId);
    clearGuildRuntimeState(normalizedGuildId);
    cancelGuildEnforcement(normalizedGuildId);
}
function handleGuildCreate(guildId) { retiredGuilds.delete(String(guildId)); }

function pause(ms, controller) {
    return new Promise(resolve => {
        if (stopping || controller?.cancelled) return resolve(false);
        const pending = { timer: null, resolve };
        pending.timer = setTimeout(() => { sleepTimers.delete(pending); controller?.sleeps.delete(pending); resolve(!(stopping || controller?.cancelled)); }, ms);
        pending.timer.unref?.(); sleepTimers.add(pending); controller?.sleeps.add(pending);
    });
}
function settleGlobalWaiter(waiter, granted) {
    if (!waiter || waiter.settled) return;
    waiter.settled = true;
    waiter.controller?.permitWaiters?.delete(waiter);
    waiter.resolve(granted);
}
function removeGlobalWaiter(waiter) {
    const index = globalActionWaiters.indexOf(waiter);
    if (index >= 0) globalActionWaiters.splice(index, 1);
}
function acquireGlobalActionPermit(controller) {
    if (stopping || controller?.cancelled) return Promise.resolve(false);
    if (activeGlobalMemberOperations < GLOBAL_ACTION_WORKER_LIMIT) {
        activeGlobalMemberOperations++;
        return Promise.resolve(true);
    }
    return new Promise(resolve => {
        const waiter = { controller, resolve, settled: false };
        controller?.permitWaiters?.add(waiter);
        globalActionWaiters.push(waiter);
    });
}
function releaseGlobalActionPermit() {
    if (activeGlobalMemberOperations > 0) activeGlobalMemberOperations--;
    while (globalActionWaiters.length && activeGlobalMemberOperations < GLOBAL_ACTION_WORKER_LIMIT) {
        const waiter = globalActionWaiters.shift();
        if (!waiter || waiter.settled || stopping || waiter.controller?.cancelled) {
            settleGlobalWaiter(waiter, false);
            continue;
        }
        activeGlobalMemberOperations++;
        settleGlobalWaiter(waiter, true);
        break;
    }
}
function cancelController(controller) {
    controller.cancelled = true;
    for (const pending of controller.sleeps) { clearTimeout(pending.timer); sleepTimers.delete(pending); pending.resolve(false); }
    controller.sleeps.clear();
    for (const waiter of controller.permitWaiters || []) {
        removeGlobalWaiter(waiter);
        settleGlobalWaiter(waiter, false);
    }
    controller.permitWaiters?.clear();
}
async function withGuildAction(guildId, work) {
    assertRunnable();
    const id = String(guildId);
    if (activeGuildActions.has(id)) throw makeError("VOICE_ADMIN_ACTION_IN_PROGRESS");
    const controller = createActionController();
    const promise = Promise.resolve().then(() => work(controller));
    controller.promise = promise; activeGuildActions.set(id, controller);
    try { return await promise; } finally { cancelController(controller); if (activeGuildActions.get(id) === controller) activeGuildActions.delete(id); }
}
async function withDeadline(promise, remainingMs) {
    if (remainingMs <= 0) throw makeError("VOICE_ADMIN_MEMBER_TIMEOUT");
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(makeError("VOICE_ADMIN_MEMBER_TIMEOUT")), remainingMs); timer.unref?.(); });
    try { return await Promise.race([Promise.resolve(promise), timeout]); }
    finally { clearTimeout(timer); Promise.resolve(promise).catch(() => {}); }
}
function newResult(members) { return { targeted: members.length, succeeded: 0, failed: 0, skipped: 0, timedOut: 0, persistenceFailed: 0, failedMembers: [], durationMs: 0 }; }
function createActionController() { return { cancelled: false, sleeps: new Set(), permitWaiters: new Set(), promise: null }; }
function createBulkRunState(members, controller, options = {}) {
    const requestedWorkers = Number(options.workerLimit || ACTION_WORKER_LIMIT);
    const workerLimit = Math.max(1, Math.min(Number.isFinite(requestedWorkers) ? Math.floor(requestedWorkers) : ACTION_WORKER_LIMIT, members.length || 1));
    return {
        controller: controller || createActionController(), result: newResult(members), workerLimit,
        startedAt: options.startedAt || Date.now(), maxDurationMs: options.maxDurationMs || ACTION_MAX_DURATION_MS, nextIndex: 0
    };
}
function bulkRunExpired(state) { return stopping || state.controller.cancelled || Date.now() - state.startedAt >= state.maxDurationMs; }
function claimNextBulkMember(state, members) {
    if (bulkRunExpired(state) || state.nextIndex >= members.length) return null;
    return state.nextIndex++;
}
function recordBulkOutcome(result, member, outcome, error = null) {
    if (!error) {
        if (outcome === BULK_SKIPPED) result.skipped++;
        else result.succeeded++;
        return;
    }
    result.failed++; result.failedMembers.push(String(member.id));
    if (error.code === "VOICE_ADMIN_PERSISTENCE_FAILED") result.persistenceFailed++;
}
async function runBulkWorker(state, members, runOne) {
    while (true) {
        const index = claimNextBulkMember(state, members);
        if (index === null) return;
        const permit = await acquireGlobalActionPermit(state.controller);
        if (!permit || bulkRunExpired(state)) {
            state.result.timedOut++;
            if (permit) releaseGlobalActionPermit();
            return;
        }
        try { recordBulkOutcome(state.result, members[index], await runOne(members[index])); }
        catch (error) { recordBulkOutcome(state.result, members[index], null, error); }
        finally { releaseGlobalActionPermit(); }
    }
}
async function runBulkUnsafe(members, runOne, controller = null, options = {}) {
    const state = createBulkRunState(members, controller, options);
    await Promise.all(Array.from({ length: state.workerLimit }, () => runBulkWorker(state, members, runOne)));
    state.result.timedOut += members.length - state.nextIndex;
    state.result.durationMs = Math.max(0, Date.now() - state.startedAt);
    return state.result;
}
function buildResult(action, result) {
    const timeout = result.timedOut ? ` | หมดเวลา ${result.timedOut} คน` : "";
    const persistence = result.persistenceFailed ? ` | บันทึกสถานะไม่สำเร็จ ${result.persistenceFailed} คน` : "";
    const skipped = result.skipped ? ` | ออกจากห้องก่อนถึงคิว ${result.skipped} คน` : "";
    const duration = Number.isFinite(result.durationMs) && result.durationMs > 0 ? ` | ใช้เวลา ${(result.durationMs / 1000).toFixed(1)} วินาที` : "";
    return `**${action}** — เป้าหมาย ${result.targeted} คน | สำเร็จ ${result.succeeded} คน | ล้มเหลว ${result.failed} คน${skipped}${timeout}${persistence}${duration}`;
}
function resultEmoji(result) {
    const targeted = Number(result?.targeted || 0);
    const succeeded = Number(result?.succeeded || 0);
    const incomplete = Number(result?.failed || 0) + Number(result?.skipped || 0) + Number(result?.timedOut || 0) + Number(result?.persistenceFailed || 0);
    if (targeted > 0 && succeeded === targeted && incomplete === 0) return "✅";
    if (succeeded > 0 || targeted === 0 || Number(result?.skipped || 0) || Number(result?.timedOut || 0)) return "⚠️";
    return "❌";
}

function getBotMember(guild) { return guild?.members?.me || guild?.members?.cache?.get?.(guild?.client?.user?.id) || null; }
function botCanInChannel(guild, channel, permission) {
    const bot = getBotMember(guild); const permissions = channel?.permissionsFor?.(bot) || bot?.permissions;
    try { return permissions?.has?.(permission) === true; } catch { return false; }
}
function sourceMembers(channel, { includeAdministrators = false, excludeId = null } = {}) {
    return Array.from(channel?.members?.values?.() || []).filter(member => (!excludeId || String(member.id) !== String(excludeId)) && (includeAdministrators || !isAdministrator(member, channel.guild)));
}
function isStillInSource(member, source) {
    if (!source) return true;
    const channelId = member?.voice?.channelId || member?.voice?.channel?.id || null;
    return String(channelId || "") === String(source.id);
}
function buildPanel(channel, status = null) {
    const members = Array.from(channel?.members?.values?.() || []); const inChannel = new Set(members.map(member => String(member.id)));
    let mute = 0; let deaf = 0;
    for (const [id, lock] of getGuildLocks(channel?.guild?.id)) {
        if (inChannel.has(id) && lock.muteLocked) mute++;
        if (inChannel.has(id) && lock.deafLocked) deaf++;
    }
    const descriptionLines = [
        `### 🎛️ แผงควบคุมและจัดการห้องเสียง`,
        `> ศูนย์ควบคุมสถานะสมาชิกในห้องเสียงแบบเรียลไทม์\n`,
        `📍 **ข้อมูลห้องเสียงปัจจุบัน**`,
        `• ห้อง: <#${channel.id}>`,
        `• สมาชิกทั้งหมด: **${members.length}** คน  │  จัดการได้: **${sourceMembers(channel).length}** คน\n`,
        `🔒 **สถานะการล็อกระดับเซิร์ฟเวอร์**`,
        `• 🔇 ล็อกไมค์ (Server Mute): **${mute}** คน`,
        `• 🎧 ล็อกหู (Server Deafen): **${deaf}** คน`
    ];
    if (status) {
        descriptionLines.push(`\n${status}`);
    }
    const embed = new EmbedBuilder()
        .setColor(config.system?.themeColors?.primary || "#5865F2")
        .setTitle("🔊 Voice Administration Panel")
        .setDescription(descriptionLines.join("\n"))
        .setFooter({ text: "Phomueangtai Personal Multi-Tool • Voice Admin" })
        .setTimestamp();
    const actions = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(IDS.DISCONNECT).setLabel("ตัดสายทั้งหมด").setEmoji("🚪").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(IDS.LOCK_MUTE).setLabel("ปิดไมค์").setEmoji("🔇").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(IDS.LOCK_DEAF).setLabel("ปิดหู").setEmoji("🎧").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(IDS.UNLOCK_MUTE).setLabel("เปิดไมค์").setEmoji("🎙️").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(IDS.UNLOCK_DEAF).setLabel("เปิดหู").setEmoji("🔊").setStyle(ButtonStyle.Success)
    );
    const move = new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(IDS.MOVE).setPlaceholder("🚀 เลือกห้องเสียงปลายทางเพื่อย้ายสมาชิกทันที").setChannelTypes(ChannelType.GuildVoice).setMinValues(1).setMaxValues(1));
    const refresh = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(IDS.REFRESH).setLabel("รีเฟรชสถานะ").setEmoji("🔄").setStyle(ButtonStyle.Primary));
    return { embeds: [embed], components: [actions, move, refresh] };
}
function verifyVoiceAdminAccess(actor, channel) {
    if (!isVoiceChannel(channel)) return "ต้องใช้คำสั่งในแชทของห้องเสียงปกติ";
    if (!isAdministrator(actor, channel.guild)) return "ต้องเป็น Administrator";
    return null;
}
function permissionForVoiceAction(action) {
    if (action === "mute") return PermissionFlagsBits.MuteMembers;
    if (action === "deaf") return PermissionFlagsBits.DeafenMembers;
    return PermissionFlagsBits.MoveMembers;
}
async function ensureBotPermission(guild, source, action, destination = null) {
    const permission = permissionForVoiceAction(action);
    if (!botCanInChannel(guild, source, permission)) {
        const error = makeError("VOICE_ADMIN_BOT_PERMISSION_MISSING");
        error.permissionAction = action;
        throw error;
    }
    if (action === "move" && (!isVoiceChannel(destination) || String(destination.guild?.id) !== String(guild?.id) || destination.id === source.id || !botCanInChannel(guild, destination, PermissionFlagsBits.Connect))) throw makeError("VOICE_ADMIN_DESTINATION_INVALID");
}
async function setVoice(member, type, enabled, reason) { return type === "mute" ? member.voice.setMute(enabled, reason) : member.voice.setDeaf(enabled, reason); }
async function setVoiceBoth(member, enabled, reason) {
    if (typeof member.edit === "function") return member.edit({ mute: enabled, deaf: enabled, reason });
    await member.voice.setMute(enabled, reason); return member.voice.setDeaf(enabled, reason);
}
async function restoreLockSnapshot(guildId, userId, type, previous, expectedVersion) {
    const field = fieldFor(type);
    if (!previous?.[field]) return null;
    const meta = metadataFor(type);
    return writeLock(
        guildId,
        userId,
        type,
        previous[meta.by] || previous.lockedBy || "voiceadmin",
        expectedVersion,
        {
            ownerForced: type === "mute" && previous.muteOwnerForced === true,
            lockedAt: previous[meta.at]
        }
    );
}
async function restoreBothLockSnapshots(guildId, userId, previous, versions) {
    const restored = await Promise.allSettled([
        restoreLockSnapshot(guildId, userId, "mute", previous, versions?.mute),
        restoreLockSnapshot(guildId, userId, "deaf", previous, versions?.deaf)
    ]);
    const failure = restored.find(item => item.status === "rejected");
    if (failure) throw failure.reason;
    return restored;
}
async function lockVoiceState(guild, members, type, actorId, options = {}) {
    return withGuildAction(guild.id, controller => runBulkUnsafe(members, async member => {
        if (!isStillInSource(member, options.source)) return BULK_SKIPPED;
        const ownerForced = type === "mute" && options.ownerForced === true;
        if (isAdministrator(member, guild) && !ownerForced) return setVoice(member, type, true, "voiceadmin temporary lock");
        const written = await writeLock(guild.id, member.id, type, actorId, undefined, { ownerForced });
        if (!isStillInSource(member, options.source)) {
            await clearLockField(guild.id, member.id, type, written.version);
            return BULK_SKIPPED;
        }
        try { await setVoice(member, type, true, "voiceadmin lock"); }
        catch (error) {
            try { await clearLockField(guild.id, member.id, type, written.version); }
            catch (rollbackError) { if (rollbackError.code === "VOICE_ADMIN_PERSISTENCE_FAILED") throw rollbackError; }
            throw error;
        }
    }, controller));
}
async function unlockVoiceState(guild, members, type, options = {}) {
    return withGuildAction(guild.id, controller => runBulkUnsafe(members, async member => {
        if (!isStillInSource(member, options.source)) return BULK_SKIPPED;
        const previous = getLock(guild.id, member.id); let cleared = null;
        if (type === "mute" && previous?.muteOwnerForced) throw makeError("VOICE_ADMIN_OWNER_LOCKED");
        if (previous?.[fieldFor(type)]) cleared = await clearLockField(guild.id, member.id, type, previous[metadataFor(type).version]);
        if (!isStillInSource(member, options.source)) {
            if (cleared) await restoreLockSnapshot(guild.id, member.id, type, previous, cleared.version);
            return BULK_SKIPPED;
        }
        try { await setVoice(member, type, false, "voiceadmin unlock"); }
        catch (error) {
            if (cleared) await restoreLockSnapshot(guild.id, member.id, type, previous, cleared.version);
            throw error;
        }
    }, controller));
}
async function unlockBoth(guild, members, options = {}) {
    return withGuildAction(guild.id, controller => runBulkUnsafe(members, async member => {
        if (!isStillInSource(member, options.source)) return BULK_SKIPPED;
        const previous = getLock(guild.id, member.id); let cleared = null;
        if (previous) cleared = await clearBothLocks(guild.id, member.id, { mute: previous.muteVersion, deaf: previous.deafVersion });
        if (!isStillInSource(member, options.source)) {
            if (cleared) await restoreBothLockSnapshots(guild.id, member.id, previous, cleared.versions);
            return BULK_SKIPPED;
        }
        try { await setVoiceBoth(member, false, "voiceadmin unlock all"); }
        catch (error) {
            if (cleared) await restoreBothLockSnapshots(guild.id, member.id, previous, cleared.versions);
            throw error;
        }
    }, controller));
}
async function disconnectMembers(guild, sourceOrMembers, maybeMembers = null) {
    const source = Array.isArray(sourceOrMembers) ? null : sourceOrMembers;
    const members = Array.isArray(sourceOrMembers) ? sourceOrMembers : maybeMembers;
    return withGuildAction(guild.id, controller => runBulkUnsafe(members, member => {
        if (!isStillInSource(member, source)) return BULK_SKIPPED;
        return member.voice.disconnect("voiceadmin disconnect");
    }, controller));
}
async function moveMembers(guild, source, destination, members) {
    await ensureBotPermission(guild, source, "move", destination);
    return withGuildAction(guild.id, controller => runBulkUnsafe(members, member => {
        if (!isStillInSource(member, source)) return BULK_SKIPPED;
        return member.voice.setChannel(destination, "voiceadmin move");
    }, controller));
}
async function runPanelAction(interaction, action, destination = null) {
    const channel = interaction.channel; const access = verifyVoiceAdminAccess(interaction.member, channel); if (access) throw makeError(`VOICE_ADMIN_ACCESS:${access}`);
    const members = sourceMembers(channel);
    if (action === "disconnect") { await ensureBotPermission(interaction.guild, channel, "disconnect"); return disconnectMembers(interaction.guild, channel, members); }
    if (action === "mute") { await ensureBotPermission(interaction.guild, channel, "mute"); return lockVoiceState(interaction.guild, members, "mute", interaction.user.id, { source: channel }); }
    if (action === "deaf") { await ensureBotPermission(interaction.guild, channel, "deaf"); return lockVoiceState(interaction.guild, members, "deaf", interaction.user.id, { source: channel }); }
    if (action === "unmute") { await ensureBotPermission(interaction.guild, channel, "mute"); return unlockVoiceState(interaction.guild, members, "mute", { source: channel }); }
    if (action === "undeaf") { await ensureBotPermission(interaction.guild, channel, "deaf"); return unlockVoiceState(interaction.guild, members, "deaf", { source: channel }); }
    if (action === "move") return moveMembers(interaction.guild, channel, destination, members);
    throw makeError("VOICE_ADMIN_ACTION_INVALID");
}
async function handleVoiceAdminCommand(interaction) {
    const access = verifyVoiceAdminAccess(interaction.member, interaction.channel);
    if (access) return interaction.reply({ content: `> ⛔ ${access}`, ephemeral: true });
    const reply = await interaction.reply({ ...buildPanel(interaction.channel), ephemeral: true });
    markCommandAccepted(interaction);
    return reply;
}
function isVoiceAdminInteraction(interaction) { return (interaction?.isButton?.() || interaction?.isChannelSelectMenu?.()) && String(interaction.customId || "").startsWith(IDS.PREFIX); }
async function handleVoiceAdminInteraction(interaction) {
    const access = verifyVoiceAdminAccess(interaction.member, interaction.channel);
    if (access) return interaction.reply({ content: `> ⛔ ${access}`, ephemeral: true });
    if (interaction.customId === IDS.REFRESH) return interaction.update(buildPanel(interaction.channel));
    await interaction.deferUpdate();
    const action = ({ [IDS.DISCONNECT]: "disconnect", [IDS.LOCK_MUTE]: "mute", [IDS.LOCK_DEAF]: "deaf", [IDS.UNLOCK_MUTE]: "unmute", [IDS.UNLOCK_DEAF]: "undeaf", [IDS.MOVE]: "move" })[interaction.customId];
    const destinationId = interaction.values?.[0];
    let destination = null;
    if (action === "move") {
        destination = interaction.channels?.first?.() || interaction.guild?.channels?.cache?.get?.(destinationId) || null;
        if (!destination && destinationId && typeof interaction.guild?.channels?.fetch === "function") {
            destination = await interaction.guild.channels.fetch(destinationId).catch(() => null);
        }
    }
    if (!action) return interaction.editReply(buildPanel(interaction.channel, `> ❌ คำสั่งแผงนี้ไม่ถูกต้อง`));
    try {
        const result = await runPanelAction(interaction, action, destination);
        return interaction.editReply(buildPanel(interaction.channel, `> ${resultEmoji(result)} ${buildResult("ผลการทำงาน", result)}`));
    }
    catch (error) {
        const detail = describePanelActionFailure(error);
        return interaction.editReply(buildPanel(interaction.channel, `> ❌ ${detail}`));
    }
}

function describeBotPermissionMissing(error) {
    if (error?.permissionAction === "mute") return "บอตไม่มีสิทธิ์ 'ปิดเสียงสมาชิก' (Mute Members) ในห้องเสียง";
    if (error?.permissionAction === "deaf") return "บอตไม่มีสิทธิ์ 'ตัดเสียงสมาชิก' (Deafen Members) ในห้องเสียง";
    if (error?.permissionAction === "move" || error?.permissionAction === "disconnect") return "บอตไม่มีสิทธิ์ 'ย้ายสมาชิก' (Move Members) ในห้องเสียง";
    return "บอตไม่มีสิทธิ์ที่จำเป็นในห้องเสียง";
}

function describePanelActionFailure(error) {
    if (error.code === "VOICE_ADMIN_ACTION_IN_PROGRESS") return "มีงานจัดการห้องนี้กำลังทำงานอยู่";
    if (error.message?.startsWith("VOICE_ADMIN_ACCESS:")) return error.message.slice("VOICE_ADMIN_ACCESS:".length);
    if (error.code === "VOICE_ADMIN_DESTINATION_INVALID") return "ห้องปลายทางไม่ถูกต้องหรือบอตเข้าไม่ได้";
    if (error.code === "VOICE_ADMIN_PERSISTENCE_FAILED") return "MongoDB บันทึกสถานะ lock ไม่สำเร็จ กรุณาลองใหม่";
    if (error.code === "VOICE_ADMIN_LOCK_CONFLICT") return "สถานะถูกเปลี่ยนโดยงานอื่น กรุณาลองใหม่";
    if (error.code === "VOICE_ADMIN_STOPPING") return "บอตกำลังปิดระบบ ลองใหม่หลังระบบพร้อม";
    if (error.code === "VOICE_ADMIN_NOT_INITIALIZED") return "ระบบ Voice Admin ยังไม่พร้อม";
    if (error.code === "VOICE_ADMIN_BOT_PERMISSION_MISSING") return describeBotPermissionMissing(error);
    return "ดำเนินการไม่สำเร็จ กรุณาตรวจสอบสิทธิ์บอตและห้องเสียง";
}

function parseSecretCommand(content) {
    const text = String(content || "").trim();
    const prefix = getSecretCommandPrefix(text);
    if (!prefix) return null;
    const match = /^(ตัดหมด|ย้ายหมด|ปิดไมค์หมด|ปิดหูหมด|เปิดหมด)(?:\s+(\S+))?\s*$/.exec(text.slice(prefix.length).trim());
    if (!match || ((match[1] === "ย้ายหมด") !== Boolean(match[2])) || (match[1] !== "ย้ายหมด" && match[2])) return { prefix, invalid: true };
    return { prefix, command: match[1], argument: match[2] || null, includeAdministrators: prefix === "///" };
}
function getSecretCommandPrefix(text) {
    if (text.startsWith("///")) return "///";
    if (text.startsWith("//")) return "//";
    return null;
}
function secretUsage() { return "ใช้: //ตัดหมด | //ย้ายหมด <IDห้อง> | //ปิดไมค์หมด | //ปิดหูหมด | //เปิดหมด (เพิ่ม / อีกหนึ่งตัวเพื่อไม่เว้นแอดมิน)"; }
function secretReply(payload) {
    if (typeof payload === "string") {
        return { content: payload, allowedMentions: { parse: [], repliedUser: false } };
    }
    return { ...payload, allowedMentions: { parse: [], repliedUser: false } };
}

function resultColor(result) {
    const targeted = Number(result?.targeted || 0);
    const succeeded = Number(result?.succeeded || 0);
    const incomplete = Number(result?.failed || 0) + Number(result?.skipped || 0) + Number(result?.timedOut || 0) + Number(result?.persistenceFailed || 0);
    if (targeted > 0 && succeeded === targeted && incomplete === 0) return config.system?.themeColors?.success || "#57F287";
    if (succeeded > 0 || targeted === 0 || Number(result?.skipped || 0) || Number(result?.timedOut || 0)) return config.system?.themeColors?.warning || "#FEE75C";
    return config.system?.themeColors?.error || "#ED4245";
}

function buildSecretResultEmbed(command, result) {
    const isFullSuccess = result.targeted > 0 && result.succeeded === result.targeted && (result.failed + result.skipped + result.timedOut + result.persistenceFailed === 0);
    const color = resultColor(result);
    let statusBanner = "❌ **การดำเนินการล้มเหลว**";
    if (isFullSuccess) {
        statusBanner = "✅ **ดำเนินการเสร็จสมบูรณ์**";
    } else if (result.succeeded > 0) {
        statusBanner = "⚠️ **ดำเนินการสำเร็จบางส่วน**";
    }

    const lines = [
        statusBanner,
        "",
        "📊 **สรุปผลการจัดการ:**",
        `• 👥 **เป้าหมายทั้งหมด:** **${result.targeted}** คน`,
        `• ✅ **ดำเนินการสำเร็จ:** **${result.succeeded}** คน`
    ];
    if (result.failed > 0) lines.push(`• ❌ **ล้มเหลว:** **${result.failed}** คน`);
    if (result.skipped > 0) lines.push(`• 🏃 **ออกจากห้องก่อนถึงคิว:** **${result.skipped}** คน`);
    if (result.timedOut > 0) lines.push(`• ⏳ **หมดเวลาการทำงาน:** **${result.timedOut}** คน`);
    if (result.persistenceFailed > 0) lines.push(`• ⚠️ **บันทึกสถานะไม่สำเร็จ:** **${result.persistenceFailed}** คน`);
    if (Number.isFinite(result.durationMs) && result.durationMs > 0) {
        lines.push(`• ⏱️ **เวลาที่ใช้:** **${(result.durationMs / 1000).toFixed(1)}** วินาที`);
    }

    return new EmbedBuilder()
        .setColor(color)
        .setTitle(`⚡ Voice Admin — ${command}`)
        .setDescription(lines.join("\n"))
        .setFooter({ text: "Phomueangtai Personal Multi-Tool • Voice Admin" })
        .setTimestamp();
}

function buildSecretUsageEmbed() {
    return new EmbedBuilder()
        .setColor(config.system?.themeColors?.warning || "#FEE75C")
        .setTitle("📖 วิธีใช้งานคำสั่งลับ Voice Admin")
        .setDescription(
            `### ⚡ รายการคำสั่งด่วน (Quick Commands)\n` +
            `> ควบคุมสมาชิกในห้องเสียงได้ทันทีผ่านการพิมพ์ในแชทห้องเสียง\n\n` +
            `• \`//ตัดหมด\` หรือ \`///ตัดหมด\`\n` +
            `  └ 🚪 ตัดการเชื่อมต่อของสมาชิกทุกคนในห้องทันที\n` +
            `• \`//ย้ายหมด <ID หรือ #ห้อง>\` หรือ \`///ย้ายหมด <ID หรือ #ห้อง>\`\n` +
            `  └ 🚀 ย้ายสมาชิกทุกคนไปยังห้องเสียงเป้าหมาย\n` +
            `• \`//ปิดไมค์หมด\` หรือ \`///ปิดไมค์หมด\`\n` +
            `  └ 🔇 บังคับปิดไมค์แดง (Server Mute) สมาชิกทุกคนในห้อง\n` +
            `• \`//ปิดหูหมด\` หรือ \`///ปิดหูหมด\`\n` +
            `  └ 🎧 บังคับปิดหูแดง (Server Deafen) สมาชิกทุกคนในห้อง\n` +
            `• \`//เปิดหมด\` หรือ \`///เปิดหมด\`\n` +
            `  └ 🎙️ ปลดล็อกทั้งไมค์และหูให้ทุกคนกลับมาใช้งานปกติ\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `### 💡 โหมดการทำงาน (Prefix Mode)\n` +
            `• **\`//\` (2 ขีด - โหมดทั่วไป):** จัดการเฉพาะคนทั่วไป *(เว้นแอดมิน)*\n` +
            `• **\`///\` (3 ขีด - โหมดเด็ดขาด):** บังคับใช้กับทุกคนในห้องเสียง *(รวมแอดมิน)*`
        )
        .setFooter({ text: "Phomueangtai Personal Multi-Tool • Owner Only" })
        .setTimestamp();
}

function buildSecretWrongChannelEmbed() {
    return new EmbedBuilder()
        .setColor(config.system?.themeColors?.error || "#ED4245")
        .setTitle("⛔ ตำแหน่งการใช้คำสั่งไม่ถูกต้อง")
        .setDescription(
            `> ❌ **ไม่สามารถประมวลผลคำสั่งได้**\n` +
            `> คำสั่งนี้ต้องพิมพ์ในช่องแชทข้อความของ **ห้องเสียงปกติ (Voice Channel)** เท่านั้น\n` +
            `> กรุณาเข้าไปในห้องเสียงที่ต้องการจัดการ แล้วพิมพ์คำสั่งในห้องนั้นอีกครั้ง`
        )
        .setFooter({ text: "Phomueangtai Personal Multi-Tool • Voice Admin" })
        .setTimestamp();
}

function buildSecretErrorEmbed(detail) {
    return new EmbedBuilder()
        .setColor(config.system?.themeColors?.error || "#ED4245")
        .setTitle("❌ ดำเนินการไม่สำเร็จ")
        .setDescription(
            `> ⚠️ **พบข้อผิดพลาดในการประมวลผล:**\n` +
            `> ${detail}`
        )
        .setFooter({ text: "Phomueangtai Personal Multi-Tool • Voice Admin Error" })
        .setTimestamp();
}

function isOwnerSecretMessage(message) {
    return Boolean(message?.guild) && !message.author?.bot && isConfiguredOwner(config, message.author?.id);
}
function extractChannelId(input) {
    const str = String(input || "").trim();
    if (str.startsWith("<#") && str.endsWith(">")) {
        return str.slice(2, -1).trim();
    }
    return str;
}

async function getSecretMoveDestination(message, destinationId) {
    const rawId = extractChannelId(destinationId);
    if (!/^\d{17,22}$/.test(rawId)) throw makeError("VOICE_ADMIN_DESTINATION_INVALID");
    return message.guild.channels.cache.get(rawId) || message.guild.channels.fetch(rawId).catch(() => null);
}
async function runSecretVoiceCommand(message, parsed, members) {
    switch (parsed.command) {
        case "ตัดหมด":
            await ensureBotPermission(message.guild, message.channel, "disconnect");
            return disconnectMembers(message.guild, message.channel, members);
        case "ย้ายหมด":
            return moveMembers(message.guild, message.channel, await getSecretMoveDestination(message, parsed.argument), members);
        case "ปิดไมค์หมด":
            await ensureBotPermission(message.guild, message.channel, "mute");
            return lockVoiceState(message.guild, members, "mute", message.author.id, { ownerForced: parsed.includeAdministrators, source: message.channel });
        case "ปิดหูหมด":
            await ensureBotPermission(message.guild, message.channel, "deaf");
            return lockVoiceState(message.guild, members, "deaf", message.author.id, { source: message.channel });
        case "เปิดหมด":
            await ensureBotPermission(message.guild, message.channel, "mute");
            await ensureBotPermission(message.guild, message.channel, "deaf");
            return unlockBoth(message.guild, members, { source: message.channel });
        default:
            throw makeError("VOICE_ADMIN_SECRET_COMMAND_INVALID");
    }
}
async function handleSecretMessage(message) {
    if (!isOwnerSecretMessage(message)) return false;
    const parsed = parseSecretCommand(message.content); if (!parsed) return false;
    if (parsed.invalid) {
        await message.reply(secretReply({
            content: `> ⚠️ ${secretUsage()}`,
            embeds: [buildSecretUsageEmbed()]
        }));
        return true;
    }
    if (!isVoiceChannel(message.channel)) {
        await message.reply(secretReply({
            content: `> ⛔ ต้องใช้คำสั่งนี้ในแชทของห้องเสียงปกติ`,
            embeds: [buildSecretWrongChannelEmbed()]
        }));
        return true;
    }
    const members = sourceMembers(message.channel, { includeAdministrators: parsed.includeAdministrators, excludeId: parsed.includeAdministrators ? message.author.id : null });
    try {
        const result = await runSecretVoiceCommand(message, parsed, members);
        await message.reply(secretReply({
            content: `> ${resultEmoji(result)} ${buildResult(parsed.command, result)}`,
            embeds: [buildSecretResultEmbed(parsed.command, result)]
        }));
    } catch (error) {
        const detail = describeSecretCommandFailure(error);
        await message.reply(secretReply({
            content: `> ❌ ${detail}`,
            embeds: [buildSecretErrorEmbed(detail)]
        }));
    }
    return true;
}
function describeSecretCommandFailure(error) {
    if (error.code === "VOICE_ADMIN_ACTION_IN_PROGRESS") return "มีงานจัดการห้องนี้กำลังทำงานอยู่";
    if (error.code === "VOICE_ADMIN_DESTINATION_INVALID") return "ID ห้องปลายทางไม่ถูกต้อง, เป็นห้องเดิม, ไม่ใช่ห้องเสียง หรือบอตเข้าไม่ได้";
    if (error.code === "VOICE_ADMIN_PERSISTENCE_FAILED") return "MongoDB บันทึกสถานะ lock ไม่สำเร็จ กรุณาลองใหม่";
    if (error.code === "VOICE_ADMIN_LOCK_CONFLICT") return "สถานะถูกเปลี่ยนโดยงานอื่น กรุณาลองใหม่";
    if (error.code === "VOICE_ADMIN_STOPPING") return "บอตกำลังปิดระบบ ลองใหม่หลังระบบพร้อม";
    if (error.code === "VOICE_ADMIN_NOT_INITIALIZED") return "ระบบ Voice Admin ยังไม่พร้อม";
    if (error.code === "VOICE_ADMIN_BOT_PERMISSION_MISSING") return describeBotPermissionMissing(error);
    return "ดำเนินการไม่สำเร็จ กรุณาตรวจสอบสิทธิ์บอต";
}

function changeContains(entry, name) { return Array.isArray(entry?.changes) && entry.changes.some(change => change?.key === name && change?.new === false); }
function auditType(entry) {
    if (changeContains(entry, "mute")) return "mute";
    if (changeContains(entry, "deaf")) return "deaf";
    return null;
}
function cacheAuditEntry(entry, guild) {
    const type = auditType(entry); if (!type || !entry?.targetId) return;
    pruneRuntimeCaches();
    const key = pendingKey(guild.id, entry.targetId, type); const entries = cachedAuditUnlocks.get(key) || [];
    entries.push(entry); cachedAuditUnlocks.set(key, entries.slice(-8));
    trimOldestEntries(cachedAuditUnlocks, MAX_AUDIT_CACHE_KEYS);
}
function takeMatchingAudit(guild, userId, type, pending) {
    const key = pendingKey(guild.id, userId, type); const now = Date.now(); const entries = cachedAuditUnlocks.get(key) || [];
    const watermark = Number(auditWatermarks.get(key) || 0);
    const entry = entries.find(item => {
        const auditId = String(item.id || `${key}:${item.createdTimestamp}`);
        return Number(item.createdTimestamp || 0) >= pending.lockedAt &&
            Number(item.createdTimestamp || 0) >= pending.stateAt - 1000 &&
            Number(item.createdTimestamp || 0) > watermark &&
            now - Number(item.createdTimestamp || 0) <= AUDIT_CACHE_WINDOW_MS &&
            !processedAuditEntries.has(auditId);
    });
    if (!entry) return null;
    processedAuditEntries.set(String(entry.id || `${key}:${entry.createdTimestamp}`), { at: now, guildId: String(guild.id), userId: String(userId) });
    cachedAuditUnlocks.set(key, entries.filter(item => item !== entry));
    pruneRuntimeCaches(now);
    return entry;
}
async function resolveExecutorMember(guild, executorId) { return executorId ? guild.members.cache.get(executorId) || await guild.members.fetch(executorId).catch(() => null) : null; }
async function enforceLockOnce(guild, userId, type, expectedVersion = undefined) {
    const lock = getLock(guild.id, userId); const field = fieldFor(type); const meta = metadataFor(type);
    if (stopping || !lock?.[field] || (expectedVersion && lock[meta.version] !== expectedVersion)) return { complete: true, enforced: false };
    const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
    if (!member?.voice?.channel) return { complete: true, enforced: false };
    if (isAdministrator(member, guild) && !(type === "mute" && lock.muteOwnerForced)) {
        await clearLockField(guild.id, userId, type, lock[meta.version]);
        return { complete: true, enforced: false };
    }
    try {
        await setVoice(member, type, true, "voiceadmin lock enforcement");
        return { complete: true, enforced: true };
    } catch (error) {
        return { complete: false, enforced: false, error };
    }
}
async function enforceLock(guild, userId, type, expectedVersion = undefined, options = {}) {
    const key = pendingKey(guild.id, userId, type);
    const currentLock = getLock(guild.id, userId);
    const requestedVersion = expectedVersion === undefined
        ? currentLock?.[metadataFor(type).version] || null
        : expectedVersion;
    const active = enforcementActions.get(key);
    if (active?.version === requestedVersion) return active.promise;
    if (active) cancelController(active);
    const delays = Array.isArray(options.retryDelaysMs) && options.retryDelaysMs.length
        ? options.retryDelaysMs
        : ENFORCEMENT_RETRY_DELAYS_MS;
    const controller = { cancelled: false, sleeps: new Set(), promise: null, version: requestedVersion };
    controller.promise = Promise.resolve().then(async () => {
        let lastError = null;
        for (const delay of delays) {
            if (controller.cancelled) return false;
            if (delay > 0 && !(await pause(delay, controller))) return false;
            const result = await enforceLockOnce(guild, userId, type, requestedVersion);
            if (result.complete) return result.enforced;
            lastError = result.error || lastError;
        }
        if (!stopping && !controller.cancelled) {
            await reportEnforcementFailure("lock_enforcement", { guildId: guild.id, userId, type, code: lastError?.code || lastError?.name || "discord_api_failed" });
            throw makeError("VOICE_ADMIN_ENFORCEMENT_FAILED", "lock_enforcement", lastError);
        }
        return false;
    }).finally(() => {
        cancelController(controller);
        if (enforcementActions.get(key) === controller) enforcementActions.delete(key);
    });
    enforcementActions.set(key, controller);
    return controller.promise;
}
async function deletePreviousNotice(guild, notice) {
    const channel = guild.channels.cache.get(notice.channelId) || await guild.channels.fetch(notice.channelId).catch(() => null);
    const previous = await channel?.messages?.fetch?.(notice.messageId).catch(() => null);
    await previous?.delete?.().catch(() => {});
}
function getNoticeActionLabel(type) {
    if (type === "mute") return "เปิดไมค์";
    if (type === "deaf") return "เปิดหู";
    return "เปิดไมค์หรือหู";
}

async function persistNoticeRecord(notice) {
    let result = null;
    let lastError = null;
    for (let attempt = 0; attempt < 2 && !stopping; attempt++) {
        try {
            result = await VoiceAdminNotice.updateOne(
                { guildId: notice.guildId, actorId: notice.actorId, targetId: notice.targetId },
                { $set: notice },
                { upsert: true }
            );
            if (operationWasAcknowledged(result, { allowUpsert: true })) break;
        } catch (error) {
            lastError = error;
            result = null;
        }
    }
    return { result, lastError };
}

async function sendUnauthorizedNotice(guild, actorId, targetId, options = {}) {
    const key = noticeKey(guild.id, actorId, targetId);
    const before = noticeQueues.get(key) || Promise.resolve();
    const next = before.catch(() => {}).then(async () => {
        if (stopping) return false;
        const target = guild.members.cache.get(targetId) || await guild.members.fetch(targetId).catch(() => null);
        const channel = target?.voice?.channel;
        if (!isVoiceChannel(channel)) return false;

        const previous = notices.get(key);
        if (previous && Date.now() - Number(previous.notifiedAt || 0) < NOTICE_WINDOW_MS) {
            await deletePreviousNotice(guild, previous);
        }

        const actionLabel = getNoticeActionLabel(options.type);
        const content = options.ownerForced
            ? `<@${actorId}> คุณไม่มีสิทธิ์${actionLabel}ให้ <@${targetId}> เนื่องจากถูกล็อกโดยผู้ดูแลระบบบอตระดับสูงสุด (Owner)`
            : `<@${actorId}> คุณไม่มีสิทธิ์${actionLabel}ให้ <@${targetId}> กรุณาติดต่อแอดมิน`;
        const sent = await channel.send({ content, allowedMentions: { users: [String(actorId)], parse: [] } }).catch(() => null);
        if (!sent) return false;

        const notice = {
            guildId: String(guild.id),
            actorId: String(actorId),
            targetId: String(targetId),
            channelId: String(channel.id),
            messageId: String(sent.id),
            notifiedAt: new Date()
        };

        const { result, lastError } = await persistNoticeRecord(notice);
        if (!operationWasAcknowledged(result, { allowUpsert: true })) {
            await reportPersistenceFailure("notice_pointer", { guildId: guild.id, userId: targetId, type: "notice", error: lastError });
            return false;
        }
        notices.set(key, notice);
        return true;
    }).finally(() => {
        if (noticeQueues.get(key) === next) noticeQueues.delete(key);
    });
    noticeQueues.set(key, next);
    return next;
}
async function processExternalUnlock(guild, userId, type, entry, client, pending) {
    const lock = getLock(guild.id, userId); const field = fieldFor(type); const meta = metadataFor(type);
    if (stopping || !lock?.[field] || lock[meta.version] !== pending.version) return false;
    const executorId = entry?.executorId || null;
    if (executorId && String(executorId) === String(client.user?.id)) return false;
    if (!entry) auditWatermarks.set(pendingKey(guild.id, userId, type), Date.now());
    const executor = await resolveExecutorMember(guild, executorId);
    if (type === "mute" && lock.muteOwnerForced) {
        if (executorId && isConfiguredOwner(config, executorId)) {
            await clearLockField(guild.id, userId, type, pending.version);
            return true;
        }
        await enforceLock(guild, userId, type, pending.version);
        if (executorId) await sendUnauthorizedNotice(guild, executorId, userId, { ownerForced: true, type });
        return true;
    }
    if (isAdministrator(executor, guild)) { await clearLockField(guild.id, userId, type, pending.version); return true; }
    await enforceLock(guild, userId, type, pending.version);
    if (executorId) await sendUnauthorizedNotice(guild, executorId, userId, { ownerForced: false, type });
    return true;
}
async function findRecentAuditUnlock(guild, userId, type, pending) {
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberUpdate, limit: 10 }).catch(() => null);
    const auditField = type === "mute" ? "mute" : "deaf"; const now = Date.now();
    const cacheKey = pendingKey(guild.id, userId, type);
    const watermark = Number(auditWatermarks.get(cacheKey) || 0);
    const entry = logs?.entries?.find(item => {
        const auditId = String(item.id || `${cacheKey}:${item.createdTimestamp}`);
        return String(item.targetId) === String(userId) && changeContains(item, auditField) &&
            Number(item.createdTimestamp || 0) >= pending.lockedAt &&
            Number(item.createdTimestamp || 0) >= pending.stateAt - 1000 &&
            Number(item.createdTimestamp || 0) > watermark &&
            now - Number(item.createdTimestamp || 0) <= AUDIT_CACHE_WINDOW_MS &&
            !processedAuditEntries.has(auditId);
    }) || null;
    if (entry) processedAuditEntries.set(String(entry.id || `${cacheKey}:${entry.createdTimestamp}`), { at: now, guildId: String(guild.id), userId: String(userId) });
    pruneRuntimeCaches(now);
    return entry;
}
function clearPending(guildId, userId, type) {
    const key = pendingKey(guildId, userId, type); const pending = pendingEnforcement.get(key);
    if (!pending) return null;
    clearTimeout(pending.timer);
    pendingEnforcement.delete(key);
    return pending;
}
function scheduleFallback(guild, userId, type, client, lock) {
    pruneRuntimeCaches();
    const key = pendingKey(guild.id, userId, type); clearPending(guild.id, userId, type);
    const meta = metadataFor(type); const pending = { version: lock[meta.version], lockedAt: Number(lock[meta.at] || lock.updatedAt || Date.now()), stateAt: Date.now(), timer: null };
    const cached = takeMatchingAudit(guild, userId, type, pending);
    if (cached) { processExternalUnlock(guild, userId, type, cached, client, pending).catch(() => {}); return; }
    pending.timer = setTimeout(() => {
        pendingEnforcement.delete(key);
        Promise.resolve().then(async () => {
            if (stopping) return;
            const entry = await findRecentAuditUnlock(guild, userId, type, pending);
            await processExternalUnlock(guild, userId, type, entry, client, pending);
        }).catch(async error => {
            if (error?.code === "VOICE_ADMIN_PERSISTENCE_FAILED") await reportPersistenceFailure("audit_enforcement", { guildId: guild.id, userId, type, error });
        });
    }, AUDIT_WAIT_MS);
    pending.timer.unref?.(); pendingEnforcement.set(key, pending);
}
function clearInvalidAdministratorLock(guild, userId, member, lock) {
    if (!isAdministrator(member, guild)) return false;
    if (!lock.muteOwnerForced) {
        clearAllLocksForMember(guild.id, userId).catch(() => {});
        return true;
    }
    if (lock.deafLocked) clearLockField(guild.id, userId, "deaf", lock.deafVersion).catch(() => {});
    return false;
}
function enforceJoinedVoiceLocks(guild, userId, lock, oldState, newState) {
    if (oldState?.channel || !newState?.channel) return false;
    if (lock.muteLocked) enforceLock(guild, userId, "mute", lock.muteVersion).catch(() => {});
    if (lock.deafLocked) enforceLock(guild, userId, "deaf", lock.deafVersion).catch(() => {});
    return true;
}
function scheduleReleasedVoiceLocks(guild, userId, lock, oldState, newState, client) {
    if (!newState?.channel) return;
    if (oldState?.serverMute === true && newState.serverMute === false && lock.muteLocked) scheduleFallback(guild, userId, "mute", client, lock);
    if (oldState?.serverDeaf === true && newState.serverDeaf === false && lock.deafLocked) scheduleFallback(guild, userId, "deaf", client, lock);
}
function handleVoiceStateUpdate(oldState, newState, client) {
    const guild = newState?.guild || oldState?.guild; const userId = newState?.id || oldState?.id;
    if (!initialized || stopping || !guild || !userId) return;
    const lock = getLock(guild.id, userId); if (!lock) return;
    const member = newState.member || oldState.member;
    if (clearInvalidAdministratorLock(guild, userId, member, lock)) return;
    if (enforceJoinedVoiceLocks(guild, userId, lock, oldState, newState)) return;
    scheduleReleasedVoiceLocks(guild, userId, lock, oldState, newState, client);
}
function handleAuditLogEntry(entry, guild, client) {
    if (!initialized || stopping || entry?.action !== AuditLogEvent.MemberUpdate || !entry?.targetId) return;
    pruneRuntimeCaches();
    cacheAuditEntry(entry, guild);
    for (const type of ["mute", "deaf"]) {
        if (!changeContains(entry, type)) continue;
        const pending = pendingEnforcement.get(pendingKey(guild.id, entry.targetId, type));
        if (!pending) continue;
        const matched = takeMatchingAudit(guild, entry.targetId, type, pending);
        if (matched) { clearPending(guild.id, entry.targetId, type); processExternalUnlock(guild, entry.targetId, type, matched, client, pending).catch(() => {}); }
    }
}
function handleMemberUpdate(_oldMember, member) {
    if (!initialized || stopping || !member?.guild || !isAdministrator(member, member.guild)) return;
    const lock = getLock(member.guild.id, member.id);
    if (!lock) return;
    if (!lock.muteOwnerForced) {
        clearAllLocksForMember(member.guild.id, member.id).catch(() => {});
        return;
    }
    if (lock.deafLocked) clearLockField(member.guild.id, member.id, "deaf", lock.deafVersion).catch(() => {});
}
function handleMemberRemove(member) { if (initialized && !stopping && member?.guild) clearAllLocksForMember(member.guild.id, member.id, { retire: true }).catch(() => {}); }
function countActiveGuildLocks(guildLocks) {
    return Array.from(guildLocks.values()).filter(lock => lock.muteLocked || lock.deafLocked).length;
}
async function resolveReconciliationMember(guild, userId) {
    const cached = guild.members.cache.get(userId);
    if (cached) return { member: cached, missing: false };
    try {
        const member = await guild.members.fetch(userId);
        return { member, missing: !member };
    } catch (error) {
        return { member: null, missing: Number(error?.code) === 10007 };
    }
}
async function reconcileConnectedLock(guild, lock, options, summary) {
    const resolved = await resolveReconciliationMember(guild, lock.userId);
    if (resolved.missing) {
        await clearAllLocksForMember(guild.id, lock.userId, { retire: true });
        summary.skipped++;
        return;
    }
    if (!resolved.member?.voice?.channel) {
        summary.skipped++;
        return;
    }
    const attempts = [];
    if (lock.muteLocked) attempts.push(enforceLock(guild, lock.userId, "mute", lock.muteVersion, options));
    if (lock.deafLocked) attempts.push(enforceLock(guild, lock.userId, "deaf", lock.deafVersion, options));
    const settled = await Promise.allSettled(attempts);
    for (const attempt of settled) {
        if (attempt.status === "fulfilled" && attempt.value) summary.enforced++;
    }
    const failure = settled.find(attempt => attempt.status === "rejected");
    if (failure) throw failure.reason;
}
async function reconcileGuildLocks(guildId, guildLocks, client, options, summary, startedAt, maxDurationMs) {
    if (Date.now() - startedAt >= maxDurationMs) {
        summary.timedOut += countActiveGuildLocks(guildLocks);
        return;
    }
    const guild = client?.guilds?.cache?.get?.(guildId);
    if (!guild) {
        const removedLocks = guildLocks.size;
        await clearGuildData(guildId);
        summary.skipped += removedLocks;
        return;
    }
    summary.guilds++;
    try {
        const result = await withGuildAction(guildId, controller => runBulkUnsafe(
            Array.from(guildLocks.values()),
            lock => reconcileConnectedLock(guild, lock, options, summary),
            controller,
            { startedAt, maxDurationMs }
        ));
        summary.targeted += result.targeted;
        summary.failed += result.failed;
        summary.timedOut += result.timedOut;
    } catch (error) {
        if (error?.code === "VOICE_ADMIN_ACTION_IN_PROGRESS") {
            summary.skipped += guildLocks.size;
            return;
        }
        throw error;
    }
}
async function reconcileConnectedLocks(client, options = {}) {
    assertRunnable();
    const maxDurationMs = Number(options.maxDurationMs || ACTION_MAX_DURATION_MS);
    const startedAt = Number(options.startedAt || Date.now());
    const summary = { guilds: 0, targeted: 0, enforced: 0, skipped: 0, failed: 0, timedOut: 0 };
    for (const [guildId, guildLocks] of Array.from(locksByGuild.entries())) {
        await reconcileGuildLocks(guildId, guildLocks, client, options, summary, startedAt, maxDurationMs);
    }
    if (summary.failed || summary.timedOut) {
        await reportEnforcementFailure("startup_reconciliation", { guildId: "multiple", userId: "multiple", type: "multiple", code: summary.timedOut ? "reconciliation_timed_out" : "reconciliation_failed" });
        if (options.requireComplete === true) throw makeError("VOICE_ADMIN_RECONCILIATION_INCOMPLETE", "startup_reconciliation");
    }
    return summary;
}
async function stop() {
    stopping = true;
    for (const pending of pendingEnforcement.values()) clearTimeout(pending.timer);
    pendingEnforcement.clear(); cachedAuditUnlocks.clear(); processedAuditEntries.clear(); auditWatermarks.clear(); notices.clear();
    for (const controller of activeGuildActions.values()) cancelController(controller);
    for (const controller of enforcementActions.values()) cancelController(controller);
    for (const waiter of globalActionWaiters.splice(0)) settleGlobalWaiter(waiter, false);
    for (const pending of sleepTimers) { clearTimeout(pending.timer); pending.resolve(false); }
    sleepTimers.clear();
    const active = [...activeGuildActions.values()].map(controller => controller.promise.catch(() => {}));
    const enforcement = [...enforcementActions.values()].map(controller => controller.promise.catch(() => {}));
    const queues = [...noticeQueues.values()].map(queue => queue.catch(() => {}));
    let timer;
    await Promise.race([Promise.allSettled([...active, ...enforcement, ...queues]), new Promise(resolve => { timer = setTimeout(resolve, STOP_DRAIN_MS); timer.unref?.(); })]);
    clearTimeout(timer);
    activeGuildActions.clear(); enforcementActions.clear(); noticeQueues.clear(); retiredGuilds.clear(); retiredMembers.clear(); activeGlobalMemberOperations = 0; initialized = false;
}

module.exports = {
    IDS, VoiceAdminLock, VoiceAdminNotice, initialize, stop, clearGuildData, handleGuildCreate,
    handleVoiceAdminCommand, isVoiceAdminInteraction, handleVoiceAdminInteraction, handleSecretMessage,
    handleVoiceStateUpdate, handleAuditLogEntry, handleMemberUpdate, handleMemberRemove, reconcileConnectedLocks,
    _test: {
        parseSecretCommand, sourceMembers, isVoiceChannel, isStillInSource, buildResult, resultEmoji, buildPersistenceFailureContext, getLock, setCachedLock, lockKey, noticeKey, BULK_SKIPPED,
        changeContains, buildPanel, isAdministrator, verifyVoiceAdminAccess, runBulkUnsafe, withDeadline, isVoiceAdminInteraction,
        operationWasAcknowledged, writeLock, clearLockField, clearBothLocks, clearAllLocksForMember, lockVoiceState,
        unlockVoiceState, unlockBoth, disconnectMembers, moveMembers, ensureBotPermission, runPanelAction,
        sendUnauthorizedNotice, deletePreviousNotice, findRecentAuditUnlock, resolveExecutorMember, scheduleFallback, clearPending, enforceLock, reconcileConnectedLocks,
        pendingEnforcement, cachedAuditUnlocks, processedAuditEntries, auditWatermarks, enforcementActions, activeGuildActions, notices, noticeQueues, retiredGuilds, retiredMembers, globalActionWaiters, pruneRuntimeCaches,
        getGlobalMemberOperationCount() { return activeGlobalMemberOperations; },
        setInitialized(value) { initialized = value; stopping = false; },
        reset() {
            for (const pending of pendingEnforcement.values()) clearTimeout(pending.timer);
            for (const controller of activeGuildActions.values()) cancelController(controller);
            for (const controller of enforcementActions.values()) cancelController(controller);
            locksByGuild.clear(); notices.clear(); pendingEnforcement.clear(); cachedAuditUnlocks.clear();
            processedAuditEntries.clear(); auditWatermarks.clear(); enforcementActions.clear(); activeGuildActions.clear(); retiredGuilds.clear(); retiredMembers.clear();
            for (const waiter of globalActionWaiters.splice(0)) settleGlobalWaiter(waiter, false);
            activeGlobalMemberOperations = 0;
            noticeQueues.clear(); stopping = false; initialized = false;
        }
    }
};
