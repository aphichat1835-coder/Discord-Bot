"use strict";

const crypto = require("node:crypto");
const discordApi = require("../../../verification/utils/discordAPI");
const oauthTokenManager = require("../../../tokens/oauthTokenManager");
const { getJoinCampaignConfig } = require("../config");
const { sendBatchLog, sendFinalSummaryEmbed, sanitizeUserFacingError } = require("./batchLogger");
const { getMode } = require("../modes/modeRegistry");
const { streamCandidates } = require("../services/candidateQueryService");
const { buildPanelPayload } = require("../ui/panelBuilder");
const { countEligibleCandidates } = require("../services/candidateQueryService");
const { getLiveTargetMemberIds } = require("../services/preflightService");

function dispatchSystemicAlert({ code, title, description, error, details = {} }) {
    try {
        const { sendWebhookEvent } = require("../../../core/webhooks");
        if (typeof sendWebhookEvent === "function") {
            sendWebhookEvent({
                category: "SYSTEM",
                severity: "CRITICAL",
                actionRequired: true,
                code: code || "join_campaign.systemic_error",
                title: title || "Join Campaign Systemic Error",
                description: description || error?.message || "Join campaign error",
                fields: Object.entries(details).map(([name, value]) => ({
                    name,
                    value: String(value),
                    inline: true
                }))
            });
        }
    } catch (err) {
        // Best-effort alert notification; log warning and swallow errors to prevent cascading failures
        console.warn(`[JoinCampaign] ⚠️ Failed to dispatch systemic alert (${code}): ${err?.message}`);
    }
}

function randomJitter(minMs = 100, maxMs = 500) {
    if (minMs >= maxMs) return minMs;
    return crypto.randomInt(minMs, maxMs + 1);
}

function determineFinalStatus({ isStopping, joinedCount, requestedQuota, isGuildFull, statusReason }) {
    if (isStopping) {
        return {
            finalStatus: "INTERRUPTED",
            statusReason: "หยุดการทำงานชั่วคราวเนื่องจากบอทปิดระบบ (Graceful Shutdown) พร้อมกลับมาทำงานต่อเมื่อระบบเริ่มใหม่"
        };
    }
    if (joinedCount >= requestedQuota && requestedQuota > 0) {
        return {
            finalStatus: "COMPLETED",
            statusReason: null
        };
    }
    if (isGuildFull) {
        return {
            finalStatus: "SERVER_FULL",
            statusReason: "เซิร์ฟเวอร์ปลายทางมีสมาชิกเต็มแล้ว"
        };
    }
    if (joinedCount > 0) {
        return {
            finalStatus: "PARTIAL",
            statusReason: "สมาชิกที่พร้อมดึงในระบบหมดแล้วก่อนถึงเป้าหมาย"
        };
    }
    return {
        finalStatus: "FAILED",
        statusReason: statusReason || "ไม่สามารถดึงสมาชิกเข้าเซิร์ฟเวอร์ได้ตามเป้าหมาย (ไม่มีสมาชิกที่พร้อมดึงหรือเกิดข้อผิดพลาด)"
    };
}

function formatFinalStatusSummary({ finalStatus, joinedCount, alreadyCount, failedCount }) {
    let statusPrefix = "ดึงสมาชิกเข้าสำเร็จ";
    if (finalStatus === "SERVER_FULL") {
        statusPrefix = "หยุดทำงาน (เซิร์ฟเวอร์เต็ม)";
    } else if (finalStatus === "FAILED") {
        statusPrefix = "เกิดข้อผิดพลาด";
    } else if (finalStatus === "PARTIAL") {
        statusPrefix = "ดึงเข้าสำเร็จบางส่วน";
    } else if (finalStatus === "INTERRUPTED") {
        statusPrefix = "หยุดชั่วคราวเพื่อรีสตาร์ต (พร้อมทำต่ออัตโนมัติ)";
    }

    return `${statusPrefix} **${Number(joinedCount).toLocaleString("th-TH")}** คน` +
        (alreadyCount > 0 ? ` | อยู่ในเซิร์ฟแล้ว **${Number(alreadyCount).toLocaleString("th-TH")}** คน` : "") +
        (failedCount > 0 ? ` | ไม่สำเร็จ **${Number(failedCount).toLocaleString("th-TH")}** คน` : "");
}

async function resolveTargetGuildFreshReadyCount({ client, job, mode, tokenManager, fallbackCount }) {
    try {
        let targetGuild = client.guilds.cache.get(String(job.targetGuildId));
        if (!targetGuild && client.guilds?.fetch) {
            targetGuild = await client.guilds.fetch(String(job.targetGuildId)).catch(() => null);
        }
        if (!targetGuild) return fallbackCount;

        const liveMemberIds = await getLiveTargetMemberIds(targetGuild);
        return await countEligibleCandidates({
            mode,
            baseConfig: {
                sourceGuildId: job.sourceGuildId,
                targetGuildId: job.targetGuildId
            },
            tokenManager,
            targetMemberIds: liveMemberIds
        });
    } catch (err) {
        // Ignored: If member check failed, retain previous count to avoid presenting inflated numbers
        console.warn(`[JoinCampaign] ⚠️ Failed to resolve fresh ready count for guild ${job.targetGuildId}: ${err?.message}`);
        return fallbackCount;
    }
}

class CampaignWorker {
    _activeWorkerPromise = null;
    _currentJobId = null;
    _isStopping = false;
    _wakeUpResolvers = new Set();
    _abortController = null;

    constructor() {
        // Class fields initialize instance properties
    }

    get isRunning() {
        return Boolean(this._activeWorkerPromise);
    }

    get currentJobId() {
        return this._currentJobId;
    }

    stopCurrentWorker() {
        this._isStopping = true;
        if (this._abortController) {
            try { this._abortController.abort(); } catch (_err) { /* ignore controller abort error */ }
        }
        for (const wakeUp of this._wakeUpResolvers) {
            try { wakeUp(); } catch (_err) { /* ignore wakeup callback error */ }
        }
        this._wakeUpResolvers.clear();
    }

    _interruptibleSleep(ms) {
        if (this._isStopping || ms <= 0) return Promise.resolve();
        return new Promise((resolve) => {
            let timer = null;
            const wakeUp = () => {
                if (timer) clearTimeout(timer);
                this._wakeUpResolvers.delete(wakeUp);
                resolve();
            };
            timer = setTimeout(wakeUp, ms);
            this._wakeUpResolvers.add(wakeUp);
        });
    }

    async waitForCompletion() {
        if (this._activeWorkerPromise) {
            await Promise.resolve(this._activeWorkerPromise);
        }
    }

    async startWorker({
        job,
        client,
        repository,
        tokenManager = oauthTokenManager,
        discord = discordApi,
        targetMemberIds = null,
        config = getJoinCampaignConfig()
    }) {
        if (this.isRunning) {
            throw new Error("ตอนนี้มีงานดึงสมาชิกกำลังทำงานอยู่ กรุณารอให้งานเดิมเสร็จก่อนนะครับ");
        }

        this._currentJobId = job.id;
        this._isStopping = false;
        this._abortController = new AbortController();
        this._wakeUpResolvers.clear();

        this._activeWorkerPromise = this._executeLoop({
            job,
            client,
            repository,
            tokenManager,
            discord,
            targetMemberIds,
            config
        }).finally(() => {
            this._activeWorkerPromise = null;
            this._currentJobId = null;
            this._abortController = null;
        });

        return { ok: true, jobId: job.id, workerPromise: this._activeWorkerPromise };
    }

    async _resolveTargetGuild(client, job, repository) {
        const targetGuildId = String(job.targetGuildId);
        let targetGuild = client.guilds.cache.get(targetGuildId);
        if (!targetGuild && client.guilds?.fetch) {
            targetGuild = await client.guilds.fetch(targetGuildId).catch(() => null);
        }

        if (!targetGuild) {
            const failClosedMsg = "ไม่พบเซิร์ฟเวอร์ปลายทาง หรือบอทไม่ได้อยู่ในเซิร์ฟเวอร์เป้าหมายแล้ว (Fail-Closed)";
            repository.updateJob(job.id, {
                status: "FAILED",
                lastError: failClosedMsg,
                completedAt: Date.now()
            });
            dispatchSystemicAlert({
                code: "join_campaign.target_guild_missing",
                title: "Join Campaign: เซิร์ฟเวอร์ปลายทางไม่พร้อมใช้งาน",
                description: failClosedMsg,
                details: {
                    campaignId: job.id,
                    targetGuildId
                }
            });
            throw new Error(failClosedMsg);
        }
        return targetGuild;
    }

    async _resolveTargetMemberIds(targetGuild, job, passedTargetMemberIds, repository) {
        if (passedTargetMemberIds instanceof Set) {
            return passedTargetMemberIds;
        }
        if (job.targetMemberIds instanceof Set) {
            return job.targetMemberIds;
        }
        try {
            return await getLiveTargetMemberIds(targetGuild);
        } catch (err) {
            const failClosedMsg = "ไม่สามารถตรวจสอบรายชื่อสมาชิกในเซิร์ฟเวอร์เป้าหมายได้ครบถ้วน (Fail-Closed ป้องกันข้อมูลซ้ำซ้อน)";
            repository.updateJob(job.id, {
                status: "FAILED",
                lastError: failClosedMsg,
                completedAt: Date.now()
            });
            throw new Error(failClosedMsg);
        }
    }

    _parseCandidateQueueItem(candidate, seenUsers) {
        if (!candidate) return null;
        const userId = String(candidate.userId || candidate.discord?.userId || "").trim();
        if (!userId || seenUsers.has(userId)) return null;

        const tokenField = String(candidate.tokenField || "").trim();
        if (tokenField !== "oauth") {
            console.warn(`[JoinCampaign] Candidate ${userId} has invalid tokenField "${tokenField}". Skipping.`);
            return null;
        }
        return { userId, tokenField };
    }

    async _refillCandidateQueue({ candidateStream, repository, jobId, seenUsers, ctx }) {
        if (ctx.streamExhausted) return;
        const pendingCount = repository.countPendingItems ? repository.countPendingItems(jobId) : 0;
        if (pendingCount >= 40) return;

        const itemsToInsert = [];
        let lastConsumedCursor = ctx.candidateCursor;

        while (itemsToInsert.length < 100) {
            const nextItem = await candidateStream.next();
            if (nextItem.done) {
                ctx.streamExhausted = true;
                break;
            }

            const { candidate, cursor } = nextItem.value || {};
            if (cursor) {
                lastConsumedCursor = cursor;
            }

            const validItem = this._parseCandidateQueueItem(candidate, seenUsers);
            if (!validItem) continue;

            seenUsers.add(validItem.userId);
            itemsToInsert.push(validItem);
        }

        if (itemsToInsert.length > 0) {
            repository.createItems(jobId, itemsToInsert);
        }

        // Checkpoint cursor only up to the last safely consumed candidate
        if (lastConsumedCursor && lastConsumedCursor !== ctx.candidateCursor) {
            ctx.candidateCursor = lastConsumedCursor;
            try {
                repository.updateJob(jobId, { candidateCursor: lastConsumedCursor });
            } catch (_err) {
                // Best-effort checkpoint cursor update
            }
        }
    }

    async _handleRateLimitResponse({ res, userId, ctx, config, minConcurrency, rateLimitRetries, recordItemOutcome }) {
        ctx.consecutiveSuccesses = 0;
        ctx.currentConcurrency = Math.max(minConcurrency, Math.floor(ctx.currentConcurrency / 2));

        const maxRateLimitRetries = Number(config.maxRateLimitRetries || 3);
        const currentRlRetries = (rateLimitRetries.get(userId) || 0) + 1;
        rateLimitRetries.set(userId, currentRlRetries);

        if (currentRlRetries <= maxRateLimitRetries) {
            const explicitRetry = Number(res?.retryAfter);
            const retryAfterMs = Number.isFinite(explicitRetry) && explicitRetry > 0
                ? explicitRetry
                : 2500;
            const backoffDelay = retryAfterMs + randomJitter(50, 150);
            ctx.backoffUntil = Date.now() + backoffDelay;
            await recordItemOutcome({ userId, status: "retry", error: "rate_limited", retryDelayMs: backoffDelay });
        } else {
            await recordItemOutcome({ userId, status: "failed", error: "rate_limit_retries_exceeded" });
        }
    }

    async _handleServerErrorResponse({ userId, ctx, minConcurrency, networkRetries, recordItemOutcome }) {
        ctx.consecutiveSuccesses = 0;
        ctx.currentConcurrency = Math.max(minConcurrency, ctx.currentConcurrency - 1);

        const currentNetRetries = (networkRetries.get(userId) || 0) + 1;
        networkRetries.set(userId, currentNetRetries);

        if (currentNetRetries <= 2) {
            const delay = Math.min(1000 * Math.pow(2, currentNetRetries), 12000) + randomJitter(50, 200);
            await recordItemOutcome({ userId, status: "retry", error: "network_error", retryDelayMs: delay });
        } else {
            await recordItemOutcome({ userId, status: "failed", error: "network_retries_exceeded" });
        }
    }

    async _handleMemberAddResponse({
        res,
        userId,
        ctx,
        config,
        minConcurrency,
        maxConcurrency,
        rateLimitRetries,
        networkRetries,
        recordItemOutcome
    }) {
        const status = res?.status;
        const discordCode = res?.error?.code ?? res?.code;

        if (res?.ok || status === 201) {
            await recordItemOutcome({ userId, status: "joined" });
            ctx.consecutiveSuccesses++;
            if (ctx.consecutiveSuccesses >= 4 && ctx.currentConcurrency < maxConcurrency) {
                ctx.currentConcurrency = Math.min(maxConcurrency, ctx.currentConcurrency + 1);
                ctx.consecutiveSuccesses = 0;
            }
            return;
        }

        if (status === 204) {
            await recordItemOutcome({ userId, status: "already_member" });
            return;
        }

        if (status === 429) {
            await this._handleRateLimitResponse({ res, userId, ctx, config, minConcurrency, rateLimitRetries, recordItemOutcome });
            return;
        }

        if (status >= 500 || status === 0) {
            await this._handleServerErrorResponse({ userId, ctx, minConcurrency, networkRetries, recordItemOutcome });
            return;
        }

        ctx.consecutiveSuccesses = 0;
        if (discordCode === 30005) {
            ctx.isGuildFull = true;
            await recordItemOutcome({ userId, status: "guild_full", error: "guild_full" });
            return;
        }

        const errReason = res?.error?.message || (discordCode ? `error_${discordCode}` : `http_${status}`);
        await recordItemOutcome({ userId, status: "failed", error: errReason });
    }

    async _processCandidateItem({
        item,
        job,
        repository,
        tokenManager,
        discord,
        config,
        targetGuildId,
        requestedQuota,
        minConcurrency,
        maxConcurrency,
        ctx,
        targetMemberIds,
        processedUserIds,
        currentlyProcessingUsers,
        rateLimitRetries,
        networkRetries,
        recordItemOutcome,
        checkpointJobCounters
    }) {
        let heartbeatTimer = null;
        if (typeof repository.renewItemLease === "function") {
            heartbeatTimer = setInterval(() => {
                try {
                    if (!currentlyProcessingUsers.has(item.userId)) {
                        if (heartbeatTimer) clearInterval(heartbeatTimer);
                        return;
                    }
                    repository.renewItemLease(job.id, item.userId, 60000);
                } catch (err) {
                    // Ignore lease renewal heartbeat error on transient lock
                }
            }, 15000);
        }

        try {
            const userId = item.userId;
            if (!processedUserIds.has(userId)) {
                processedUserIds.add(userId);
                ctx.processedCount = processedUserIds.size;
            }

            if (targetMemberIds.has(userId)) {
                await recordItemOutcome({ userId, status: "already_member" });
                return;
            }

            if (ctx.joinedCount >= requestedQuota) {
                processedUserIds.delete(userId);
                ctx.processedCount = processedUserIds.size;
                await recordItemOutcome({ userId, status: "requeue_pending" });
                return;
            }

            const itemTokenField = String(item.tokenField || "").trim();
            if (itemTokenField !== "oauth") {
                await recordItemOutcome({ userId, status: "failed", error: "invalid_token_field" });
                return;
            }

            let tokenResult;
            try {
                tokenResult = await tokenManager.getAccessToken({
                    userId,
                    tokenField: itemTokenField,
                    marginMs: config.refreshMarginMs,
                    env: process.env,
                    signal: this._abortController?.signal
                });
            } catch (err) {
                if (this._isStopping && (err?.name === "AbortError" || this._abortController?.signal?.aborted)) {
                    return;
                }
                tokenResult = { ok: false, code: "error", error: err };
            }

            if (this._isStopping && (tokenResult?.code === "aborted" || tokenResult?.error?.name === "AbortError" || this._abortController?.signal?.aborted)) {
                return;
            }

            const accessToken = tokenResult?.accessToken;
            if (!accessToken) {
                await recordItemOutcome({ userId, status: "failed", error: "token_unavailable" });
                return;
            }

            if (ctx.joinedCount >= requestedQuota) {
                processedUserIds.delete(userId);
                ctx.processedCount = processedUserIds.size;
                await recordItemOutcome({ userId, status: "requeue_pending" });
                return;
            }

            let res;
            try {
                res = await discord.addMemberToGuild(targetGuildId, userId, accessToken, {
                    callerManagedRetry: true,
                    signal: this._abortController?.signal
                });
            } catch (err) {
                res = { ok: false, status: 500, error: err };
            }

            if (this._isStopping && (res?.error?.name === "AbortError" || this._abortController?.signal?.aborted)) {
                return;
            }

            await this._handleMemberAddResponse({
                res,
                userId,
                ctx,
                config,
                minConcurrency,
                maxConcurrency,
                rateLimitRetries,
                networkRetries,
                recordItemOutcome
            });
        } catch (taskErr) {
            if (this._isStopping && (taskErr?.name === "AbortError" || this._abortController?.signal?.aborted)) {
                return;
            }
            console.error(`[JoinCampaign] Task execution error for user ${item.userId}:`, taskErr?.message);
            try {
                await recordItemOutcome({ userId: item.userId, status: "failed", error: taskErr?.message || "task_error" });
            } catch (_err) {
                // Best-effort outcome recording on unexpected failure
            }
        } finally {
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            currentlyProcessingUsers.delete(item.userId);
            ctx.inFlightJoins--;
            checkpointJobCounters();
        }
    }

    _spawnCandidateTask(params) {
        const { item, ctx, currentlyProcessingUsers, activeTasks } = params;
        ctx.inFlightJoins++;
        currentlyProcessingUsers.add(item.userId);

        const taskPromise = this._processCandidateItem(params);
        activeTasks.add(taskPromise);
        taskPromise.then(
            () => activeTasks.delete(taskPromise),
            () => activeTasks.delete(taskPromise)
        );
    }

    async _executeLoop({
        job,
        client,
        repository,
        tokenManager,
        discord,
        targetMemberIds: passedTargetMemberIds = null,
        config
    }) {
        const startTime = job.createdAt || Date.now();
        const mode = getMode(job.mode);
        const targetGuildId = String(job.targetGuildId);
        const targetGuild = await this._resolveTargetGuild(client, job, repository);
        const targetGuildName = targetGuild.name || job.targetGuildName || targetGuildId;
        const requestedQuota = Number(job.requestedAmount) || 0;

        const processedUserIds = repository.getProcessedUserIds
            ? repository.getProcessedUserIds(job.id)
            : new Set();

        const minConcurrency = 1;
        const maxConcurrency = Math.min(32, Math.max(1, Number(config.maxConcurrency || 32)));

        const ctx = {
            joinedCount: Number(job.joinedCount) || 0,
            alreadyCount: Number(job.alreadyCount) || 0,
            failedCount: Number(job.failedCount) || 0,
            processedCount: Math.max(Number(job.processedCount) || 0, processedUserIds.size),
            retryCount: Number(job.retryCount) || 0,
            currentConcurrency: Math.min(maxConcurrency, Math.max(minConcurrency, Number(job.currentConcurrency || 8))),
            candidateCursor: job.candidateCursor || null,
            backoffUntil: 0,
            consecutiveSuccesses: 0,
            isGuildFull: false,
            streamExhausted: false,
            inFlightJoins: 0,
            finalStatus: "COMPLETED",
            statusReason: null
        };

        const rateLimitRetries = new Map();
        const networkRetries = new Map();

        const batchBuffer = [];
        let batchIndex = 1;
        let lastPanelUpdateAt = Date.now();

        const targetMemberIds = await this._resolveTargetMemberIds(targetGuild, job, passedTargetMemberIds, repository);
        const completedUserIds = repository.getCompletedUserIds ? repository.getCompletedUserIds(job.id) : new Set();
        const seenUsers = new Set(completedUserIds);

        const getTargetPanel = () => {
            let p = null;
            if (job.startedByChannelId) {
                p = repository.findPanelByChannelId?.(job.startedByChannelId);
            }
            if (!p) {
                p = repository.findPanelByActiveJobId?.(job.id);
            }
            return p;
        };

        const updatePanelDebounced = async (force = false) => {
            const now = Date.now();
            if (!force && now - lastPanelUpdateAt < 2500) return;
            lastPanelUpdateAt = now;

            try {
                const panel = getTargetPanel();
                if (!panel?.messageId) return;

                const channel = await client.channels.fetch(panel.channelId).catch(() => null);
                if (!channel) return;
                const message = await channel.messages.fetch(panel.messageId).catch(() => null);
                if (!message) return;

                const liveJobPayload = {
                    status: "RUNNING",
                    joinedCount: ctx.joinedCount,
                    requestedAmount: requestedQuota,
                    currentConcurrency: ctx.currentConcurrency
                };

                const panelPayload = buildPanelPayload({
                    mode,
                    panelState: panel,
                    readyCount: panel.lastReadyCount,
                    liveJob: liveJobPayload,
                    targetGuildName
                });

                await message.edit(panelPayload);
            } catch (_err) {
                // Best-effort: Discord message edit failure should not interrupt background campaign processing
            }
        };

        const candidateStream = streamCandidates({
            mode,
            baseConfig: {
                sourceGuildId: job.sourceGuildId,
                targetGuildId: job.targetGuildId
            },
            tokenManager,
            batchSize: Math.max(50, Number(config.batchSize || 200)),
            startCursor: ctx.candidateCursor,
            seenUsers
        });

        const checkpointJobCounters = () => {
            const elapsedSeconds = Math.max(1, (Date.now() - startTime) / 1000);
            const currentThroughput = Number((ctx.joinedCount / elapsedSeconds).toFixed(2));

            try {
                repository.updateJob(job.id, {
                    joinedCount: ctx.joinedCount,
                    alreadyCount: ctx.alreadyCount,
                    failedCount: ctx.failedCount,
                    processedCount: ctx.processedCount,
                    retryCount: ctx.retryCount,
                    currentConcurrency: ctx.currentConcurrency,
                    currentThroughput,
                    candidateCursor: ctx.candidateCursor
                });
            } catch (err) {
                console.error(`[JoinCampaign] Checkpoint failed for job ${job.id}:`, err?.message);
            }
        };

        const flushBatchBuffer = async () => {
            if (batchBuffer.length >= config.progressEvery) {
                const batchItems = batchBuffer.splice(0, config.progressEvery);
                const bJoined = batchItems.filter(i => i.status === "joined").length;
                const bAlready = batchItems.filter(i => i.status === "already_member").length;
                const bFailed = batchItems.filter(i => i.status === "failed" || i.status === "guild_full").length;

                await sendBatchLog({
                    webhookUrl: job.webhookUrl,
                    mode,
                    batchNumber: batchIndex++,
                    items: batchItems,
                    joinedCount: bJoined,
                    alreadyCount: bAlready,
                    failedCount: bFailed,
                    targetGuildName
                });
            }
        };

        const recordItemOutcome = async ({ userId, status, error = null, retryDelayMs = 0 }) => {
            if (status === "joined") {
                ctx.joinedCount++;
                targetMemberIds.add(userId);
                repository.updateItemStatus(job.id, userId, "joined");
                batchBuffer.push({ userId, status: "joined" });
            } else if (status === "already_member") {
                ctx.alreadyCount++;
                targetMemberIds.add(userId);
                repository.updateItemStatus(job.id, userId, "already_member");
                batchBuffer.push({ userId, status: "already_member" });
            } else if (status === "failed" || status === "guild_full") {
                ctx.failedCount++;
                repository.updateItemStatus(job.id, userId, "failed", error || status);
                batchBuffer.push({ userId, status: status === "guild_full" ? "guild_full" : "failed" });
            } else if (status === "retry") {
                ctx.retryCount++;
                repository.incrementItemAttempt(job.id, userId, error, retryDelayMs);
            } else if (status === "requeue_pending") {
                repository.updateItemStatus(job.id, userId, "pending");
            }

            if (status !== "requeue_pending" && status !== "retry") {
                await flushBatchBuffer();
            }

            checkpointJobCounters();
            await updatePanelDebounced(false);
        };

        try {
            await this._refillCandidateQueue({
                candidateStream,
                repository,
                jobId: job.id,
                seenUsers,
                ctx
            });

            const activeTasks = new Set();
            const currentlyProcessingUsers = new Set();

            const shouldStopWorker = () => {
                if (this._isStopping || ctx.joinedCount >= requestedQuota) {
                    return true;
                }
                if (ctx.isGuildFull) {
                    ctx.finalStatus = "SERVER_FULL";
                    ctx.statusReason = "เซิร์ฟเวอร์ปลายทางมีสมาชิกเต็มแล้ว";
                    return true;
                }
                return false;
            };

            const handleNoClaimableItem = async () => {
                if (activeTasks.size > 0) {
                    await Promise.race(activeTasks);
                    return runWorkerLoop();
                }
                const hasPendingItems = repository.countPendingItems ? repository.countPendingItems(job.id, "all") > 0 : false;
                if (ctx.streamExhausted && !hasPendingItems) {
                    ctx.finalStatus = ctx.joinedCount > 0 ? "PARTIAL" : "FAILED";
                    if (ctx.joinedCount === 0 && !ctx.statusReason) {
                        ctx.statusReason = "ไม่สามารถดึงสมาชิกเข้าเซิร์ฟเวอร์ได้ตามเป้าหมาย (ไม่มีสมาชิกที่พร้อมดึงหรือเกิดข้อผิดพลาด)";
                    }
                    return;
                }
                await this._interruptibleSleep(200);
                return runWorkerLoop();
            };

            const runWorkerLoop = async () => {
                if (shouldStopWorker()) {
                    return;
                }

                const now = Date.now();
                if (now < ctx.backoffUntil) {
                    await this._interruptibleSleep(ctx.backoffUntil - now);
                    return runWorkerLoop();
                }

                await this._refillCandidateQueue({
                    candidateStream,
                    repository,
                    jobId: job.id,
                    seenUsers,
                    ctx
                });

                const remainingSlots = requestedQuota - (ctx.joinedCount + ctx.inFlightJoins);
                if (remainingSlots <= 0 || activeTasks.size >= ctx.currentConcurrency) {
                    await Promise.race(activeTasks);
                    return runWorkerLoop();
                }

                const item = repository.claimNextPendingItem(job.id, 120000);
                if (!item) {
                    return handleNoClaimableItem();
                }

                if (currentlyProcessingUsers.has(item.userId)) {
                    if (typeof repository.renewItemLease === "function") {
                        repository.renewItemLease(job.id, item.userId, 60000);
                    }
                    return runWorkerLoop();
                }

                this._spawnCandidateTask({
                    item,
                    job,
                    repository,
                    tokenManager,
                    discord,
                    config,
                    targetGuildId,
                    requestedQuota,
                    minConcurrency,
                    maxConcurrency,
                    ctx,
                    targetMemberIds,
                    processedUserIds,
                    currentlyProcessingUsers,
                    rateLimitRetries,
                    networkRetries,
                    recordItemOutcome,
                    checkpointJobCounters,
                    activeTasks
                });

                await new Promise(resolve => setImmediate(resolve));
                return runWorkerLoop();
            };

            await runWorkerLoop();

            if (activeTasks.size > 0) {
                await Promise.allSettled(Array.from(activeTasks));
            }

            if (batchBuffer.length > 0) {
                const bJoined = batchBuffer.filter(i => i.status === "joined").length;
                const bAlready = batchBuffer.filter(i => i.status === "already_member").length;
                const bFailed = batchBuffer.filter(i => i.status === "failed" || i.status === "guild_full").length;

                await sendBatchLog({
                    webhookUrl: job.webhookUrl,
                    mode,
                    batchNumber: batchIndex++,
                    items: batchBuffer,
                    joinedCount: bJoined,
                    alreadyCount: bAlready,
                    failedCount: bFailed,
                    targetGuildName
                });
            }

            const statusOutcome = determineFinalStatus({
                isStopping: this._isStopping,
                joinedCount: ctx.joinedCount,
                requestedQuota,
                isGuildFull: ctx.isGuildFull,
                statusReason: ctx.statusReason
            });
            ctx.finalStatus = statusOutcome.finalStatus;
            ctx.statusReason = statusOutcome.statusReason;
        } catch (err) {
            ctx.finalStatus = "FAILED";
            ctx.statusReason = sanitizeUserFacingError(err.message || "เกิดข้อผิดพลาดในการประมวลผล");
            const elapsedSeconds = Math.max(1, (Date.now() - startTime) / 1000);
            repository.updateJob(job.id, {
                status: "FAILED",
                lastError: ctx.statusReason,
                joinedCount: ctx.joinedCount,
                alreadyCount: ctx.alreadyCount,
                failedCount: ctx.failedCount,
                processedCount: ctx.processedCount,
                retryCount: ctx.retryCount,
                currentThroughput: Number((ctx.joinedCount / elapsedSeconds).toFixed(2)),
                completedAt: Date.now()
            });
            dispatchSystemicAlert({
                code: "join_campaign.worker_crash",
                title: "Join Campaign: การประมวลผลล้มเหลว",
                description: err.message || ctx.statusReason,
                details: {
                    campaignId: job.id,
                    joinedCount: ctx.joinedCount,
                    requestedQuota
                }
            });
            throw err;
        } finally {
            const completedAt = Date.now();
            const durationMs = completedAt - startTime;
            const elapsedSeconds = Math.max(1, durationMs / 1000);
            const currentThroughput = Number((ctx.joinedCount / elapsedSeconds).toFixed(2));
            const isInterrupted = ctx.finalStatus === "INTERRUPTED";
            const completedTimestamp = isInterrupted ? null : completedAt;

            if (repository.releaseExpiredLeases) {
                repository.releaseExpiredLeases(job.id);
            }

            repository.updateJob(job.id, {
                status: ctx.finalStatus,
                lastError: ctx.statusReason ? sanitizeUserFacingError(ctx.statusReason) : null,
                joinedCount: ctx.joinedCount,
                alreadyCount: ctx.alreadyCount,
                failedCount: ctx.failedCount,
                processedCount: ctx.processedCount,
                retryCount: ctx.retryCount,
                currentConcurrency: ctx.currentConcurrency,
                currentThroughput,
                candidateCursor: ctx.candidateCursor,
                completedAt: completedTimestamp
            });

            try {
                await sendFinalSummaryEmbed({
                    webhookUrl: job.webhookUrl,
                    mode,
                    targetGuildName,
                    targetGuildId,
                    sourceGuildName: job.sourceGuildName,
                    sourceGuildId: job.sourceGuildId,
                    requestedQuota,
                    joinedCount: ctx.joinedCount,
                    alreadyCount: ctx.alreadyCount,
                    failedCount: ctx.failedCount,
                    processedCount: ctx.processedCount,
                    retryCount: ctx.retryCount,
                    durationMs,
                    finalStatus: ctx.finalStatus,
                    statusReason: ctx.statusReason
                });
            } catch (_err) {
                // Best-effort summary embed delivery
            }

            try {
                await this._finishPanelUpdate({
                    job,
                    client,
                    repository,
                    mode,
                    joinedCount: ctx.joinedCount,
                    alreadyCount: ctx.alreadyCount,
                    failedCount: ctx.failedCount,
                    finalStatus: ctx.finalStatus,
                    targetGuildName,
                    tokenManager
                });
            } catch (_err) {
                // Best-effort final panel update
            }
        }
    }

    async _finishPanelUpdate({
        job,
        client,
        repository,
        mode,
        joinedCount,
        alreadyCount,
        failedCount,
        finalStatus,
        targetGuildName,
        tokenManager
    }) {
        try {
            const summaryText = formatFinalStatusSummary({ finalStatus, joinedCount, alreadyCount, failedCount });
            const isInterrupted = finalStatus === "INTERRUPTED";
            const targetChannelId = job.startedByChannelId || "";
            let panel = (targetChannelId && repository.findPanelByChannelId) ? repository.findPanelByChannelId(targetChannelId) : null;
            if (!panel && repository.findPanelByActiveJobId) {
                panel = repository.findPanelByActiveJobId(job.id);
            }
            if (!panel) return;

            const freshReadyCount = await resolveTargetGuildFreshReadyCount({
                client,
                job,
                mode,
                tokenManager,
                fallbackCount: panel?.lastReadyCount ?? null
            });

            const nextActiveJobId = isInterrupted ? job.id : null;
            const nextLiveJob = isInterrupted ? {
                status: "INTERRUPTED",
                joinedCount,
                requestedAmount: job.requestedAmount || 0,
                currentConcurrency: job.currentConcurrency || 8
            } : null;

            repository.savePanel({
                ...panel,
                activeJobId: nextActiveJobId,
                lastReadyCount: freshReadyCount,
                lastStatusSummary: summaryText
            });

            const channel = await client.channels.fetch(panel.channelId).catch(() => null);
            if (channel) {
                const message = await channel.messages.fetch(panel.messageId).catch(() => null);
                if (message) {
                    const payload = buildPanelPayload({
                        mode,
                        panelState: {
                            ...panel,
                            activeJobId: nextActiveJobId,
                            lastReadyCount: freshReadyCount,
                            lastStatusSummary: summaryText
                        },
                        readyCount: freshReadyCount,
                        liveJob: nextLiveJob,
                        targetGuildName
                    });
                    await message.edit(payload).catch(() => {});
                }
            }
        } catch (err) {
            // Ignore failure during finish panel update
        }
    }
}

module.exports = new CampaignWorker();
