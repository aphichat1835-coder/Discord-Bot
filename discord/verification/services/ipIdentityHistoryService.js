"use strict";

const crypto = require("node:crypto");
const IpIdentityLink = require("../models/IpIdentityLink");
const UserHistory = require("../models/IpIdentityUserHistory");
const DeviceHistory = require("../models/IpIdentityDeviceHistory");
const RoleHistory = require("../models/IpIdentityRoleHistory");
const VerifyLog = require("../models/VerifyLog");

const HISTORY_MIGRATION_VERSION = 1;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 500;

function resultCounter(result) {
    if (result === "success") return { successCount: 1 };
    if (result === "blocked") return { blockedCount: 1 };
    return { failedCount: 1 };
}

function userFields({ profile, device, memberInfo, roleId, result, riskSummary, ipInfo, now }) {
    return {
        username: profile.username || null,
        globalName: profile.global_name ?? profile.globalName ?? null,
        displayTag: profile.displayTag || null,
        avatarUrl: profile.avatarUrl || null,
        lastSeenAt: now,
        lastResult: result,
        lastRoleId: roleId || null,
        lastRoles: Array.isArray(memberInfo?.roles) ? memberInfo.roles.map(String) : [],
        lastJoinedAt: memberInfo?.joined_at || memberInfo?.joinedAt || null,
        lastMemberPending: memberInfo?.pending === true,
        lastCommunicationDisabledUntil:
            memberInfo?.communication_disabled_until || memberInfo?.communicationDisabledUntil || null,
        lastDeviceFingerprintHash: device?.fingerprintHash || null,
        lastRiskScore: Number(riskSummary?.score ?? ipInfo?.riskScore ?? 0),
        lastRiskFlags: Array.isArray(riskSummary?.flags) ? riskSummary.flags : [],
        updatedAt: now
    };
}

async function upsertUserHistory(input, models) {
    const { guildId, ipHash, profile, now, result } = input;
    return models.UserHistory.updateOne({ guildId, ipHash, userId: String(profile.id) }, {
        $set: userFields(input),
        $setOnInsert: {
            guildId,
            ipHash,
            userId: String(profile.id),
            firstSeenAt: now,
            createdAt: now
        },
        $inc: { verifyCount: 1, ...resultCounter(result) }
    }, { upsert: true });
}

async function upsertDeviceHistory(input, models) {
    const { guildId, ipHash, profile, device, now } = input;
    if (!device?.fingerprintHash) return null;
    const filter = {
        guildId,
        ipHash,
        fingerprintHash: String(device.fingerprintHash),
        userId: String(profile.id)
    };
    return models.DeviceHistory.updateOne(filter, {
        $set: {
            fingerprintVersion: Number(device.fingerprintVersion || 0) || 1,
            lastSeenAt: now,
            browser: device.browser || null,
            os: device.os || null,
            platform: device.platform || null,
            deviceType: device.deviceType || null,
            language: device.language || null,
            timezone: device.timezone || null,
            screenSize: device.screenSize || null,
            updatedAt: now
        },
        $setOnInsert: { ...filter, firstSeenAt: now, createdAt: now },
        $inc: { count: 1 }
    }, { upsert: true });
}

function roleEventId(input) {
    return `history:${crypto.createHash("sha256").update(JSON.stringify({
        guildId: input.guildId,
        ipHash: input.ipHash,
        userId: String(input.profile?.id || input.userId || ""),
        roleId: input.roleId || null,
        roles: Array.isArray(input.memberInfo?.roles) ? input.memberInfo.roles.map(String) :
            (Array.isArray(input.roles) ? input.roles.map(String) : []),
        result: input.result || null,
        at: Number(input.now || input.at || 0)
    })).digest("hex")}`;
}

async function createRoleHistory(input, models) {
    const { guildId, ipHash, profile, memberInfo, roleId, result, now } = input;
    return models.RoleHistory.create({
        eventId: roleEventId(input),
        guildId,
        ipHash,
        userId: String(profile.id),
        roleId: roleId || null,
        roles: Array.isArray(memberInfo?.roles) ? memberInfo.roles.map(String) : [],
        result,
        at: now,
        source: "oauth_verification",
        createdAt: now
    });
}

function defaultModels(options = {}) {
    return {
        IpIdentityLink: options.IpIdentityLinkModel || IpIdentityLink,
        UserHistory: options.UserHistoryModel || UserHistory,
        DeviceHistory: options.DeviceHistoryModel || DeviceHistory,
        RoleHistory: options.RoleHistoryModel || RoleHistory
    };
}

async function recordIpIdentityHistory(input, options = {}) {
    const models = defaultModels(options);
    const normalized = {
        ...input,
        ipHash: String(input.ipHash || input.ipInfo?.ipHash || ""),
        now: Number(input.now || Date.now())
    };
    if (!normalized.guildId || !normalized.ipHash || !normalized.profile?.id) return null;
    const [userWrite, deviceWrite] = await Promise.all([
        upsertUserHistory(normalized, models),
        upsertDeviceHistory(normalized, models)
    ]);
    await createRoleHistory(normalized, models);
    const uniqueUsers = await models.UserHistory.countDocuments({
        guildId: normalized.guildId,
        ipHash: normalized.ipHash
    });
    return {
        userCreated: Number(userWrite?.upsertedCount || 0) > 0,
        deviceCreated: Number(deviceWrite?.upsertedCount || 0) > 0,
        uniqueUsers
    };
}

function safePage(value) {
    return Math.max(0, Number.parseInt(value, 10) || 0);
}

function safeLimit(value) {
    return Math.min(MAX_PAGE_LIMIT, Math.max(1, Number.parseInt(value, 10) || DEFAULT_PAGE_LIMIT));
}

function historyModel(kind, models) {
    if (kind === "users") return models.UserHistory;
    if (kind === "devices") return models.DeviceHistory;
    if (kind === "roles") return models.RoleHistory;
    return null;
}

function strictSnowflake(value, code) {
    const text = String(value || "").trim();
    if (/^\d{17,22}$/.test(text)) return text;
    throw Object.assign(new Error(code), { code });
}

async function loadHistoryPage({ guildId, ipHash, kind, page = 0, limit = DEFAULT_PAGE_LIMIT }, options = {}) {
    const models = defaultModels(options);
    const Model = historyModel(kind, models);
    if (!Model) throw Object.assign(new Error("invalid history kind"), { code: "invalid_history_kind" });
    const normalizedPage = safePage(page);
    const normalizedLimit = safeLimit(limit);
    const filter = { guildId: String(guildId), ipHash: String(ipHash) };
    const [items, total] = await Promise.all([
        Model.find(filter)
            .sort(kind === "roles" ? { at: -1, _id: -1 } : { lastSeenAt: -1, _id: -1 })
            .skip(normalizedPage * normalizedLimit)
            .limit(normalizedLimit)
            .lean(),
        Model.countDocuments(filter)
    ]);
    return {
        kind,
        items,
        page: normalizedPage,
        limit: normalizedLimit,
        total,
        hasMore: (normalizedPage + 1) * normalizedLimit < total
    };
}

async function loadInitialHistory({ guildId, ipHash }, options = {}) {
    const pages = await Promise.all(["users", "devices", "roles"].map(kind =>
        loadHistoryPage({ guildId, ipHash, kind }, options)
    ));
    return Object.fromEntries(pages.map(page => [page.kind, page]));
}

async function findLinkForUser(guildId, userId, options = {}) {
    const models = defaultModels(options);
    const safeGuildId = strictSnowflake(guildId, "invalid_guild_id");
    const safeUserId = strictSnowflake(userId, "invalid_user_id");
    const userHistory = await models.UserHistory.findOne()
        .where("guildId").equals(safeGuildId)
        .where("userId").equals(safeUserId)
        .sort({ lastSeenAt: -1, _id: -1 })
        .lean();
    if (userHistory?.ipHash) {
        const link = await models.IpIdentityLink.findOne()
            .where("guildId").equals(safeGuildId)
            .where("ipHash").equals(String(userHistory.ipHash))
            .where("deletedAt").exists(false)
            .lean();
        if (link) return link;
    }
    return models.IpIdentityLink.findOne()
        .where("guildId").equals(safeGuildId)
        .where("users.userId").equals(safeUserId)
        .where("deletedAt").exists(false)
        .sort({ lastSeenAt: -1, updatedAt: -1, _id: -1 })
        .lean();
}

function legacyEventId(link, role) {
    return roleEventId({
        guildId: link.guildId,
        ipHash: link.ipHash,
        userId: role.userId,
        roleId: role.roleId,
        roles: role.roles,
        result: role.result,
        at: role.at
    });
}

async function migrateLegacyLink(link, models, now) {
    for (const user of link.users || []) {
        if (!user?.userId) continue;
        await models.UserHistory.updateOne({
            guildId: link.guildId,
            ipHash: link.ipHash,
            userId: String(user.userId)
        }, { $setOnInsert: { ...user, guildId: link.guildId, ipHash: link.ipHash, createdAt: now, updatedAt: now } }, { upsert: true });
    }
    for (const device of link.deviceFingerprints || []) {
        if (!device?.fingerprintHash || !device?.userId) continue;
        await models.DeviceHistory.updateOne({
            guildId: link.guildId,
            ipHash: link.ipHash,
            fingerprintHash: String(device.fingerprintHash),
            userId: String(device.userId)
        }, { $setOnInsert: { ...device, guildId: link.guildId, ipHash: link.ipHash, createdAt: now, updatedAt: now } }, { upsert: true });
    }
    for (const role of link.roleSnapshots || []) {
        if (!role?.userId) continue;
        await models.RoleHistory.updateOne({ eventId: legacyEventId(link, role) }, {
            $setOnInsert: {
                ...role,
                eventId: legacyEventId(link, role),
                guildId: link.guildId,
                ipHash: link.ipHash,
                source: "legacy_ip_identity_link",
                createdAt: now
            }
        }, { upsert: true });
    }
}

function recoveredProfile(log, identity) {
    return {
        id: String(log.userId || identity.userId || ""),
        username: identity.username || null,
        globalName: identity.globalName || null,
        displayTag: identity.displayTag || null,
        avatarUrl: identity.avatarUrl || null
    };
}

function recoveredMember(member) {
    return {
        roles: Array.isArray(member.roles) ? member.roles : [],
        joinedAt: member.joinedAt || null,
        pending: member.pending === true,
        communicationDisabledUntil: member.communicationDisabledUntil || null
    };
}

function recoveredLogInput(log) {
    const identity = log.discordSnapshot || {};
    const member = log.memberSnapshot || {};
    return {
        guildId: String(log.guildId || ""),
        ipHash: String(log.ipInfo?.ipHash || ""),
        profile: recoveredProfile(log, identity),
        ipInfo: log.ipInfo || {},
        device: log.device || null,
        memberInfo: recoveredMember(member),
        roleId: log.roleId || null,
        result: log.result || "failed",
        riskSummary: { score: log.riskScore || 0, flags: log.riskFlags || [] },
        now: Number(log.verifiedAt || log.createdAt || Date.now())
    };
}

async function backfillVerifyLog(log, models, now) {
    const input = recoveredLogInput(log);
    if (!input.guildId || !input.ipHash || !input.profile.id) return false;
    await models.IpIdentityLink.updateOne({ guildId: input.guildId, ipHash: input.ipHash }, {
        $setOnInsert: {
            guildId: input.guildId,
            ipHash: input.ipHash,
            encryptedRawIp: input.ipInfo.encryptedRawIp || null,
            firstSeenAt: input.now,
            totalVerifications: 0,
            uniqueUsers: 0,
            users: [],
            deviceFingerprints: [],
            roleSnapshots: [],
            createdAt: now
        },
        $max: { lastSeenAt: input.now },
        $set: { updatedAt: now }
    }, { upsert: true });
    await models.UserHistory.updateOne({
        guildId: input.guildId,
        ipHash: input.ipHash,
        userId: input.profile.id
    }, { $setOnInsert: {
        ...userFields(input),
        guildId: input.guildId,
        ipHash: input.ipHash,
        userId: input.profile.id,
        firstSeenAt: input.now,
        verifyCount: 1,
        ...resultCounter(input.result),
        createdAt: now
    } }, { upsert: true });
    if (input.device?.fingerprintHash) {
        const filter = {
            guildId: input.guildId,
            ipHash: input.ipHash,
            fingerprintHash: String(input.device.fingerprintHash),
            userId: input.profile.id
        };
        await models.DeviceHistory.updateOne(filter, { $setOnInsert: {
            ...filter,
            fingerprintVersion: Number(input.device.fingerprintVersion || 0) || 1,
            firstSeenAt: input.now,
            lastSeenAt: input.now,
            count: 1,
            browser: input.device.browser || null,
            os: input.device.os || null,
            platform: input.device.platform || null,
            deviceType: input.device.deviceType || null,
            language: input.device.language || null,
            timezone: input.device.timezone || null,
            screenSize: input.device.screenSize || null,
            createdAt: now,
            updatedAt: now
        } }, { upsert: true });
    }
    await models.RoleHistory.updateOne({ eventId: roleEventId(input) }, {
        $setOnInsert: {
            eventId: roleEventId(input),
            guildId: input.guildId,
            ipHash: input.ipHash,
            userId: input.profile.id,
            roleId: input.roleId,
            roles: input.memberInfo.roles,
            result: input.result,
            at: input.now,
            source: "verify_log_backfill",
            createdAt: now
        }
    }, { upsert: true });
    return true;
}

async function migrateVerifyLogHistory(options = {}) {
    const models = defaultModels(options);
    const VerifyLogModel = options.VerifyLogModel || VerifyLog;
    const limit = Math.min(1000, Math.max(1, Number(options.limit || 200)));
    const now = Number(options.now || Date.now());
    const logs = await VerifyLogModel.find({
        "ipInfo.ipHash": { $exists: true, $ne: "" },
        ipHistoryMigrationVersion: { $ne: HISTORY_MIGRATION_VERSION }
    }).sort({ _id: 1 }).limit(limit).lean();
    const touched = new Map();
    let migrated = 0;
    let skipped = 0;
    for (const log of logs) {
        if (await backfillVerifyLog(log, models, now)) {
            const key = `${log.guildId}\u0000${log.ipInfo.ipHash}`;
            touched.set(key, { guildId: log.guildId, ipHash: log.ipInfo.ipHash });
        } else {
            skipped++;
        }
        await VerifyLogModel.updateOne({ _id: log._id }, {
            $set: { ipHistoryMigrationVersion: HISTORY_MIGRATION_VERSION, ipHistoryMigratedAt: now }
        });
        migrated++;
    }
    for (const item of touched.values()) {
        const uniqueUsers = await models.UserHistory.countDocuments(item);
        await models.IpIdentityLink.updateOne(item, { $set: { uniqueUsers, updatedAt: now } });
    }
    return {
        scanned: logs.length,
        migrated,
        skipped,
        remaining: logs.length >= limit,
        version: HISTORY_MIGRATION_VERSION
    };
}

async function ensureLegacyLinkMigrated(link, options = {}) {
    if (!link || Number(link.historyMigrationVersion || 0) === HISTORY_MIGRATION_VERSION) {
        return { migrated: false, version: HISTORY_MIGRATION_VERSION };
    }
    const models = defaultModels(options);
    const now = Number(options.now || Date.now());
    const source = typeof link.toObject === "function" ? link.toObject() : link;
    await migrateLegacyLink(source, models, now);
    if (link._id && link.isNew !== true) {
        await models.IpIdentityLink.updateOne({ _id: link._id }, {
            $set: { historyMigrationVersion: HISTORY_MIGRATION_VERSION, historyMigratedAt: now }
        });
    }
    link.historyMigrationVersion = HISTORY_MIGRATION_VERSION;
    link.historyMigratedAt = now;
    return { migrated: true, version: HISTORY_MIGRATION_VERSION };
}

async function migrateLegacyHistory(options = {}) {
    const models = defaultModels(options);
    const limit = Math.min(500, Math.max(1, Number(options.limit || 100)));
    const now = Number(options.now || Date.now());
    const links = await models.IpIdentityLink.find({
        historyMigrationVersion: { $ne: HISTORY_MIGRATION_VERSION }
    }).sort({ _id: 1 }).limit(limit).lean();
    let migrated = 0;
    for (const link of links) {
        await ensureLegacyLinkMigrated(link, { ...options,
            IpIdentityLinkModel: models.IpIdentityLink,
            UserHistoryModel: models.UserHistory,
            DeviceHistoryModel: models.DeviceHistory,
            RoleHistoryModel: models.RoleHistory,
            now
        });
        migrated++;
    }
    return { scanned: links.length, migrated, remaining: links.length >= limit, version: HISTORY_MIGRATION_VERSION };
}

module.exports = {
    recordIpIdentityHistory,
    loadHistoryPage,
    loadInitialHistory,
    findLinkForUser,
    migrateLegacyHistory,
    migrateVerifyLogHistory,
    ensureLegacyLinkMigrated,
    _test: {
        resultCounter,
        safePage,
        safeLimit,
        strictSnowflake,
        roleEventId,
        legacyEventId,
        recoveredLogInput,
        backfillVerifyLog,
        migrateLegacyLink
    }
};
