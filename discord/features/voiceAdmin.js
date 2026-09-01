"use strict";

const mongoose = require("mongoose");
const { ActionRowBuilder, AuditLogEvent, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, EmbedBuilder, PermissionFlagsBits } = require("discord.js");
const config = require("../config.json");
const { markCommandAccepted } = require("../guards/commandGuards");
const { sendWebhookEvent } = require("../core/webhooks");

const ACTION_DELAY_MS = 500;
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
let initialized = false;
let stopping = false;
let actionSequence = 0;

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
function normalizeLock(lock) {
    const updatedAt = Number(lock.updatedAt || Date.now());
    return {
        guildId: String(lock.guildId), userId: String(lock.userId), muteLocked: lock.muteLocked === true, deafLocked: lock.deafLocked === true,
        lockedBy: lock.lockedBy ? String(lock.lockedBy) : null, updatedAt,
        muteLockedBy: lock.muteLockedBy ? String(lock.muteLockedBy) : (lock.lockedBy ? String(lock.lockedBy) : null),
        muteLockedAt: Number(lock.muteLockedAt || updatedAt), muteVersion: lock.muteVersion ? String(lock.muteVersion) : null,
        muteOwnerForced: lock.muteOwnerForced === true,
        deafLockedBy: lock.deafLockedBy ? String(lock.deafLockedBy) : (lock.lockedBy ? String(lock.lockedBy) : null),
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
async function reportPersistenceFailure(operation, context = {}) {
    await sendWebhookEvent({
        severity: "ERROR", category: "VOICE_ADMIN", code: "voiceadmin.persistence_failed", state: "OPEN",
        title: "บันทึก Voice Admin lock ไม่สำเร็จ",
        description: "ระบบไม่ยืนยันสถานะ lock จากฐานข้อมูล จึงไม่อ้างว่างานสำเร็จ",
        impact: "สถานะใน Discord และ lock ถาวรอาจต้องตรวจสอบ",
        action: "ตรวจ MongoDB และลองคำสั่งใหม่หลังระบบกลับมาปกติ",
        context: { "การทำงาน": String(operation), "Guild ID": String(context.guildId || "unknown"), "User ID": String(context.userId || "unknown"), "ประเภท": context.type || "unknown" },
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
    if (!result || result.acknowledged !== true) return false;
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

async function writeLock(guildId, userId, type, actorId, expectedVersion = undefined, options = {}) {
    if (isRetiredTarget(guildId, userId)) throw makeError("VOICE_ADMIN_TARGET_RETIRED", "write_lock");
    const field = fieldFor(type); const meta = metadataFor(type); const version = createVersion(); const now = Date.now();
    const filter = { guildId: String(guildId), userId: String(userId) };
    if (expectedVersion !== undefined) filter[meta.version] = expectedVersion;
    let result;
    try {
        result = await VoiceAdminLock.updateOne(filter, {
            $set: {
                [field]: true, [meta.by]: String(actorId), [meta.at]: now, [meta.version]: version,
                ...(type === "mute" ? { muteOwnerForced: options.ownerForced === true } : {}),
                lockedBy: String(actorId), updatedAt: now
            },
            $setOnInsert: { guildId: String(guildId), userId: String(userId), muteLocked: false, deafLocked: false }
        }, { upsert: expectedVersion === undefined });
    } catch (error) {
        await reportPersistenceFailure("write_lock", { guildId, userId, type });
        throw makeError("VOICE_ADMIN_PERSISTENCE_FAILED", "write_lock", error);
    }
    if (!operationWasAcknowledged(result, { allowUpsert: expectedVersion === undefined })) {
        if (expectedVersion !== undefined) throw makeError("VOICE_ADMIN_LOCK_CONFLICT", "write_lock");
        await reportPersistenceFailure("write_lock", { guildId, userId, type });
        throw makeError("VOICE_ADMIN_PERSISTENCE_FAILED", "write_lock");
    }
    if (isRetiredTarget(guildId, userId)) {
        try {
            const removed = await VoiceAdminLock.deleteOne({ guildId: String(guildId), userId: String(userId), [meta.version]: version });
            if (!operationWasAcknowledged(removed, { allowDeleteZero: true })) throw makeError("VOICE_ADMIN_PERSISTENCE_FAILED", "discard_retired_lock");
        } catch (error) {
            await reportPersistenceFailure("discard_retired_lock", { guildId, userId, type });
            throw makeError("VOICE_ADMIN_PERSISTENCE_FAILED", "discard_retired_lock", error);
        }
        throw makeError("VOICE_ADMIN_TARGET_RETIRED", "write_lock");
    }
    const previous = getLock(guildId, userId) || { guildId, userId, muteLocked: false, deafLocked: false };
    return {
        version,
        lock: setCachedLock({
            ...previous, [field]: true, [meta.by]: actorId, [meta.at]: now, [meta.version]: version,
            ...(type === "mute" ? { muteOwnerForced: options.ownerForced === true } : {}),
            lockedBy: actorId, updatedAt: now
        })
    };
}
async function clearLockField(guildId, userId, type, expectedVersion = undefined) {
    const field = fieldFor(type); const meta = metadataFor(type); const version = createVersion(); const now = Date.now();
    const filter = { guildId: String(guildId), userId: String(userId) };
    if (expectedVersion !== undefined) filter[meta.version] = expectedVersion;
    let result;
    try {
        result = await VoiceAdminLock.updateOne(filter, { $set: {
            [field]: false, [meta.by]: null, [meta.at]: null, [meta.version]: version,
            ...(type === "mute" ? { muteOwnerForced: false } : {}),
            updatedAt: now
        } });
    }
    catch (error) { await reportPersistenceFailure("clear_lock", { guildId, userId, type }); throw makeError("VOICE_ADMIN_PERSISTENCE_FAILED", "clear_lock", error); }
    if (!operationWasAcknowledged(result)) {
        if (expectedVersion !== undefined) throw makeError("VOICE_ADMIN_LOCK_CONFLICT", "clear_lock");
        await reportPersistenceFailure("clear_lock", { guildId, userId, type }); throw makeError("VOICE_ADMIN_PERSISTENCE_FAILED", "clear_lock");
    }
    const previous = getLock(guildId, userId) || { guildId, userId, muteLocked: false, deafLocked: false };
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
    catch (error) { await reportPersistenceFailure("clear_both", { guildId, userId, type: "both" }); throw makeError("VOICE_ADMIN_PERSISTENCE_FAILED", "clear_both", error); }
    if (!operationWasAcknowledged(result)) {
        if (expected) throw makeError("VOICE_ADMIN_LOCK_CONFLICT", "clear_both");
        await reportPersistenceFailure("clear_both", { guildId, userId, type: "both" }); throw makeError("VOICE_ADMIN_PERSISTENCE_FAILED", "clear_both");
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
    catch (error) { await reportPersistenceFailure("member_cleanup", { guildId, userId }); throw makeError("VOICE_ADMIN_PERSISTENCE_FAILED", "member_cleanup", error); }
    finally {
        if (retire && !retainedUntilActionFinishes) retiredMembers.delete(lockKey(guildId, userId));
    }
    if (!result.every(item => operationWasAcknowledged(item, { allowDeleteZero: true }))) { await reportPersistenceFailure("member_cleanup", { guildId, userId }); throw makeError("VOICE_ADMIN_PERSISTENCE_FAILED", "member_cleanup"); }
    const locks = getGuildLocks(guildId); locks.delete(String(userId)); if (!locks.size) locksByGuild.delete(String(guildId));
}
async function clearGuildData(guildId) {
    const normalizedGuildId = String(guildId);
    retiredGuilds.add(normalizedGuildId);
    const active = activeGuildActions.get(normalizedGuildId);
    if (active) cancelController(active);
    for (const lock of getGuildLocks(normalizedGuildId).values()) clearMemberRuntimeState(normalizedGuildId, lock.userId);
    let result;
    try { result = await Promise.all([VoiceAdminLock.deleteMany({ guildId: normalizedGuildId }), VoiceAdminNotice.deleteMany({ guildId: normalizedGuildId })]); }
    catch (error) { await reportPersistenceFailure("guild_cleanup", { guildId }); throw makeError("VOICE_ADMIN_PERSISTENCE_FAILED", "guild_cleanup", error); }
    if (!result.every(item => operationWasAcknowledged(item, { allowDeleteZero: true }))) { await reportPersistenceFailure("guild_cleanup", { guildId }); throw makeError("VOICE_ADMIN_PERSISTENCE_FAILED", "guild_cleanup"); }
    locksByGuild.delete(normalizedGuildId);
    for (const key of cachedAuditUnlocks.keys()) if (key.startsWith(`${normalizedGuildId}:`)) cachedAuditUnlocks.delete(key);
    for (const key of auditWatermarks.keys()) if (key.startsWith(`${normalizedGuildId}:`)) auditWatermarks.delete(key);
    for (const [id, details] of processedAuditEntries) if (details?.guildId === normalizedGuildId) processedAuditEntries.delete(id);
    for (const key of notices.keys()) if (key.startsWith(`${normalizedGuildId}:`)) notices.delete(key);
    for (const [key, pending] of pendingEnforcement) if (key.startsWith(`${normalizedGuildId}:`)) { clearTimeout(pending.timer); pendingEnforcement.delete(key); }
    for (const [key, controller] of enforcementActions) if (key.startsWith(`${normalizedGuildId}:`)) { cancelController(controller); enforcementActions.delete(key); }
    for (const key of noticeQueues.keys()) if (key.startsWith(`${normalizedGuildId}:`)) noticeQueues.delete(key);
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
function cancelController(controller) {
    controller.cancelled = true;
    for (const pending of controller.sleeps) { clearTimeout(pending.timer); sleepTimers.delete(pending); pending.resolve(false); }
    controller.sleeps.clear();
}
async function withGuildAction(guildId, work) {
    assertRunnable();
    const id = String(guildId);
    if (activeGuildActions.has(id)) throw makeError("VOICE_ADMIN_ACTION_IN_PROGRESS");
    const controller = { cancelled: false, sleeps: new Set(), promise: null };
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
function newResult(members) { return { targeted: members.length, succeeded: 0, failed: 0, timedOut: 0, persistenceFailed: 0, failedMembers: [] }; }
async function runBulkUnsafe(members, runOne, controller = { cancelled: false, sleeps: new Set() }, options = {}) {
    const result = newResult(members); const startedAt = options.startedAt || Date.now(); const maxDurationMs = options.maxDurationMs || ACTION_MAX_DURATION_MS;
    for (let index = 0; index < members.length; index++) {
        const remaining = maxDurationMs - (Date.now() - startedAt);
        if (stopping || controller.cancelled || remaining <= 0) { result.timedOut += members.length - index; break; }
        try { await withDeadline(runOne(members[index]), remaining); result.succeeded++; }
        catch (error) {
            if (error?.code === "VOICE_ADMIN_MEMBER_TIMEOUT") { result.timedOut += members.length - index; break; }
            result.failed++; result.failedMembers.push(String(members[index].id));
            if (error?.code === "VOICE_ADMIN_PERSISTENCE_FAILED") result.persistenceFailed++;
        }
        if (index < members.length - 1 && !(await pause(ACTION_DELAY_MS, controller))) { result.timedOut += members.length - index - 1; break; }
    }
    return result;
}
function buildResult(action, result) {
    const timeout = result.timedOut ? ` | หมดเวลา ${result.timedOut} คน` : "";
    const persistence = result.persistenceFailed ? ` | บันทึกสถานะไม่สำเร็จ ${result.persistenceFailed} คน` : "";
    return `**${action}** — เป้าหมาย ${result.targeted} คน | สำเร็จ ${result.succeeded} คน | ล้มเหลว ${result.failed} คน${timeout}${persistence}`;
}

function getBotMember(guild) { return guild?.members?.me || guild?.members?.cache?.get?.(guild?.client?.user?.id) || null; }
function botCanInChannel(guild, channel, permission) {
    const bot = getBotMember(guild); const permissions = channel?.permissionsFor?.(bot) || bot?.permissions;
    try { return permissions?.has?.(permission) === true; } catch { return false; }
}
function sourceMembers(channel, { includeAdministrators = false, excludeId = null } = {}) {
    return Array.from(channel?.members?.values?.() || []).filter(member => (!excludeId || String(member.id) !== String(excludeId)) && (includeAdministrators || !isAdministrator(member, channel.guild)));
}
function buildPanel(channel, status = null) {
    const members = Array.from(channel?.members?.values?.() || []); const inChannel = new Set(members.map(member => String(member.id)));
    let mute = 0; let deaf = 0;
    for (const [id, lock] of getGuildLocks(channel?.guild?.id)) { if (inChannel.has(id) && lock.muteLocked) mute++; if (inChannel.has(id) && lock.deafLocked) deaf++; }
    const embed = new EmbedBuilder().setColor(config.system.themeColors.primary).setTitle("Voice Admin").setDescription([
        `ห้องต้นทาง: <#${channel.id}>`, `สมาชิกทั้งหมด: **${members.length}** | จัดการได้: **${sourceMembers(channel).length}**`, `ล็อกไมค์: **${mute}** | ล็อกหู: **${deaf}**`, status ? `\n${status}` : ""
    ].join("\n"));
    const actions = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(IDS.DISCONNECT).setLabel("ตัดทั้งหมด").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(IDS.LOCK_MUTE).setLabel("ปิดไมค์").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(IDS.LOCK_DEAF).setLabel("ปิดหู").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(IDS.UNLOCK_MUTE).setLabel("เปิดไมค์").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(IDS.UNLOCK_DEAF).setLabel("เปิดหู").setStyle(ButtonStyle.Success)
    );
    const move = new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(IDS.MOVE).setPlaceholder("เลือกห้องเสียงปลายทางเพื่อย้ายทันที").setChannelTypes(ChannelType.GuildVoice).setMinValues(1).setMaxValues(1));
    const refresh = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(IDS.REFRESH).setLabel("รีเฟรช").setStyle(ButtonStyle.Primary));
    return { embeds: [embed], components: [actions, move, refresh] };
}
function verifyVoiceAdminAccess(actor, channel) { return !isVoiceChannel(channel) ? "ต้องใช้คำสั่งในแชทของห้องเสียงปกติ" : !isAdministrator(actor, channel.guild) ? "ต้องเป็น Administrator" : null; }
async function ensureBotPermission(guild, source, action, destination = null) {
    const permission = action === "mute" ? PermissionFlagsBits.MuteMembers : action === "deaf" ? PermissionFlagsBits.DeafenMembers : PermissionFlagsBits.MoveMembers;
    if (!botCanInChannel(guild, source, permission)) throw makeError("VOICE_ADMIN_BOT_PERMISSION_MISSING");
    if (action === "move" && (!isVoiceChannel(destination) || destination.id === source.id || !botCanInChannel(guild, destination, PermissionFlagsBits.Connect))) throw makeError("VOICE_ADMIN_DESTINATION_INVALID");
}
async function setVoice(member, type, enabled, reason) { return type === "mute" ? member.voice.setMute(enabled, reason) : member.voice.setDeaf(enabled, reason); }
async function setVoiceBoth(member, enabled, reason) {
    if (typeof member.edit === "function") return member.edit({ mute: enabled, deaf: enabled, reason });
    await member.voice.setMute(enabled, reason); return member.voice.setDeaf(enabled, reason);
}
async function lockVoiceState(guild, members, type, actorId, options = {}) {
    return withGuildAction(guild.id, controller => runBulkUnsafe(members, async member => {
        const ownerForced = type === "mute" && options.ownerForced === true;
        if (isAdministrator(member, guild) && !ownerForced) return setVoice(member, type, true, "voiceadmin temporary lock");
        const written = await writeLock(guild.id, member.id, type, actorId, undefined, { ownerForced });
        try { await setVoice(member, type, true, "voiceadmin lock"); }
        catch (error) {
            try { await clearLockField(guild.id, member.id, type, written.version); }
            catch (rollbackError) { if (rollbackError.code === "VOICE_ADMIN_PERSISTENCE_FAILED") throw rollbackError; }
            throw error;
        }
    }, controller));
}
async function unlockVoiceState(guild, members, type) {
    return withGuildAction(guild.id, controller => runBulkUnsafe(members, async member => {
        const previous = getLock(guild.id, member.id); let cleared = null;
        if (type === "mute" && previous?.muteOwnerForced) throw makeError("VOICE_ADMIN_OWNER_LOCKED");
        if (previous?.[fieldFor(type)]) cleared = await clearLockField(guild.id, member.id, type, previous[metadataFor(type).version]);
        try { await setVoice(member, type, false, "voiceadmin unlock"); }
        catch (error) {
            if (cleared && previous?.[fieldFor(type)]) {
                await writeLock(
                    guild.id, member.id, type,
                    previous[metadataFor(type).by] || previous.lockedBy || "voiceadmin",
                    cleared.version,
                    { ownerForced: type === "mute" && previous.muteOwnerForced === true }
                );
            }
            throw error;
        }
    }, controller));
}
async function unlockBoth(guild, members) {
    return withGuildAction(guild.id, controller => runBulkUnsafe(members, async member => {
        const previous = getLock(guild.id, member.id); let cleared = null;
        if (previous) cleared = await clearBothLocks(guild.id, member.id, { mute: previous.muteVersion, deaf: previous.deafVersion });
        try { await setVoiceBoth(member, false, "voiceadmin unlock all"); }
        catch (error) {
            const restored = await Promise.allSettled([
                previous?.muteLocked
                    ? writeLock(guild.id, member.id, "mute", previous.muteLockedBy || previous.lockedBy || "voiceadmin", cleared?.versions.mute, { ownerForced: previous.muteOwnerForced === true })
                    : Promise.resolve(),
                previous?.deafLocked
                    ? writeLock(guild.id, member.id, "deaf", previous.deafLockedBy || previous.lockedBy || "voiceadmin", cleared?.versions.deaf)
                    : Promise.resolve()
            ]);
            const rollbackFailure = restored.find(item => item.status === "rejected");
            if (rollbackFailure) throw makeError("VOICE_ADMIN_PERSISTENCE_FAILED", "unlock_both_rollback", rollbackFailure.reason);
            throw error;
        }
    }, controller));
}
async function disconnectMembers(guild, members) { return withGuildAction(guild.id, controller => runBulkUnsafe(members, member => member.voice.disconnect("voiceadmin disconnect"), controller)); }
async function moveMembers(guild, source, destination, members) { await ensureBotPermission(guild, source, "move", destination); return withGuildAction(guild.id, controller => runBulkUnsafe(members, member => member.voice.setChannel(destination, "voiceadmin move"), controller)); }
async function runPanelAction(interaction, action, destination = null) {
    const channel = interaction.channel; const access = verifyVoiceAdminAccess(interaction.member, channel); if (access) throw makeError(`VOICE_ADMIN_ACCESS:${access}`);
    const members = sourceMembers(channel);
    if (action === "disconnect") { await ensureBotPermission(interaction.guild, channel, "disconnect"); return disconnectMembers(interaction.guild, members); }
    if (action === "mute") { await ensureBotPermission(interaction.guild, channel, "mute"); return lockVoiceState(interaction.guild, members, "mute", interaction.user.id); }
    if (action === "deaf") { await ensureBotPermission(interaction.guild, channel, "deaf"); return lockVoiceState(interaction.guild, members, "deaf", interaction.user.id); }
    if (action === "unmute") { await ensureBotPermission(interaction.guild, channel, "mute"); return unlockVoiceState(interaction.guild, members, "mute"); }
    if (action === "undeaf") { await ensureBotPermission(interaction.guild, channel, "deaf"); return unlockVoiceState(interaction.guild, members, "deaf"); }
    if (action === "move") return moveMembers(interaction.guild, channel, destination, members);
    throw makeError("VOICE_ADMIN_ACTION_INVALID");
}
async function handleVoiceAdminCommand(interaction) {
    const access = verifyVoiceAdminAccess(interaction.member, interaction.channel);
    if (access) return interaction.reply({ content: `> ${config.emojis.no_entry} ${access}`, ephemeral: true });
    const reply = await interaction.reply({ ...buildPanel(interaction.channel), ephemeral: true });
    markCommandAccepted(interaction);
    return reply;
}
function isVoiceAdminInteraction(interaction) { return (interaction?.isButton?.() || interaction?.isChannelSelectMenu?.()) && String(interaction.customId || "").startsWith(IDS.PREFIX); }
async function handleVoiceAdminInteraction(interaction) {
    const access = verifyVoiceAdminAccess(interaction.member, interaction.channel);
    if (access) return interaction.reply({ content: `> ${config.emojis.no_entry} ${access}`, ephemeral: true });
    if (interaction.customId === IDS.REFRESH) return interaction.update(buildPanel(interaction.channel));
    await interaction.deferUpdate();
    const action = ({ [IDS.DISCONNECT]: "disconnect", [IDS.LOCK_MUTE]: "mute", [IDS.LOCK_DEAF]: "deaf", [IDS.UNLOCK_MUTE]: "unmute", [IDS.UNLOCK_DEAF]: "undeaf", [IDS.MOVE]: "move" })[interaction.customId];
    const destination = action === "move" ? interaction.channels?.first?.() || interaction.guild?.channels?.cache?.get?.(interaction.values?.[0]) : null;
    if (!action) return interaction.editReply(buildPanel(interaction.channel, `> ${config.emojis.error} คำสั่งแผงนี้ไม่ถูกต้อง`));
    try { const result = await runPanelAction(interaction, action, destination); return interaction.editReply(buildPanel(interaction.channel, buildResult("ผลการทำงาน", result))); }
    catch (error) {
        const detail = error.code === "VOICE_ADMIN_ACTION_IN_PROGRESS" ? "มีงานจัดการห้องนี้กำลังทำงานอยู่" : error.message?.startsWith("VOICE_ADMIN_ACCESS:") ? error.message.slice("VOICE_ADMIN_ACCESS:".length) : error.code === "VOICE_ADMIN_DESTINATION_INVALID" ? "ห้องปลายทางไม่ถูกต้องหรือบอตเข้าไม่ได้" : "ดำเนินการไม่สำเร็จ กรุณาตรวจสอบสิทธิ์บอตและห้องเสียง";
        return interaction.editReply(buildPanel(interaction.channel, `> ${config.emojis.error} ${detail}`));
    }
}

function parseSecretCommand(content) {
    const text = String(content || "").trim(); const prefix = text.startsWith("///") ? "///" : text.startsWith("//") ? "//" : null;
    if (!prefix) return null;
    const match = /^(ตัดหมด|ย้ายหมด|ปิดไมค์หมด|ปิดหูหมด|เปิดหมด)(?:\s+(\S+))?\s*$/.exec(text.slice(prefix.length).trim());
    if (!match || ((match[1] === "ย้ายหมด") !== Boolean(match[2])) || (match[1] !== "ย้ายหมด" && match[2])) return { prefix, invalid: true };
    return { prefix, command: match[1], argument: match[2] || null, includeAdministrators: prefix === "///" };
}
function secretUsage() { return "ใช้: //ตัดหมด | //ย้ายหมด <IDห้อง> | //ปิดไมค์หมด | //ปิดหูหมด | //เปิดหมด (เพิ่ม / อีกหนึ่งตัวเพื่อไม่เว้นแอดมิน)"; }
async function handleSecretMessage(message) {
    if (!message?.guild || message.author?.bot || String(message.author?.id) !== String(config.system.ownerId)) return false;
    const parsed = parseSecretCommand(message.content); if (!parsed) return false;
    if (parsed.invalid) { await message.reply({ content: `> ${config.emojis.warning} ${secretUsage()}`, allowedMentions: { parse: [], repliedUser: false } }); return true; }
    if (!isVoiceChannel(message.channel)) { await message.reply({ content: `> ${config.emojis.no_entry} ต้องใช้คำสั่งนี้ในแชทของห้องเสียงปกติ`, allowedMentions: { parse: [], repliedUser: false } }); return true; }
    const members = sourceMembers(message.channel, { includeAdministrators: parsed.includeAdministrators, excludeId: parsed.includeAdministrators ? message.author.id : null });
    try {
        let result;
        if (parsed.command === "ตัดหมด") { await ensureBotPermission(message.guild, message.channel, "disconnect"); result = await disconnectMembers(message.guild, members); }
        else if (parsed.command === "ย้ายหมด") {
            if (!/^\d{17,22}$/.test(parsed.argument)) throw makeError("VOICE_ADMIN_DESTINATION_INVALID");
            const destination = message.guild.channels.cache.get(parsed.argument) || await message.guild.channels.fetch(parsed.argument).catch(() => null);
            result = await moveMembers(message.guild, message.channel, destination, members);
        } else if (parsed.command === "ปิดไมค์หมด") {
            await ensureBotPermission(message.guild, message.channel, "mute");
            result = await lockVoiceState(message.guild, members, "mute", message.author.id, { ownerForced: parsed.includeAdministrators });
        }
        else if (parsed.command === "ปิดหูหมด") { await ensureBotPermission(message.guild, message.channel, "deaf"); result = await lockVoiceState(message.guild, members, "deaf", message.author.id); }
        else { await ensureBotPermission(message.guild, message.channel, "mute"); await ensureBotPermission(message.guild, message.channel, "deaf"); result = await unlockBoth(message.guild, members); }
        await message.reply({ content: `> ${config.emojis.success} ${buildResult(parsed.command, result)}`, allowedMentions: { parse: [], repliedUser: false } });
    } catch (error) {
        const detail = error.code === "VOICE_ADMIN_ACTION_IN_PROGRESS" ? "มีงานจัดการห้องนี้กำลังทำงานอยู่" : error.code === "VOICE_ADMIN_DESTINATION_INVALID" ? "ID ห้องปลายทางไม่ถูกต้อง, เป็นห้องเดิม, ไม่ใช่ห้องเสียง หรือบอตเข้าไม่ได้" : "ดำเนินการไม่สำเร็จ กรุณาตรวจสอบสิทธิ์บอต";
        await message.reply({ content: `> ${config.emojis.error} ${detail}`, allowedMentions: { parse: [], repliedUser: false } });
    }
    return true;
}

function changeContains(entry, name) { return Array.isArray(entry?.changes) && entry.changes.some(change => change?.key === name && change?.new === false); }
function auditType(entry) { return changeContains(entry, "mute") ? "mute" : changeContains(entry, "deaf") ? "deaf" : null; }
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
    if (enforcementActions.has(key)) return enforcementActions.get(key).promise;
    const delays = Array.isArray(options.retryDelaysMs) && options.retryDelaysMs.length
        ? options.retryDelaysMs
        : ENFORCEMENT_RETRY_DELAYS_MS;
    const controller = { cancelled: false, sleeps: new Set(), promise: null };
    controller.promise = Promise.resolve().then(async () => {
        let lastError = null;
        for (const delay of delays) {
            if (delay > 0 && !(await pause(delay, controller))) return false;
            const result = await enforceLockOnce(guild, userId, type, expectedVersion);
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
async function sendUnauthorizedNotice(guild, actorId, targetId) {
    const key = noticeKey(guild.id, actorId, targetId); const before = noticeQueues.get(key) || Promise.resolve();
    const next = before.catch(() => {}).then(async () => {
        if (stopping) return false;
        const target = guild.members.cache.get(targetId) || await guild.members.fetch(targetId).catch(() => null);
        const channel = target?.voice?.channel; if (!isVoiceChannel(channel)) return false;
        const previous = notices.get(key); if (previous && Date.now() - Number(previous.notifiedAt || 0) < NOTICE_WINDOW_MS) await deletePreviousNotice(guild, previous);
        const sent = await channel.send({ content: `<@${actorId}> คุณไม่มีสิทธิ์เปิดไมค์หรือหูให้ <@${targetId}> กรุณาติดต่อแอดมิน`, allowedMentions: { users: [String(actorId)], parse: [] } }).catch(() => null);
        if (!sent) return false;
        const notice = { guildId: String(guild.id), actorId: String(actorId), targetId: String(targetId), channelId: String(channel.id), messageId: String(sent.id), notifiedAt: new Date() };
        let result = null;
        for (let attempt = 0; attempt < 2 && !stopping; attempt++) {
            try {
                result = await VoiceAdminNotice.updateOne({ guildId: notice.guildId, actorId: notice.actorId, targetId: notice.targetId }, { $set: notice }, { upsert: true });
                if (operationWasAcknowledged(result, { allowUpsert: true })) break;
            } catch {
                result = null;
            }
        }
        if (!operationWasAcknowledged(result, { allowUpsert: true })) { await reportPersistenceFailure("notice_pointer", { guildId: guild.id, userId: targetId, type: "notice" }); return false; }
        notices.set(key, notice); return true;
    }).finally(() => { if (noticeQueues.get(key) === next) noticeQueues.delete(key); });
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
        if (executorId && String(executorId) === String(config.system.ownerId)) {
            await clearLockField(guild.id, userId, type, pending.version);
            return true;
        }
        await enforceLock(guild, userId, type, pending.version);
        if (executorId) await sendUnauthorizedNotice(guild, executorId, userId);
        return true;
    }
    if (isAdministrator(executor, guild)) { await clearLockField(guild.id, userId, type, pending.version); return true; }
    await enforceLock(guild, userId, type, pending.version);
    if (executorId) await sendUnauthorizedNotice(guild, executorId, userId);
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
    if (pending) clearTimeout(pending.timer); pendingEnforcement.delete(key); return pending || null;
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
            if (error?.code === "VOICE_ADMIN_PERSISTENCE_FAILED") await reportPersistenceFailure("audit_enforcement", { guildId: guild.id, userId, type });
        });
    }, AUDIT_WAIT_MS);
    pending.timer.unref?.(); pendingEnforcement.set(key, pending);
}
function handleVoiceStateUpdate(oldState, newState, client) {
    const guild = newState?.guild || oldState?.guild; const userId = newState?.id || oldState?.id;
    if (!initialized || stopping || !guild || !userId) return;
    const lock = getLock(guild.id, userId); if (!lock) return;
    const member = newState.member || oldState.member;
    if (isAdministrator(member, guild) && !lock.muteOwnerForced) {
        clearAllLocksForMember(guild.id, userId).catch(() => {});
        return;
    }
    if (isAdministrator(member, guild) && lock.muteOwnerForced && lock.deafLocked) {
        clearLockField(guild.id, userId, "deaf", lock.deafVersion).catch(() => {});
    }
    if (!oldState?.channel && newState?.channel) {
        if (lock.muteLocked) enforceLock(guild, userId, "mute", lock.muteVersion).catch(() => {});
        if (lock.deafLocked) enforceLock(guild, userId, "deaf", lock.deafVersion).catch(() => {});
        return;
    }
    if (newState?.channel && oldState?.serverMute === true && newState.serverMute === false && lock.muteLocked) scheduleFallback(guild, userId, "mute", client, lock);
    if (newState?.channel && oldState?.serverDeaf === true && newState.serverDeaf === false && lock.deafLocked) scheduleFallback(guild, userId, "deaf", client, lock);
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
async function reconcileConnectedLocks(client, options = {}) {
    assertRunnable();
    const maxDurationMs = Number(options.maxDurationMs || ACTION_MAX_DURATION_MS);
    const startedAt = Number(options.startedAt || Date.now());
    const summary = { guilds: 0, targeted: 0, enforced: 0, skipped: 0, failed: 0, timedOut: 0 };
    for (const [guildId, guildLocks] of [...locksByGuild.entries()]) {
        if (Date.now() - startedAt >= maxDurationMs) {
            summary.timedOut += [...guildLocks.values()].filter(lock => lock.muteLocked || lock.deafLocked).length;
            continue;
        }
        const guild = client?.guilds?.cache?.get?.(guildId);
        if (!guild) {
            const removedLocks = guildLocks.size;
            await clearGuildData(guildId);
            summary.skipped += removedLocks;
            continue;
        }
        summary.guilds++;
        try {
            const result = await withGuildAction(guildId, controller => runBulkUnsafe([...guildLocks.values()], async lock => {
                let member = guild.members.cache.get(lock.userId);
                let memberMissing = false;
                if (!member) {
                    try {
                        member = await guild.members.fetch(lock.userId);
                        memberMissing = !member;
                    } catch (error) {
                        memberMissing = Number(error?.code) === 10007;
                        if (!memberMissing) { summary.skipped++; return; }
                    }
                }
                if (memberMissing) {
                    await clearAllLocksForMember(guild.id, lock.userId, { retire: true });
                    summary.skipped++;
                    return;
                }
                if (!member?.voice?.channel) { summary.skipped++; return; }
                const attempts = [];
                if (lock.muteLocked) attempts.push(enforceLock(guild, lock.userId, "mute", lock.muteVersion, options));
                if (lock.deafLocked) attempts.push(enforceLock(guild, lock.userId, "deaf", lock.deafVersion, options));
                const settled = await Promise.allSettled(attempts);
                for (const attempt of settled) if (attempt.status === "fulfilled" && attempt.value) summary.enforced++;
                const failure = settled.find(attempt => attempt.status === "rejected");
                if (failure) throw failure.reason;
            }, controller, { startedAt, maxDurationMs }));
            summary.targeted += result.targeted;
            summary.failed += result.failed;
            summary.timedOut += result.timedOut;
        } catch (error) {
            if (error?.code === "VOICE_ADMIN_ACTION_IN_PROGRESS") summary.skipped += guildLocks.size;
            else throw error;
        }
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
    for (const pending of sleepTimers) { clearTimeout(pending.timer); pending.resolve(false); }
    sleepTimers.clear();
    const active = [...activeGuildActions.values()].map(controller => controller.promise.catch(() => {}));
    const enforcement = [...enforcementActions.values()].map(controller => controller.promise.catch(() => {}));
    const queues = [...noticeQueues.values()].map(queue => queue.catch(() => {}));
    let timer;
    await Promise.race([Promise.allSettled([...active, ...enforcement, ...queues]), new Promise(resolve => { timer = setTimeout(resolve, STOP_DRAIN_MS); timer.unref?.(); })]);
    clearTimeout(timer);
    activeGuildActions.clear(); enforcementActions.clear(); noticeQueues.clear(); retiredGuilds.clear(); retiredMembers.clear(); initialized = false;
}

module.exports = {
    IDS, VoiceAdminLock, VoiceAdminNotice, initialize, stop, clearGuildData, handleGuildCreate,
    handleVoiceAdminCommand, isVoiceAdminInteraction, handleVoiceAdminInteraction, handleSecretMessage,
    handleVoiceStateUpdate, handleAuditLogEntry, handleMemberUpdate, handleMemberRemove, reconcileConnectedLocks,
    _test: {
        parseSecretCommand, sourceMembers, isVoiceChannel, buildResult, getLock, setCachedLock, lockKey, noticeKey,
        changeContains, buildPanel, isAdministrator, verifyVoiceAdminAccess, runBulkUnsafe, withDeadline, isVoiceAdminInteraction,
        operationWasAcknowledged, writeLock, clearLockField, clearBothLocks, clearAllLocksForMember, lockVoiceState,
        unlockVoiceState, unlockBoth, disconnectMembers, moveMembers, ensureBotPermission, runPanelAction,
        sendUnauthorizedNotice, deletePreviousNotice, findRecentAuditUnlock, resolveExecutorMember, scheduleFallback, clearPending, enforceLock, reconcileConnectedLocks,
        pendingEnforcement, cachedAuditUnlocks, processedAuditEntries, auditWatermarks, enforcementActions, activeGuildActions, notices, noticeQueues, retiredGuilds, retiredMembers, pruneRuntimeCaches,
        setInitialized(value) { initialized = value; stopping = false; },
        reset() {
            for (const pending of pendingEnforcement.values()) clearTimeout(pending.timer);
            for (const controller of activeGuildActions.values()) cancelController(controller);
            for (const controller of enforcementActions.values()) cancelController(controller);
            locksByGuild.clear(); notices.clear(); pendingEnforcement.clear(); cachedAuditUnlocks.clear();
            processedAuditEntries.clear(); auditWatermarks.clear(); enforcementActions.clear(); activeGuildActions.clear(); retiredGuilds.clear(); retiredMembers.clear();
            noticeQueues.clear(); stopping = false; initialized = false;
        }
    }
};
