"use strict";

const crypto = require("node:crypto");
const discord = require("../utils/discordAPI");
const { processIP, extractDevice } = require("../utils/ipUtils");
const {
    normalizeVerificationConfig,
    normalizeSecurityRules
} = require("../utils/verifyMode");
const discordDataCollector = require("./collectors/discordDataCollector");
const {
    getAccountCreatedAt,
    getAccountAgeDays,
    getAvatarUrl,
    getBannerUrl,
    displayTag
} = discordDataCollector;
const { evaluateSecurity } = require("./securityEvaluator");
const { evaluateCriticalPersistence, coordinatePersistenceFailure } = require("./verificationPersistence");
const { verificationWebhookManager } = require("./webhook/verificationWebhookManager");
const oauthTokenManager = require("../../tokens/oauthTokenManager");
const snapshotBudget = require("./snapshotBudget");
const ipIdentityHistory = require("./ipIdentityHistoryService");
const { withSnapshotMutationLock } = require("./snapshotMutationLock");

const GuildConfig = require("../models/GuildConfig");
const OAuthUser = require("../models/OAuthUser");
const VerifyLog = require("../models/VerifyLog");
const IpIdentityLink = require("../models/IpIdentityLink");
const VerificationRecovery = require("../models/VerificationRecovery");

function safeString(value, maxLen = 0) {
    if (value === undefined || value === null) return "";
    const cleaned = String(value).replace(/[\u0000-\u001F\u007F]/g, "");
    const max = Number(maxLen || 0);
    return Number.isFinite(max) && max > 0 ? cleaned.slice(0, max) : cleaned;
}

function safeNullableString(value, maxLen = 0) {
    const v = safeString(value, maxLen);
    return v || null;
}

function safeNumberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function safeSnowflakeStrict(value, label = "discord_id") {
    const text = String(value || "").trim();
    if (/^\d{17,22}$/.test(text)) return text;
    const err = new Error(`invalid ${label}`);
    err.code = "invalid_snowflake";
    throw err;
}

function safeIpHashStrict(value) {
    const text = String(value || "").trim().toLowerCase();
    if (/^[a-f0-9]{64}$/.test(text)) return text;
    const err = new Error("invalid ip_hash");
    err.code = "invalid_ip_hash";
    throw err;
}

function objectOrEmpty(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sanitizeSideEffectError(err) {
    if (!err) return null;
    return {
        message: err.message || String(err),
        code: err.code || null
    };
}

async function safeSideEffect(label, fn, fallback = null) {
    try {
        return await fn();
    } catch (err) {
        console.error(`[VERIFY:${label}] failed:`, JSON.stringify(sanitizeSideEffectError(err)));
        return fallback;
    }
}

function getGuildName(guildConfig, fallback = "Discord Server") {
    return guildConfig?.guildName || guildConfig?.name || fallback;
}

function getConfiguredRoleId(guildConfig, fallbackRoleId = null) {
    return guildConfig?.verification?.roleId || fallbackRoleId || null;
}

function getConfiguredRoleName(guildConfig, fallback = "Member") {
    return guildConfig?.verification?.roleName || fallback;
}

function getLatestPanelRevision(guildConfig) {
    return Number(guildConfig?.verification?.panelRevision || 1);
}

function getStatePanelRevision(stateObj = {}) {
    return Number(stateObj?.panelRevision || 1);
}

function isPanelRevisionValid(guildConfig, stateObj = {}) {
    if (!guildConfig || !guildConfig.verification) return { ok: true };
    const latest = getLatestPanelRevision(guildConfig);
    const stateRev = getStatePanelRevision(stateObj);
    if (stateRev !== latest) {
        return { ok: false, stateRev, latest };
    }
    return { ok: true, stateRev, latest };
}

function fitVerifyLogBudget(doc, payload) {
    try {
        snapshotBudget.assertSnapshotBudget(doc, { label: "verify_log" });
        return { doc, degraded: false };
    } catch (budgetErr) {
        console.warn(`[VERIFY] VerifyLog size exceeded budget limit for user=${payload.userId}: ${budgetErr.message}. Storing minimal audit document with degraded status.`);
        return {
            doc: {
                guildId: payload.guildId,
                userId: payload.userId,
                roleId: payload.roleId,
                result: payload.result,
                reason: payload.reason,
                dataQuality: {
                    degraded: true,
                    budgetExceeded: true,
                    errorMessage: budgetErr.message
                },
                verifiedAt: payload.verifiedAt || Date.now()
            },
            degraded: true,
            errorMessage: budgetErr.message
        };
    }
}

async function saveVerifyLogSafe(payload) {
    return safeSideEffect("saveVerifyLog", async () => {
        let doc = {
            ...payload,
            ...(payload.trackingSnapshot ? {
                ipHistoryMigrationVersion: 1,
                ipHistoryMigratedAt: Date.now()
            } : {})
        };
        const fit = fitVerifyLogBudget(doc, payload);
        const created = await VerifyLog.create(fit.doc);
        if (created) {
            created.isBudgetDegraded = fit.degraded;
        }
        return created;
    }, null);
}

async function updateIpIdentityTrackingSafe({
    guildId,
    guildName,
    profile,
    ipInfo,
    device,
    roleId,
    result,
    findings
}) {
    return safeSideEffect("updateIpIdentityTracking", async () => {
        if (!guildId || !profile?.id || !ipInfo?.ipHash) return null;

        const nowMs = Date.now();
        const safeGuildId = safeSnowflakeStrict(guildId, "guild_id");
        const safeProfileId = safeSnowflakeStrict(profile.id, "discord_user_id");
        const safeIpHash = safeIpHashStrict(ipInfo.ipHash);

        const existing = await IpIdentityLink.findOne()
            .where("guildId").equals(safeGuildId)
            .where("ipHash").equals(safeIpHash);
        if (existing) await ipIdentityHistory.ensureLegacyLinkMigrated(existing, { now: nowMs });

        await ipIdentityHistory.recordIpIdentityHistory({
            guildId: safeGuildId,
            ipHash: safeIpHash,
            profile: {
                ...profile,
                id: safeProfileId,
                displayTag: displayTag(profile),
                avatarUrl: getAvatarUrl(profile)
            },
            ipInfo,
            device,
            memberInfo: null,
            roleId,
            result,
            findings,
            now: nowMs
        });

        const setFields = {
            guildName: guildName || existing?.guildName || safeGuildId,
            lastSeenAt: nowMs,
            lastResult: result,
            lastRoleId: roleId,
            lastFindings: Array.isArray(findings) ? findings : [],
            lastCountry: ipInfo.country,
            lastCountryCode: ipInfo.countryCode,
            lastRegion: ipInfo.region,
            lastCity: ipInfo.city,
            lastTimezone: ipInfo.timezone,
            lastIsp: ipInfo.isp,
            lastOrg: ipInfo.org,
            lastAs: ipInfo.as,
            lastAsname: ipInfo.asname,
            isVPN: !!ipInfo.isVPN,
            isProxy: !!ipInfo.isProxy,
            isTOR: !!ipInfo.isTOR,
            hosting: !!ipInfo.hosting,
            mobile: !!ipInfo.mobile,
            anycast: !!ipInfo.anycast,
            networkType: ipInfo.networkType || null
        };

        const updated = await IpIdentityLink.findOneAndUpdate(
            { guildId: safeGuildId, ipHash: safeIpHash },
            {
                $setOnInsert: {
                    firstSeenAt: nowMs,
                    createdAt: nowMs
                },
                $set: setFields,
                $inc: { totalVerifications: 1 }
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        return {
            ipHash: safeIpHash,
            firstSeenAt: updated?.firstSeenAt || nowMs,
            lastSeenAt: updated?.lastSeenAt || nowMs,
            totalVerifications: updated?.totalVerifications || 1,
            uniqueUsers: updated?.uniqueUsers || 1
        };
    }, null);
}

async function saveOAuthUserSafe({
    profile,
    tokenData,
    connections,
    guildSummary,
    guildId,
    roleId,
    result,
    findings,
    trackingSnapshot,
    attemptStartedAt = Date.now()
}) {
    return safeSideEffect("saveOAuthUser", async () => {
        const profileUserId = safeSnowflakeStrict(profile.id, "discord_user_id");
        return withSnapshotMutationLock(profileUserId, async () => {
            const nowMs = Date.now();
            const safeAttemptStartedAt = Math.max(0, Number(attemptStartedAt) || nowMs);

            let finalGuildSummary = guildSummary || null;
            if (finalGuildSummary?.status === "failed" && !finalGuildSummary.fetchedAt) {
                const existingDoc = await OAuthUser.findOne({ "discord.userId": profileUserId }).select("guildSummary").lean().catch(() => null);
                if (existingDoc?.guildSummary && existingDoc.guildSummary.status === "success") {
                    finalGuildSummary = {
                        ...finalGuildSummary,
                        totalCount: existingDoc.guildSummary.totalCount,
                        ownedCount: existingDoc.guildSummary.ownedCount,
                        totalGuilds: existingDoc.guildSummary.totalCount,
                        ownerGuildsCount: existingDoc.guildSummary.ownedCount,
                        fetchedAt: existingDoc.guildSummary.fetchedAt
                    };
                }
            }

            const updateSet = {
                discord: {
                    userId: profileUserId,
                    username: safeNullableString(profile.username, 80),
                    discriminator: safeNullableString(profile.discriminator, 8),
                    globalName: safeNullableString(profile.globalName || profile.global_name, 120),
                    displayTag: safeNullableString(displayTag(profile), 160),
                    avatarHash: safeNullableString(profile.avatar, 120),
                    avatarUrl: safeNullableString(getAvatarUrl(profile), 512),
                    bannerHash: safeNullableString(profile.banner, 120),
                    bannerUrl: safeNullableString(getBannerUrl(profile), 512),
                    accentColor: safeNumberOrNull(profile.accentColor || profile.accent_color),
                    email: safeNullableString(profile.email, 320),
                    emailVerified: profile.emailVerified === true,
                    locale: safeNullableString(profile.locale, 32),
                    mfaEnabled: profile.mfaEnabled === true,
                    premiumType: safeNumberOrNull(profile.premiumType),
                    flags: safeNumberOrNull(profile.flags) || 0,
                    publicFlags: safeNumberOrNull(profile.publicFlags) || 0,
                    badgeFlags: Array.isArray(profile.badgeFlags) ? profile.badgeFlags : [],
                    accountCreatedAt: profile.accountCreatedAt,
                    accountAgeDays: profile.accountAgeDays
                },
                connections: Array.isArray(connections) ? connections : [],
                guildSummary: finalGuildSummary,
                lastVerify: {
                    guildId,
                    roleId,
                    result,
                    attemptStartedAt: safeAttemptStartedAt,
                    verifiedAt: nowMs,
                    findings: Array.isArray(findings) ? findings : []
                },
                lastIpTracking: trackingSnapshot || null,
                updatedAt: nowMs
            };

            const commitResult = await oauthTokenManager.commitVerificationActivation({
                profileUserId,
                tokenData,
                updateSet,
                safeAttemptStartedAt,
                tokenField: "oauth",
                model: OAuthUser,
                now: nowMs
            });

            return {
                saved: true,
                activated: commitResult?.activated
            };
        });
    }, { saved: false, code: "save_oauth_user_failed_safely" });
}

async function loadExistingIpLinkContext({ ipInfo, guildId }) {
    if (!ipInfo?.ipHash || !guildId) {
        return { existingIpLink: null, updatedIpInfo: ipInfo, trackedUsers: [] };
    }
    const safeGuildId = safeSnowflakeStrict(guildId, "guild_id");
    const safeIpHash = safeIpHashStrict(ipInfo.ipHash);

    const existingIpLink = await IpIdentityLink.findOne()
        .where("guildId").equals(safeGuildId)
        .where("ipHash").equals(safeIpHash)
        .lean();

    const trackedUsers = await ipIdentityHistory.listTrackedUsersForLink(safeGuildId, safeIpHash);

    return {
        existingIpLink,
        updatedIpInfo: ipInfo,
        trackedUsers
    };
}

async function loadExistingDeviceContext({ device, guildId, currentUserId }) {
    if (!device?.fingerprintHash || !guildId) {
        return {
            uniqueUsers: currentUserId ? 1 : 0,
            userIds: currentUserId ? [String(currentUserId)] : []
        };
    }
    const safeGuildId = safeSnowflakeStrict(guildId, "guild_id");
    const targetHash = String(device.fingerprintHash);

    return safeSideEffect("loadDeviceIdentityLinks", async () => {
        const links = await IpIdentityLink.find({
            guildId: safeGuildId,
            "deviceFingerprints.fingerprintHash": targetHash,
            deletedAt: { $exists: false }
        })
            .select("users.userId users.lastDeviceFingerprintHash deviceFingerprints.fingerprintHash deviceFingerprints.userId")
            .sort({ updatedAt: -1, _id: -1 })
            .limit(50)
            .lean();

        const userIds = new Set();
        for (const link of links || []) {
            for (const df of link.deviceFingerprints || []) {
                if (df?.fingerprintHash === targetHash && df?.userId) {
                    userIds.add(String(df.userId));
                }
            }
            for (const u of link.users || []) {
                if (u?.lastDeviceFingerprintHash === targetHash && u?.userId) {
                    userIds.add(String(u.userId));
                }
            }
        }
        if (currentUserId) userIds.add(String(currentUserId));

        return {
            uniqueUsers: userIds.size,
            userIds: Array.from(userIds)
        };
    }, {
        uniqueUsers: currentUserId ? 1 : 0,
        userIds: currentUserId ? [String(currentUserId)] : []
    });
}

async function executeVerification({
    req,
    code,
    stateObj,
    redirectUri
}) {
    const oauthAttemptStartedAt = Date.now();
    const guildId = safeSnowflakeStrict(stateObj.guildId, "guild_id");
    const stateRoleId = stateObj.roleId ? safeSnowflakeStrict(stateObj.roleId, "role_id") : null;
    const expectedUserId = stateObj.expectedUserId ? safeSnowflakeStrict(stateObj.expectedUserId, "expected_user_id") : null;

    // --- Step 1: Preconditions (GuildConfig) ---
    const guildConfig = await GuildConfig.findOne()
        .where("guildId").equals(guildId);

    if (!guildConfig) {
        return {
            statusCode: 200,
            body: {
                success: false,
                error: "ไม่พบการตั้งค่าระบบยืนยันตัวตนของเซิร์ฟเวอร์นี้ กรุณาติดต่อผู้ดูแล",
                code: "guild_config_not_found"
            }
        };
    }

    const verificationConfig = normalizeVerificationConfig(guildConfig.verification || {});
    if (verificationConfig.enabled === false) {
        return {
            statusCode: 200,
            body: {
                success: false,
                error: "ระบบยืนยันตัวตนของเซิร์ฟเวอร์นี้ยังไม่เปิดใช้งานในขณะนี้",
                code: "verification_disabled"
            }
        };
    }

    const configuredRoleId = getConfiguredRoleId(guildConfig, stateRoleId);
    if (!configuredRoleId) {
        return {
            statusCode: 200,
            body: {
                success: false,
                error: "เซิร์ฟเวอร์ยังไม่ได้กำหนดยศสำหรับผู้ยืนยันตัวตน กรุณาแจ้งผู้ดูแล",
                code: "missing_configured_role"
            }
        };
    }

    const revisionCheck = isPanelRevisionValid(guildConfig, stateObj);
    if (!revisionCheck.ok) {
        return {
            statusCode: 200,
            body: {
                success: false,
                error: "ปุ่มยืนยันนี้ไม่ใช่รุ่นล่าสุด กรุณากลับไปกดปุ่มยืนยันใหม่ในห้อง Discord",
                code: "panel_revision_mismatch"
            }
        };
    }

    const roleName = getConfiguredRoleName(guildConfig);
    const guildName = getGuildName(guildConfig);

    // --- Step 2: Collect Discord Data via OAuth ---
    let discordData;
    try {
        let previousSummary = null;
        let previousConnections = null;
        if (expectedUserId) {
            const prevOAuth = await OAuthUser.findOne({ "discord.userId": expectedUserId }).select("guildSummary connections").lean().catch(() => null);
            if (prevOAuth?.guildSummary && prevOAuth.guildSummary.status === "success") {
                previousSummary = prevOAuth.guildSummary;
            }
            if (Array.isArray(prevOAuth?.connections) && prevOAuth.connections.length > 0) {
                previousConnections = prevOAuth.connections;
            }
        }
        discordData = await discordDataCollector.collectDiscordData({ code, redirectUri, previousSummary, previousConnections });
    } catch (discordErr) {
        if (discord.isOAuthInvalidGrantError(discordErr)) {
            return {
                statusCode: 200,
                body: {
                    success: false,
                    error: "ลิงก์ยืนยันตัวตนหมดอายุแล้ว กรุณากลับไปกดปุ่มยืนยันใน Discord ใหม่อีกครั้ง",
                    code: "oauth_code_expired"
                }
            };
        }
        console.error("[VERIFY] collectDiscordData failed:", discordErr.message);
        return {
            statusCode: 200,
            body: {
                success: false,
                error: "ไม่สามารถเชื่อมต่อกับ Discord เพื่อดึงข้อมูลได้ กรุณาลองใหม่อีกครั้ง",
                code: "discord_api_error"
            }
        };
    }

    const { tokenData, accessToken, profile, connections, guildSummary, fetchMetadata } = discordData;

    if (guildSummary?.status === "failed" && !guildSummary.fetchedAt && profile?.id) {
        const safePId = safeSnowflakeStrict(profile.id, "discord_user_id");
        const prevOAuth = await OAuthUser.findOne({ "discord.userId": safePId }).select("guildSummary").lean().catch(() => null);
        if (prevOAuth?.guildSummary && prevOAuth.guildSummary.status === "success") {
            guildSummary.totalCount = prevOAuth.guildSummary.totalCount;
            guildSummary.ownedCount = prevOAuth.guildSummary.ownedCount;
            guildSummary.totalGuilds = prevOAuth.guildSummary.totalCount;
            guildSummary.ownerGuildsCount = prevOAuth.guildSummary.ownedCount;
            guildSummary.fetchedAt = prevOAuth.guildSummary.fetchedAt;
        }
    }

    if (expectedUserId && String(profile.id) !== String(expectedUserId)) {
        return {
            statusCode: 200,
            body: {
                success: false,
                error: "บัญชี Discord ที่เข้าสู่ระบบไม่ตรงกับบัญชีที่กดปุ่มในห้องแชท กรุณาลองใหม่อีกครั้ง",
                code: "oauth_user_mismatch"
            }
        };
    }

    // --- Step 3: IP Intelligence & Device Extraction ---
    const ipInfo = await safeSideEffect("processIP", () => processIP(req), {
        encryptedRawIp: null,
        ipHash: null,
        isVPN: false,
        isProxy: false,
        isTOR: false,
        hosting: false
    });

    const device = await safeSideEffect("extractDevice", () => extractDevice(req), {
        userAgent: req.headers["user-agent"] || "",
        fingerprintHash: null
    });

    // --- Step 4: Security Evaluation ---
    const ipLinkContext = await loadExistingIpLinkContext({ ipInfo, guildId });
    const deviceContext = await loadExistingDeviceContext({
        device,
        guildId,
        currentUserId: profile?.id
    });
    const securityRules = normalizeSecurityRules(verificationConfig.securityRules || {});
    const policySnapshot = {
        enabled: verificationConfig.enabled !== false,
        minAccountAgeDays: verificationConfig.minAccountAgeDays || 0,
        requireEmail: Boolean(verificationConfig.requireEmail),
        requireEmailVerified: Boolean(verificationConfig.requireEmailVerified),
        requireConnections: Boolean(verificationConfig.requireConnections),
        securityRules
    };

    const securityEval = evaluateSecurity({
        profile,
        ipInfo,
        device,
        connections: discordData?.connections || [],
        existingIpLink: ipLinkContext.existingIpLink,
        securityRules,
        policySnapshot,
        trackedUsers: ipLinkContext.trackedUsers,
        deviceSummary: deviceContext
    });

    const allFindings = [...(securityEval.findings || [])];
    if (fetchMetadata?.isConnectionsFallback === true && !allFindings.includes("connections_fallback_used")) {
        allFindings.push("connections_fallback_used");
    }

    // --- Step 5: Handle Security Enforcement (If Blocked) ---
    if (securityEval.isBlocked) {
        if (securityEval.moderationAction && securityEval.moderationAction !== "allow" && securityEval.moderationAction !== "deny_role") {
            await safeSideEffect("moderateMember", () => discord.moderateVerificationMember(
                guildId,
                profile.id,
                securityEval.moderationAction,
                {
                    timeoutMinutes: securityEval.timeoutMinutes,
                    reason: `Verification security: ${securityEval.blockedReason}`
                }
            ));
        }

        const trackingSnapshot = await updateIpIdentityTrackingSafe({
            guildId,
            guildName,
            profile,
            ipInfo,
            device,
            roleId: configuredRoleId,
            result: "blocked",
            findings: allFindings
        });

        await saveOAuthUserSafe({
            profile,
            tokenData,
            connections,
            guildSummary,
            guildId,
            roleId: configuredRoleId,
            result: "blocked",
            findings: allFindings,
            trackingSnapshot,
            attemptStartedAt: oauthAttemptStartedAt
        });

        const verifyLog = await saveVerifyLogSafe({
            guildId,
            userId: profile.id,
            roleId: configuredRoleId,
            result: "blocked",
            reason: securityEval.blockedReason,
            findings: allFindings,
            oauthScope: tokenData.scope || "",
            stateMode: stateObj.mode || null,
            policySnapshot,
            discordSnapshot: {
                username: profile.username,
                globalName: profile.globalName,
                discriminator: profile.discriminator || "0",
                displayTag: displayTag(profile),
                avatarUrl: getAvatarUrl(profile),
                bannerUrl: getBannerUrl(profile),
                accountCreatedAt: profile.accountCreatedAt,
                accountAgeDays: profile.accountAgeDays,
                email: profile.email,
                emailVerified: profile.emailVerified,
                locale: profile.locale || null,
                mfaEnabled: profile.mfaEnabled === true,
                premiumType: profile.premiumType || 0,
                badgeFlags: profile.badgeFlags,
                connectionsCount: connections.length
            },
            connectionsSnapshot: connections.map(c => ({
                type: String(c.type || ""),
                verified: Boolean(c.verified)
            })),
            guildSummary,
            joinResult: null,
            roleAssignResult: null,
            trackingSnapshot,
            ipInfo,
            device,
            verifiedAt: Date.now()
        });

        return {
            statusCode: 200,
            body: {
                success: false,
                error: securityEval.userError || "ไม่ผ่านเงื่อนไขความปลอดภัยของเซิร์ฟเวอร์",
                code: securityEval.blockedReason || "security_policy_blocked",
                roleName
            }
        };
    }

    // --- Step 6: Check Member & Role Assignment ---
    let memberLookup = await safeSideEffect("getGuildMemberResult", () =>
        typeof discord.getGuildMemberResult === "function"
            ? discord.getGuildMemberResult(accessToken, guildId)
            : discord.getGuildMember(accessToken, guildId).then(m => ({ member: m, status: m ? 200 : null }))
    );
    let memberInfo = memberLookup?.member || null;
    let memberLookupStatus = memberLookup?.status || null;
    let memberLookupFailure = memberLookup?.failureReason || null;

    let joinResult = null;
    let roleAssignResult = null;
    let finalReason = "verified";
    let isLookupError = false;

    const isNotFound = memberLookupStatus === 404;
    const isLookupFailure = Boolean(memberLookupFailure) || (memberLookupStatus && memberLookupStatus !== 200 && memberLookupStatus !== 404);

    if (!memberInfo && !isNotFound && isLookupFailure) {
        // Membership lookup failed due to API / network failure (P1-A, P1-B)
        isLookupError = true;
        finalReason = "member_lookup_failed";
        roleAssignResult = { ok: false, error: "lookup_failed" };
    } else {
        const memberRoles = memberInfo?.roles || [];
        const alreadyHasRole = memberRoles.map(String).includes(String(configuredRoleId));

        if (alreadyHasRole) {
            finalReason = "already_verified_has_role";
            roleAssignResult = { ok: true, alreadyHadRole: true };
        } else if (!memberInfo) {
            joinResult = await safeSideEffect("addMemberToGuild", () =>
                discord.addMemberToGuild(guildId, profile.id, accessToken, [configuredRoleId]),
                { ok: false, error: "join_failed" }
            );

            if (!joinResult?.ok) {
                finalReason = "guild_join_failed";
                roleAssignResult = { ok: false, error: "join_failed" };
            } else {
                roleAssignResult = { ok: true, joinedWithRole: true };
            }
        } else {
            roleAssignResult = await safeSideEffect("addRoleToMember", () =>
                discord.addRoleToMember(guildId, profile.id, configuredRoleId),
                { ok: false, error: "role_assign_failed" }
            );

            if (!roleAssignResult?.ok) {
                finalReason = "role_assign_failed";
            }
        }
    }

    const isSuccess = roleAssignResult?.ok === true;
    const finalResult = isSuccess ? "success" : "failed";

    // --- Step 7: Persistence Updates (Always records all attempts for audit/forensics) ---
    const trackingSnapshot = await updateIpIdentityTrackingSafe({
        guildId,
        guildName,
        profile,
        ipInfo,
        device,
        roleId: configuredRoleId,
        result: finalResult,
        findings: allFindings
    });

    const oauthPersistence = await saveOAuthUserSafe({
        profile,
        tokenData,
        connections,
        guildSummary,
        guildId,
        roleId: configuredRoleId,
        result: finalResult,
        findings: allFindings,
        trackingSnapshot,
        attemptStartedAt: oauthAttemptStartedAt
    });

    const verifyLogSaved = await saveVerifyLogSafe({
        guildId,
        userId: profile.id,
        roleId: configuredRoleId,
        result: finalResult,
        reason: finalReason,
        findings: allFindings,
        oauthScope: tokenData.scope || "",
        stateMode: stateObj.mode || null,
        policySnapshot,
        discordSnapshot: {
            username: profile.username,
            globalName: profile.globalName,
            discriminator: profile.discriminator || "0",
            displayTag: displayTag(profile),
            avatarUrl: getAvatarUrl(profile),
            bannerUrl: getBannerUrl(profile),
            accountCreatedAt: profile.accountCreatedAt,
            accountAgeDays: profile.accountAgeDays,
            email: profile.email,
            emailVerified: profile.emailVerified,
            locale: profile.locale || null,
            mfaEnabled: profile.mfaEnabled === true,
            premiumType: profile.premiumType || 0,
            badgeFlags: profile.badgeFlags,
            connectionsCount: connections.length
        },
        connectionsSnapshot: connections.map(c => ({
            type: String(c.type || ""),
            verified: Boolean(c.verified)
        })),
        guildSummary,
        joinResult,
        roleAssignResult,
        trackingSnapshot,
        ipInfo,
        device,
        verifiedAt: Date.now()
    });

    // If role assignment or lookup failed, return user error immediately without dispatching webhook or DM
    if (!isSuccess) {
        // Record recovery if critical persistence failed on failed attempts as well (Section 3.1)
        const failedPersistenceResult = evaluateCriticalPersistence({
            oauthSaved: oauthPersistence?.saved === true,
            verifyLogSaved: Boolean(verifyLogSaved),
            verifyLogDegraded: verifyLogSaved?.isBudgetDegraded === true,
            trackingRequired: Boolean(ipInfo?.ipHash),
            trackingSaved: Boolean(trackingSnapshot)
        });
        if (!failedPersistenceResult.ok) {
            console.error("[VERIFY] Critical persistence failure on failed attempt. Recording recovery...");
            await coordinatePersistenceFailure({
                requestId: req?.id || `req_${Date.now()}`,
                guildId,
                userId: profile.id,
                roleId: configuredRoleId,
                result: "failed",
                roleAssignResult,
                roleApplied: false,
                persistence: failedPersistenceResult.persistence,
                removeRole: () => Promise.resolve({ ok: true }),
                saveRecovery: async recoveryRecord => {
                    const res = await VerificationRecovery.create(recoveryRecord);
                    return Boolean(res);
                }
            }).catch(err => {
                console.error("[VERIFY] Failed to record recovery for failed attempt persistence failure:", err);
            });
        }

        if (isLookupError) {
            return {
                statusCode: 200,
                body: {
                    success: false,
                    error: "ระบบไม่สามารถตรวจสอบสถานะสมาชิกใน Discord ได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง",
                    code: "member_lookup_failed",
                    roleName
                }
            };
        }
        if (finalReason === "guild_join_failed") {
            return {
                statusCode: 200,
                body: {
                    success: false,
                    error: "ระบบไม่สามารถพาคุณเข้าเซิร์ฟเวอร์ได้ กรุณากดเข้าร่วมเซิร์ฟเวอร์ใน Discord ด้วยตนเองก่อน แล้วกดปุ่มยืนยันใหม่อีกครั้ง",
                    code: "guild_join_failed",
                    roleName
                }
            };
        }
        return {
            statusCode: 200,
            body: {
                success: false,
                error: "ระบบไม่สามารถมอบยศให้คุณได้ในขณะนี้ กรุณาแจ้งผู้ดูแลเซิร์ฟเวอร์เพื่อตรวจสอบสิทธิ์ของบอท",
                code: "role_assign_failed",
                roleName
            }
        };
    }

    // --- Step 8: Critical Persistence Check ---
    const persistenceResult = evaluateCriticalPersistence({
        oauthSaved: oauthPersistence?.saved === true,
        verifyLogSaved: Boolean(verifyLogSaved),
        verifyLogDegraded: verifyLogSaved?.isBudgetDegraded === true,
        trackingRequired: Boolean(ipInfo?.ipHash),
        trackingSaved: Boolean(trackingSnapshot)
    });

    if (!persistenceResult.ok) {
        console.error("[VERIFY] Critical persistence failure detected. Coordinating rollback/recovery...");
        const recoveryOutcome = await coordinatePersistenceFailure({
            requestId: req?.id || `req_${Date.now()}`,
            guildId,
            userId: profile.id,
            roleId: configuredRoleId,
            result: "failed",
            roleAssignResult,
            roleApplied: roleAssignResult?.ok === true && roleAssignResult?.alreadyHadRole !== true,
            persistence: persistenceResult.persistence,
            removeRole: () => discord.removeRoleFromMember(guildId, profile.id, configuredRoleId),
            saveRecovery: async recoveryRecord => {
                const res = await VerificationRecovery.create(recoveryRecord);
                return Boolean(res);
            }
        });

        return {
            statusCode: 200,
            body: {
                success: false,
                error: recoveryOutcome.response?.error || "ระบบบันทึกข้อมูลไม่สมบูรณ์ กรุณาติดต่อผู้ดูแล",
                code: "verification_persistence_failed",
                roleName
            }
        };
    }

    // --- Step 9: Webhook Log Verify Dispatch (Asynchronous) ---
    const roleAssignedOk = roleAssignResult?.ok === true || roleAssignResult?.alreadyHadRole === true || roleAssignResult?.joinedWithRole === true;
    if (verifyLogSaved?._id && verifyLogSaved.result === "success" && roleAssignedOk) {
        verificationWebhookManager.dispatchLiveEvent({
            guildId,
            userId: profile.id,
            logId: String(verifyLogSaved._id),
            eventData: verifyLogSaved
        }).catch(err => console.error("[VERIFY] live webhook dispatch failed:", err.message));
    }

    // --- Step 10: DM Notification ---
    safeSideEffect("sendVerificationDM", () => discord.sendVerificationDM(profile.id, {
        ok: true,
        result: "success",
        guildName,
        roleName,
        reason: finalReason
    }));

    // --- Step 11: Return Final Outcome ---
    const isAlreadyVerified = finalReason === "already_verified_has_role";
    const userFacingMessage = isAlreadyVerified
        ? "บัญชีของคุณยืนยันตัวตนเรียบร้อยแล้ว และมียศนี้อยู่แล้ว สามารถใช้งานได้ทันที"
        : "ยืนยันตัวตนสำเร็จแล้ว! คุณได้รับยศเรียบร้อยแล้ว สามารถกลับไปใช้งาน Discord ได้เลย";

    return {
        statusCode: 200,
        body: {
            success: true,
            message: userFacingMessage,
            alreadyHasRole: isAlreadyVerified,
            roleName,
            user: {
                id: profile.id,
                username: profile.globalName || profile.username,
                globalName: profile.globalName || profile.username,
                tag: displayTag(profile),
                avatarUrl: getAvatarUrl(profile)
            }
        }
    };
}

module.exports = {
    executeVerification,
    saveOAuthUserSafe,
    saveVerifyLogSafe,
    updateIpIdentityTrackingSafe,
    loadExistingIpLinkContext,
    loadExistingDeviceContext,
    isPanelRevisionValid,
    fitVerifyLogBudget
};
