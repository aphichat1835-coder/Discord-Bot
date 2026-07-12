const crypto = require("node:crypto");
const OAuthUser = require("../verification/models/OAuthUser");
const discordApi = require("../verification/utils/discordAPI");
const { decryptToken } = require("../verification/utils/crypto");
const {
    buildStoredOAuthUpdate,
    getVerificationRedirectUri,
    getAdminRedirectUri
} = require("../verification/utils/oauthTokenLifecycle");
const { sendLogWebhook } = require("../core/webhooks");
const { safeError } = require("../core/safeLogger");

const TOKEN_FIELDS = Object.freeze([
    { tokenField: "oauth", label: "verify", redirectUri: getVerificationRedirectUri },
    { tokenField: "adminOAuth", label: "admin", redirectUri: getAdminRedirectUri }
]);

const runningState = {
    active: null,
    last: null,
    stopRequested: false
};

function readBooleanDefaultTrue(value) {
    if (value === undefined || value === null || value === "") return true;
    return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function readPositiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min) return fallback;
    return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function parseIdSet(value) {
    return new Set(String(value || "")
        .split(/[,\s]+/)
        .map(item => item.trim())
        .filter(Boolean));
}

function getJoinCampaignConfig(env = process.env) {
    const legacyBatchSize = readPositiveInt(env.JOIN_CAMPAIGN_MAX_USERS, 500, 1, 1000);
    const batchSize = readPositiveInt(env.JOIN_CAMPAIGN_BATCH_SIZE, legacyBatchSize, 1, 1000);
    return {
        enabled: readBooleanDefaultTrue(env.JOIN_CAMPAIGN_ENABLED),
        allowedGuilds: parseIdSet(env.JOIN_CAMPAIGN_ALLOWED_GUILDS),
        batchSize,
        maxUsers: batchSize,
        delayMs: readPositiveInt(env.JOIN_CAMPAIGN_DELAY_MS, 1500, 0, 60000),
        progressEvery: readPositiveInt(env.JOIN_CAMPAIGN_PROGRESS_EVERY, 50, 1, 1000),
        refreshMarginMs: readPositiveInt(env.JOIN_CAMPAIGN_REFRESH_MARGIN_MS, 60 * 60 * 1000, 60 * 1000, 7 * 24 * 60 * 60 * 1000),
        failMax: readPositiveInt(env.OAUTH_TOKEN_REFRESH_FAIL_MAX, 5, 1, 50)
    };
}

function isSnowflake(value) {
    return /^\d{17,22}$/.test(String(value || ""));
}

function isGuildAllowed(guildId, config = getJoinCampaignConfig()) {
    if (!isSnowflake(guildId)) return false;
    return config.allowedGuilds.size === 0 || config.allowedGuilds.has(String(guildId));
}

function normalizeScope(scope) {
    return new Set(String(scope || "")
        .split(/\s+/)
        .map(item => item.trim())
        .filter(Boolean));
}

function hasGuildsJoinScope(tokenState = {}) {
    return normalizeScope(tokenState.scope).has("guilds.join");
}

function buildCandidateQuery() {
    const tokenBranches = TOKEN_FIELDS.map(({ tokenField }) => ({
        [`${tokenField}.encryptedRefreshToken`]: { $exists: true, $ne: "" },
        [`${tokenField}.revokedAt`]: { $in: [null] }
    }));

    return {
        $and: [
            {
                $or: [
                    { deletedAt: { $exists: false } },
                    { deletedAt: null }
                ]
            },
            { $or: tokenBranches }
        ]
    };
}

async function loadCandidateDocs({ model = OAuthUser, limit = getJoinCampaignConfig().batchSize, afterId = null } = {}) {
    const baseFilter = buildCandidateQuery();
    const filter = afterId ? { $and: [baseFilter, { _id: { $gt: afterId } }] } : baseFilter;
    return model.find(filter)
        .select("discord.userId oauth adminOAuth updatedAt")
        .sort({ _id: 1 })
        .limit(limit)
        .lean();
}

function chooseJoinToken(doc) {
    for (const fieldConfig of TOKEN_FIELDS) {
        const tokenState = doc?.[fieldConfig.tokenField] || {};
        if (!tokenState.encryptedRefreshToken || tokenState.revokedAt) continue;
        if (!hasGuildsJoinScope(tokenState)) continue;
        return {
            ...fieldConfig,
            tokenState
        };
    }

    return null;
}

function summarizeJoinCandidates(docs = []) {
    const seenUsers = new Set();
    const summary = {
        scannedRecords: Array.isArray(docs) ? docs.length : 0,
        uniqueUsers: 0,
        usableUsers: 0,
        missingScope: 0,
        missingUserId: 0,
        byTokenField: {}
    };

    for (const fieldConfig of TOKEN_FIELDS) {
        summary.byTokenField[fieldConfig.tokenField] = 0;
    }

    for (const doc of docs || []) {
        const userId = String(doc?.discord?.userId || "").trim();
        if (!userId) {
            summary.missingUserId++;
            continue;
        }
        if (seenUsers.has(userId)) continue;
        seenUsers.add(userId);
        summary.uniqueUsers++;

        const chosen = chooseJoinToken(doc);
        if (!chosen) {
            summary.missingScope++;
            continue;
        }

        summary.usableUsers++;
        summary.byTokenField[chosen.tokenField]++;
    }

    return summary;
}

function makeCampaignId(now = Date.now()) {
    return `join_${now.toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function makeBaseSummary({ campaignId, targetGuildId, targetGuildName, dryRun = false, startedBy = "owner-dashboard", startedAt = Date.now() }) {
    return {
        campaignId,
        targetGuildId: String(targetGuildId),
        targetGuildName: targetGuildName || null,
        dryRun,
        startedBy,
        startedAt,
        finishedAt: null,
        status: "running",
        scannedRecords: 0,
        uniqueUsers: 0,
        usableUsers: 0,
        missingScope: 0,
        missingUserId: 0,
        byTokenField: Object.fromEntries(TOKEN_FIELDS.map(({ tokenField }) => [tokenField, 0])),
        joined: 0,
        alreadyMember: 0,
        failed: 0,
        refreshed: 0,
        refreshFailed: 0,
        tokenInvalid: 0,
        botMissingPermission: 0,
        rateLimited: 0,
        discordError: 0,
        stopped: false,
        errors: []
    };
}

function pushError(summary, userId, reason, detail = null) {
    if (!summary || summary.errors.length >= 15) return;
    summary.errors.push({
        userId: userId || null,
        reason,
        detail: detail ? String(detail).slice(0, 180) : null
    });
}

function shouldRefreshToken(tokenState = {}, now = Date.now(), marginMs = 60 * 60 * 1000) {
    if (!tokenState.encryptedAccessToken) return true;
    const expiresAt = Number(tokenState.expiresAt || 0);
    return !Number.isFinite(expiresAt) || expiresAt <= now + marginMs;
}

function updateFilterForDoc(doc) {
    if (doc?._id) return { _id: doc._id };
    return { "discord.userId": doc?.discord?.userId };
}

function tokenRedirectUri(fieldConfig, env = process.env) {
    return fieldConfig.redirectUri(env);
}

async function markTokenRefreshFailure({ model, doc, tokenField, err, now = Date.now(), failMax = 5 }) {
    const tokenState = doc?.[tokenField] || {};
    const nextFailCount = Number(tokenState.refreshFailCount || 0) + 1;
    const set = {
        [`${tokenField}.refreshFailCount`]: nextFailCount,
        [`${tokenField}.lastRefreshError`]: safeError(err),
        updatedAt: now
    };

    if (nextFailCount >= failMax) set[`${tokenField}.revokedAt`] = now;

    await model.updateOne(updateFilterForDoc(doc), { $set: set }).catch(() => {});
}

async function refreshStoredToken({ model, doc, chosen, discord = discordApi, env = process.env, now = Date.now(), prepareTokenStorage = discordApi.prepareTokenStorage }) {
    const tokenData = await discord.refreshToken(chosen.tokenState.encryptedRefreshToken, tokenRedirectUri(chosen, env));
    const stored = buildStoredOAuthUpdate(tokenData, now, prepareTokenStorage);

    await model.updateOne(updateFilterForDoc(doc), {
        $set: {
            [chosen.tokenField]: stored,
            updatedAt: now
        }
    });

    chosen.tokenState = stored;
    return stored;
}

async function getUsableAccessToken({
    model,
    doc,
    chosen,
    discord = discordApi,
    env = process.env,
    now = Date.now(),
    config = getJoinCampaignConfig(env),
    decrypt = decryptToken,
    prepareTokenStorage = discordApi.prepareTokenStorage
}) {
    let tokenState = chosen.tokenState || {};
    let refreshed = false;

    if (shouldRefreshToken(tokenState, now, config.refreshMarginMs)) {
        tokenState = await refreshStoredToken({
            model,
            doc,
            chosen,
            discord,
            env,
            now,
            prepareTokenStorage
        });
        refreshed = true;
    }

    let accessToken = decrypt(tokenState.encryptedAccessToken);

    if (!accessToken && tokenState.encryptedRefreshToken) {
        tokenState = await refreshStoredToken({
            model,
            doc,
            chosen,
            discord,
            env,
            now,
            prepareTokenStorage
        });
        refreshed = true;
        accessToken = decrypt(tokenState.encryptedAccessToken);
    }

    return {
        accessToken,
        refreshed
    };
}

function reasonFromJoinResult(result) {
    const status = Number(result?.status || 0);
    if (status === 401 || status === 400) return "token_invalid";
    if (status === 403) return "bot_missing_permission";
    if (status === 429) return "rate_limited";
    return "discord_error";
}

function recordJoinFailure(summary, userId, reason, detail = null) {
    summary.failed++;
    if (reason === "token_invalid") summary.tokenInvalid++;
    else if (reason === "bot_missing_permission") summary.botMissingPermission++;
    else if (reason === "rate_limited") summary.rateLimited++;
    else summary.discordError++;
    pushError(summary, userId, reason, detail);
}

async function maybeReportCampaignProgress(summary, processed, config, options) {
    if (processed % config.progressEvery !== 0) return;
    options.onSummary?.(summary);
    await sendCampaignWebhook(summary, "progress", options.sendWebhook || sendLogWebhook);
}

async function waitBetweenJoinAttempts(config, options) {
    if (config.delayMs <= 0) return;
    await (options.sleep || sleep)(config.delayMs);
}

async function handleJoinCandidate({ doc, seenUsers, summary, targetGuildId, model, discord, env, config, options }) {
    const userId = String(doc?.discord?.userId || "").trim();
    if (!userId || seenUsers.has(userId)) return false;
    seenUsers.add(userId);

    const chosen = chooseJoinToken(doc);
    if (!chosen) return false;

    try {
        const existing = await discord.getGuildMemberWithBot?.(targetGuildId, userId);
        if (existing) {
            summary.alreadyMember++;
            return true;
        }

        const access = await getUsableAccessToken({
            model,
            doc,
            chosen,
            discord,
            env,
            now: Date.now(),
            config,
            decrypt: options.decryptToken || decryptToken,
            prepareTokenStorage: options.prepareTokenStorage || discordApi.prepareTokenStorage
        });

        if (access.refreshed) summary.refreshed++;

        if (!access.accessToken) {
            recordJoinFailure(summary, userId, "token_invalid");
            return true;
        }

        const result = await discord.addMemberToGuild(targetGuildId, userId, access.accessToken);
        if (result?.ok) {
            if (Number(result.status) === 204) summary.alreadyMember++;
            else summary.joined++;
            return true;
        }

        recordJoinFailure(summary, userId, reasonFromJoinResult(result), safeError(result?.error || result));
        return true;
    } catch (err) {
        await handleJoinCandidateError({
            err,
            summary,
            userId,
            model,
            doc,
            chosen,
            config
        });
        return true;
    }
}

async function handleJoinCandidateError({ err, summary, userId, model, doc, chosen, config }) {
    if (String(err?.message || "").includes("refresh")) {
        summary.refreshFailed++;
        await markTokenRefreshFailure({
            model,
            doc,
            tokenField: chosen.tokenField,
            err,
            now: Date.now(),
            failMax: config.failMax
        });
        recordJoinFailure(summary, userId, "refresh_failed", safeError(err));
        return;
    }

    recordJoinFailure(summary, userId, "discord_error", safeError(err));
}

function sleep(ms) {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}

function getJoinCampaignTitle(phase = "progress") {
    if (phase === "start") return "เริ่มงานดึงสมาชิกเข้าเซิร์ฟเวอร์";
    if (phase === "finish") return "งานดึงสมาชิกเข้าเซิร์ฟเวอร์เสร็จแล้ว";
    return "อัปเดตงานดึงสมาชิกเข้าเซิร์ฟเวอร์";
}

function formatCampaignErrorLine(item = {}) {
    const userId = item.userId || "-";
    const detail = item.detail ? ` (${item.detail})` : "";
    return `- \`${userId}\` : ${item.reason}${detail}`;
}

function formatThaiJoinCampaignLog(summary, phase = "progress") {
    const title = getJoinCampaignTitle(phase);
    const targetName = summary.targetGuildName
        ? `${summary.targetGuildName} (${summary.targetGuildId})`
        : summary.targetGuildId;
    const lines = [
        `📥 **${title}**`,
        `รหัสงาน: \`${summary.campaignId}\``,
        `เซิร์ฟเวอร์เป้าหมาย: \`${targetName}\``,
        `โหมด: ${summary.dryRun ? "ตรวจจำนวนเท่านั้น" : "ดึงจริง"}`,
        `สถานะ: ${summary.status}`,
        "",
        `ตรวจพบทั้งหมด: ${summary.scannedRecords} records / ${summary.uniqueUsers} users`,
        `ใช้ได้จริง: ${summary.usableUsers} users`,
        `ดึงเข้าสำเร็จ: ${summary.joined}`,
        `อยู่ในเซิร์ฟเวอร์แล้ว: ${summary.alreadyMember}`,
        `ไม่สำเร็จ: ${summary.failed}`,
        `refresh token แล้ว: ${summary.refreshed}`,
        `refresh ไม่สำเร็จ: ${summary.refreshFailed}`,
        `ขาด scope guilds.join: ${summary.missingScope}`,
        `token ใช้ไม่ได้: ${summary.tokenInvalid}`,
        `บอทขาดสิทธิ์: ${summary.botMissingPermission}`,
        `โดน rate limit: ${summary.rateLimited}`
    ];

    if (summary.errors.length) {
        lines.push("", "ตัวอย่างรายการที่ไม่สำเร็จ:");
        for (const item of summary.errors.slice(0, 5)) {
            lines.push(formatCampaignErrorLine(item));
        }
    }

    return { content: lines.join("\n").slice(0, 1900) };
}

async function sendCampaignWebhook(summary, phase, sendWebhook = sendLogWebhook) {
    await sendWebhook(formatThaiJoinCampaignLog(summary, phase)).catch(() => {});
}

function buildExecutionContext(options = {}) {
    const env = options.env || process.env;
    const config = {
        ...getJoinCampaignConfig(env),
        ...options.config
    };
    const targetGuildId = String(options.targetGuildId || "").trim();

    return {
        env,
        config,
        targetGuildId,
        model: options.OAuthUserModel || OAuthUser,
        discord: options.discordApi || discordApi,
        now: Number(options.now || Date.now())
    };
}

function assertCampaignCanRun(targetGuildId, config) {
    if (!config.enabled) {
        throw new Error("JOIN_CAMPAIGN_ENABLED is disabled");
    }
    if (!isGuildAllowed(targetGuildId, config)) {
        throw new Error("Target guild is not allowed");
    }
}

function createExecutionSummary(options, context, docs) {
    const summary = makeBaseSummary({
        campaignId: options.campaignId || makeCampaignId(context.now),
        targetGuildId: context.targetGuildId,
        targetGuildName: options.targetGuildName || null,
        dryRun: options.dryRun === true,
        startedBy: options.startedBy || "owner-dashboard",
        startedAt: context.now
    });

    if (Array.isArray(docs)) Object.assign(summary, summarizeJoinCandidates(docs));
    summary.batches = 0;
    return summary;
}

function mergeCandidateSummary(summary, batchSummary) {
    summary.scannedRecords += batchSummary.scannedRecords;
    summary.uniqueUsers += batchSummary.uniqueUsers;
    summary.usableUsers += batchSummary.usableUsers;
    summary.missingScope += batchSummary.missingScope;
    summary.missingUserId += batchSummary.missingUserId;
    for (const fieldConfig of TOKEN_FIELDS) {
        const field = fieldConfig.tokenField;
        summary.byTokenField[field] = Number(summary.byTokenField[field] || 0) +
            Number(batchSummary.byTokenField[field] || 0);
    }
}

async function completeDryRun(summary, options, now) {
    if (!summary.stopped) summary.status = "dry_run_complete";
    summary.finishedAt = now;
    options.onSummary?.(summary);
    if (options.sendFinishLog) {
        await sendCampaignWebhook(summary, "finish", options.sendWebhook || sendLogWebhook);
    }
    return summary;
}

async function processCampaignDocs(docs, summary, context, options, seenUsers = new Set()) {
    let processed = 0;

    for (const doc of docs) {
        if (options.shouldStop?.()) {
            summary.stopped = true;
            summary.status = "stopped";
            break;
        }

        const processedOne = await handleJoinCandidate({
            doc,
            seenUsers,
            summary,
            targetGuildId: context.targetGuildId,
            model: context.model,
            discord: context.discord,
            env: context.env,
            config: context.config,
            options
        });

        if (!processedOne) continue;

        processed++;
        await maybeReportCampaignProgress(summary, processed, context.config, options);
        await waitBetweenJoinAttempts(context.config, options);
    }
}

function campaignBatchSize(config = {}) {
    return readPositiveInt(config.batchSize ?? config.maxUsers, 500, 1, 1000);
}

async function processLoadedBatch(docs, summary, context, options, seenUsers) {
    mergeCandidateSummary(summary, summarizeJoinCandidates(docs));
    summary.batches++;
    options.onSummary?.(summary);
    if (!summary.dryRun) await processCampaignDocs(docs, summary, context, options, seenUsers);
}

async function processAllCandidateBatches(summary, context, options) {
    let afterId = null;
    const batchSize = campaignBatchSize(context.config);
    while (!options.shouldStop?.()) {
        const docs = await loadCandidateDocs({
            model: context.model,
            limit: batchSize,
            afterId
        });
        if (!docs.length) break;
        await processLoadedBatch(docs, summary, context, options, new Set());
        const nextCursor = docs.at(-1)?._id;
        if (!nextCursor || String(nextCursor) === String(afterId || "")) {
            throw new Error("join campaign cursor did not advance");
        }
        afterId = nextCursor;
        if (docs.length < batchSize) break;
    }
    if (options.shouldStop?.()) {
        summary.stopped = true;
        summary.status = "stopped";
    }
}

async function finishCampaignSummary(summary, options) {
    if (summary.status === "running") summary.status = "finished";
    summary.finishedAt = Date.now();
    options.onSummary?.(summary);

    if (options.sendFinishLog !== false) {
        await sendCampaignWebhook(summary, "finish", options.sendWebhook || sendLogWebhook);
    }

    return summary;
}

async function executeJoinCampaign(options = {}) {
    const context = buildExecutionContext(options);
    assertCampaignCanRun(context.targetGuildId, context.config);

    const suppliedDocs = Array.isArray(options.candidateDocs) ? options.candidateDocs : null;
    const summary = createExecutionSummary(options, context, suppliedDocs || undefined);
    options.onSummary?.(summary);

    if (options.sendStartLog) {
        await sendCampaignWebhook(summary, "start", options.sendWebhook || sendLogWebhook);
    }

    if (suppliedDocs) {
        if (!summary.dryRun) {
            summary.batches = suppliedDocs.length ? 1 : 0;
            await processCampaignDocs(suppliedDocs, summary, context, options);
        }
    } else {
        await processAllCandidateBatches(summary, context, options);
    }

    if (summary.dryRun) return completeDryRun(summary, options, context.now);

    return finishCampaignSummary(summary, options);
}

function startJoinCampaign(options = {}) {
    if (runningState.active?.status === "running") {
        return {
            ok: false,
            error: "campaign_already_running",
            campaign: runningState.active
        };
    }

    const config = {
        ...getJoinCampaignConfig(options.env || process.env),
        ...options.config
    };
    const targetGuildId = String(options.targetGuildId || "").trim();

    if (!config.enabled) {
        return {
            ok: false,
            error: "campaign_disabled"
        };
    }

    if (!isGuildAllowed(targetGuildId, config)) {
        return {
            ok: false,
            error: "target_guild_not_allowed"
        };
    }

    const campaignId = options.campaignId || makeCampaignId();
    runningState.stopRequested = false;
    runningState.active = makeBaseSummary({
        campaignId,
        targetGuildId,
        targetGuildName: options.targetGuildName,
        dryRun: false,
        startedBy: options.startedBy || "owner-dashboard"
    });

    executeJoinCampaign({
        ...options,
        config,
        campaignId,
        dryRun: false,
        sendStartLog: true,
        sendFinishLog: true,
        shouldStop: () => runningState.stopRequested,
        onSummary: summary => {
            runningState.active = summary;
        }
    }).then(summary => {
        runningState.active = summary;
        runningState.last = summary;
    }).catch(err => {
        const failed = {
            ...runningState.active,
            status: "failed",
            finishedAt: Date.now(),
            failedReason: safeError(err)
        };
        pushError(failed, null, "campaign_failed", safeError(err));
        runningState.active = failed;
        runningState.last = failed;
        sendCampaignWebhook(failed, "finish", options.sendWebhook || sendLogWebhook).catch(() => {});
    });

    return {
        ok: true,
        campaign: runningState.active
    };
}

function stopJoinCampaign() {
    if (runningState.active?.status !== "running") {
        return { ok: false, error: "no_campaign_running" };
    }

    runningState.stopRequested = true;
    return { ok: true };
}

function getJoinCampaignStatus() {
    return {
        active: runningState.active,
        last: runningState.last,
        stopRequested: runningState.stopRequested
    };
}

module.exports = {
    TOKEN_FIELDS,
    getJoinCampaignConfig,
    isGuildAllowed,
    hasGuildsJoinScope,
    buildCandidateQuery,
    loadCandidateDocs,
    chooseJoinToken,
    summarizeJoinCandidates,
    shouldRefreshToken,
    getUsableAccessToken,
    formatThaiJoinCampaignLog,
    executeJoinCampaign,
    startJoinCampaign,
    stopJoinCampaign,
    getJoinCampaignStatus,
    _test: {
        parseIdSet,
        readBooleanDefaultTrue,
        readPositiveInt,
        makeCampaignId,
        markTokenRefreshFailure,
        recordJoinFailure,
        campaignBatchSize,
        mergeCandidateSummary,
        processAllCandidateBatches,
        runningState
    }
};
