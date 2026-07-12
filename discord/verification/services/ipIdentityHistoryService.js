"use strict";

const crypto = require("node:crypto");
const IpIdentityLink = require("../models/IpIdentityLink");
const UserHistory = require("../models/IpIdentityUserHistory");
const DeviceHistory = require("../models/IpIdentityDeviceHistory");
const RoleHistory = require("../models/IpIdentityRoleHistory");

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

async function createRoleHistory(input, models) {
    const { guildId, ipHash, profile, memberInfo, roleId, result, now } = input;
    return models.RoleHistory.create({
        eventId: crypto.randomUUID(),
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
    const userHistory = await models.UserHistory.findOne({ guildId, userId })
        .sort({ lastSeenAt: -1, _id: -1 })
        .lean();
    if (userHistory?.ipHash) {
        const link = await models.IpIdentityLink.findOne({
            guildId,
            ipHash: userHistory.ipHash,
            deletedAt: { $exists: false }
        }).lean();
        if (link) return link;
    }
    return models.IpIdentityLink.findOne({
        guildId,
        "users.userId": userId,
        deletedAt: { $exists: false }
    }).sort({ lastSeenAt: -1, updatedAt: -1, _id: -1 }).lean();
}

function legacyEventId(link, role, index) {
    return `legacy:${crypto.createHash("sha256").update(JSON.stringify({
        guildId: link.guildId,
        ipHash: link.ipHash,
        role,
        index
    })).digest("hex")}`;
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
    for (const [index, role] of (link.roleSnapshots || []).entries()) {
        if (!role?.userId) continue;
        await models.RoleHistory.updateOne({ eventId: legacyEventId(link, role, index) }, {
            $setOnInsert: {
                ...role,
                eventId: legacyEventId(link, role, index),
                guildId: link.guildId,
                ipHash: link.ipHash,
                source: "legacy_ip_identity_link",
                createdAt: now
            }
        }, { upsert: true });
    }
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
    ensureLegacyLinkMigrated,
    _test: { resultCounter, safePage, safeLimit, legacyEventId, migrateLegacyLink }
};
