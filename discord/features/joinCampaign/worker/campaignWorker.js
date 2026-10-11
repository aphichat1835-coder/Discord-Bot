"use strict";

const discordApi = require("../../../verification/utils/discordAPI");
const oauthTokenManager = require("../../../core/oauthTokenManager");
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
    } catch (_) {}
}

function randomJitter(minMs = 100, maxMs = 500) {
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

class CampaignWorker {
    constructor() {
        this._activeWorkerPromise = null;
        this._currentJobId = null;
        this._isStopping = false;
        this._wakeUpResolvers = new Set();
        this._abortController = null;
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
            try { this._abortController.abort(); } catch (_) {}
        }
        for (const wakeUp of this._wakeUpResolvers) {
            try { wakeUp(); } catch (_) {}
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
            await this._activeWorkerPromise;
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

        const targetGuildName = targetGuild.name || job.targetGuildName || targetGuildId;
        const requestedQuota = Number(job.requestedAmount) || 0;

        let joinedCount = Number(job.joinedCount) || 0;
        let alreadyCount = Number(job.alreadyCount) || 0;
        let failedCount = Number(job.failedCount) || 0;
        const processedUserIds = repository.getProcessedUserIds
            ? repository.getProcessedUserIds(job.id)
            : new Set();
        let processedCount = Math.max(Number(job.processedCount) || 0, processedUserIds.size);
        let retryCount = Number(job.retryCount) || 0;

        // Distinct retry trackers to avoid 5xx competing with 429 budget
        const rateLimitRetries = new Map();
        const networkRetries = new Map();

        // Bounded adaptive concurrency pool parameters
        const minConcurrency = 1;
        const maxConcurrency = Math.min(32, Math.max(1, Number(config.maxConcurrency || 32)));
        let currentConcurrency = Math.min(maxConcurrency, Math.max(minConcurrency, Number(job.currentConcurrency || 8)));

        let candidateCursor = job.candidateCursor || null;
        let backoffUntil = 0;
        let consecutiveSuccesses = 0;
        let isGuildFull = false;
        let finalStatus = "COMPLETED";
        let statusReason = null;

        const batchBuffer = [];
        let batchIndex = 1;
        let lastPanelUpdateAt = Date.now();

        // 1. Resolve Target Guild membership set (Deduplication cache)
        let targetMemberIds = (passedTargetMemberIds instanceof Set)
            ? passedTargetMemberIds
            : (job.targetMemberIds instanceof Set ? job.targetMemberIds : null);
        if (!targetMemberIds) {
            try {
                targetMemberIds = await getLiveTargetMemberIds(targetGuild);
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

        // 2. Seen users tracking across batches
        const completedUserIds = repository.getCompletedUserIds ? repository.getCompletedUserIds(job.id) : new Set();
        const seenUsers = new Set([...completedUserIds]);

        // Helper to resolve active control panel with fallback to active job id
        const getTargetPanel = () => {
            let p = null;
            if (job.startedByChannelId && repository.findPanelByChannelId) {
                p = repository.findPanelByChannelId(job.startedByChannelId);
            }
            if (!p && repository.findPanelByActiveJobId) {
                p = repository.findPanelByActiveJobId(job.id);
            }
            return p;
        };

        // Helper to update panel debounced
        const updatePanelDebounced = async (force = false) => {
            const now = Date.now();
            if (!force && now - lastPanelUpdateAt < 2500) return;
            lastPanelUpdateAt = now;

            try {
                const panel = getTargetPanel();
                if (!panel || !panel.messageId) return;

                const channel = await client.channels.fetch(panel.channelId).catch(() => null);
                if (!channel) return;
                const message = await channel.messages.fetch(panel.messageId).catch(() => null);
                if (!message) return;

                const liveJobPayload = {
                    status: "RUNNING",
                    joinedCount,
                    requestedAmount: requestedQuota,
                    currentConcurrency
                };

                const panelPayload = buildPanelPayload({
                    mode,
                    panelState: panel,
                    readyCount: panel.lastReadyCount,
                    liveJob: liveJobPayload,
                    targetGuildName
                });

                await message.edit(panelPayload).catch(() => {});
            } catch (_) {}
        };

        // 3. Initialize candidate stream generator
        const candidateStream = streamCandidates({
            mode,
            baseConfig: {
                sourceGuildId: job.sourceGuildId,
                targetGuildId: job.targetGuildId
            },
            tokenManager,
            batchSize: Math.max(50, Number(config.batchSize || 200)),
            startCursor: candidateCursor,
            seenUsers
        });

        let streamExhausted = false;

        // Helper: refill SQLite items queue from MongoDB candidate stream if low
        const maybeTopUpQueue = async () => {
            if (streamExhausted) return;
            const pendingCount = repository.countPendingItems ? repository.countPendingItems(job.id) : 0;
            if (pendingCount >= 40) return;

            const itemsToInsert = [];
            let lastConsumedCursor = candidateCursor;

            while (itemsToInsert.length < 100) {
                const nextItem = await candidateStream.next();
                if (nextItem.done) {
                    streamExhausted = true;
                    break;
                }

                const { candidate, cursor } = nextItem.value || {};
                if (cursor) {
                    lastConsumedCursor = cursor;
                }
                if (!candidate) continue;

                const userId = String(candidate.userId || candidate.discord?.userId || "").trim();
                if (!userId || seenUsers.has(userId)) continue;

                // Strict tokenField validation (fail-closed, no fallback)
                const tokenField = String(candidate.tokenField || "").trim();
                if (tokenField !== "oauth" && tokenField !== "adminOAuth") {
                    console.warn(`[JoinCampaign] Candidate ${userId} has invalid tokenField "${tokenField}". Skipping.`);
                    continue;
                }

                seenUsers.add(userId);

                itemsToInsert.push({
                    userId,
                    tokenField
                });
            }

            if (itemsToInsert.length > 0) {
                repository.createItems(job.id, itemsToInsert);
            }

            // Checkpoint cursor only up to the last safely consumed candidate
            if (lastConsumedCursor && lastConsumedCursor !== candidateCursor) {
                candidateCursor = lastConsumedCursor;
                try {
                    repository.updateJob(job.id, { candidateCursor });
                } catch (_) {}
            }
        };

        try {
            // Preload initial queue batch
            await maybeTopUpQueue();

            const activeTasks = new Set();
            const currentlyProcessingUsers = new Set();
            let inFlightJoins = 0;

            // Helper to flush batch logs when buffer reaches configured limit
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

            // Common checkpoint function to ensure SQLite job counters are always updated
            const checkpointJobCounters = () => {
                const elapsedSeconds = Math.max(1, (Date.now() - startTime) / 1000);
                const currentThroughput = Number((joinedCount / elapsedSeconds).toFixed(2));

                try {
                    repository.updateJob(job.id, {
                        joinedCount,
                        alreadyCount,
                        failedCount,
                        processedCount,
                        retryCount,
                        currentConcurrency,
                        currentThroughput,
                        candidateCursor
                    });
                } catch (err) {
                    console.error(`[JoinCampaign] Checkpoint failed for job ${job.id}:`, err?.message);
                }
            };

            // Centralized outcome pipeline guaranteeing strict checkpointing and batch logging
            const recordItemOutcome = async ({ userId, status, error = null, retryDelayMs = 0 }) => {
                if (status === "joined") {
                    joinedCount++;
                    targetMemberIds.add(userId);
                    repository.updateItemStatus(job.id, userId, "joined");
                    batchBuffer.push({ userId, status: "joined" });
                } else if (status === "already_member") {
                    alreadyCount++;
                    targetMemberIds.add(userId);
                    repository.updateItemStatus(job.id, userId, "already_member");
                    batchBuffer.push({ userId, status: "already_member" });
                } else if (status === "failed" || status === "guild_full") {
                    failedCount++;
                    repository.updateItemStatus(job.id, userId, "failed", error || status);
                    batchBuffer.push({ userId, status: status === "guild_full" ? "guild_full" : "failed" });
                } else if (status === "retry") {
                    retryCount++;
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

            // Main adaptive concurrency loop with strict quota reservation
            while (!this._isStopping && joinedCount < requestedQuota) {
                if (isGuildFull) {
                    finalStatus = "SERVER_FULL";
                    statusReason = "เซิร์ฟเวอร์ปลายทางมีสมาชิกเต็มแล้ว";
                    break;
                }

                // Check rate-limit backoff
                const now = Date.now();
                if (now < backoffUntil) {
                    await this._interruptibleSleep(backoffUntil - now);
                    continue;
                }

                // Top up queue if needed
                await maybeTopUpQueue();

                // Quota reservation: ensure in-flight + joined never exceeds requested quota
                const remainingSlots = requestedQuota - (joinedCount + inFlightJoins);
                if (remainingSlots <= 0 || activeTasks.size >= currentConcurrency) {
                    await Promise.race(activeTasks);
                    continue;
                }

                // 120s base lease to accommodate OAuth refresh, JIT tokens, and backoffs
                const item = repository.claimNextPendingItem(job.id, 120000);
                if (!item) {
                    if (activeTasks.size > 0) {
                        await Promise.race(activeTasks);
                        continue;
                    }
                    if (streamExhausted && (repository.countPendingItems ? repository.countPendingItems(job.id, "all") === 0 : true)) {
                        // Candidate pool is exhausted before meeting target quota
                        finalStatus = joinedCount > 0 ? "PARTIAL" : "FAILED";
                        if (joinedCount === 0 && !statusReason) {
                            statusReason = "ไม่สามารถดึงสมาชิกเข้าเซิร์ฟเวอร์ได้ตามเป้าหมาย (ไม่มีสมาชิกที่พร้อมดึงหรือเกิดข้อผิดพลาด)";
                        }
                        break;
                    }
                    await this._interruptibleSleep(200);
                    continue;
                }

                if (currentlyProcessingUsers.has(item.userId)) {
                    // Item is currently being actively processed by an in-flight task in this worker
                    if (typeof repository.renewItemLease === "function") {
                        repository.renewItemLease(job.id, item.userId, 60000);
                    }
                    continue;
                }

                // Reserve in-flight join slot and track active user
                inFlightJoins++;
                currentlyProcessingUsers.add(item.userId);

                // Launch worker task concurrently
                const taskPromise = (async () => {
                    let heartbeatTimer = null;
                    if (typeof repository.renewItemLease === "function") {
                        heartbeatTimer = setInterval(() => {
                            try {
                                if (!currentlyProcessingUsers.has(item.userId)) {
                                    if (heartbeatTimer) clearInterval(heartbeatTimer);
                                    return;
                                }
                                repository.renewItemLease(job.id, item.userId, 60000);
                            } catch (_) {}
                        }, 15000);
                    }

                    try {
                        const userId = item.userId;
                        // processedCount reflects distinct candidate users processed
                        if (!processedUserIds.has(userId)) {
                            processedUserIds.add(userId);
                            processedCount = processedUserIds.size;
                        }

                        // STEP 1: Pre-filter against current Target Membership
                        if (targetMemberIds.has(userId)) {
                            await recordItemOutcome({ userId, status: "already_member" });
                            return;
                        }

                        // Quota safeguard before executing external work
                        if (joinedCount >= requestedQuota) {
                            processedUserIds.delete(userId);
                            processedCount = processedUserIds.size;
                            await recordItemOutcome({ userId, status: "requeue_pending" });
                            return;
                        }

                        const itemTokenField = String(item.tokenField || "").trim();
                        if (itemTokenField !== "oauth" && itemTokenField !== "adminOAuth") {
                            await recordItemOutcome({ userId, status: "failed", error: "invalid_token_field" });
                            return;
                        }

                        // STEP 2: JIT Token Retrieval & Refresh (Passing configured refreshMarginMs and abort signal)
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
                            // Interrupted by shutdown before token retrieval completed
                            return;
                        }

                        const accessToken = tokenResult?.accessToken;
                        if (!accessToken) {
                            await recordItemOutcome({ userId, status: "failed", error: "token_unavailable" });
                            return;
                        }

                        // Final check on quota before calling Discord API
                        if (joinedCount >= requestedQuota) {
                            processedUserIds.delete(userId);
                            processedCount = processedUserIds.size;
                            await recordItemOutcome({ userId, status: "requeue_pending" });
                            return;
                        }

                        // STEP 3: Call Discord REST API with callerManagedRetry so worker owns backoff
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
                            // Interrupted by shutdown
                            return;
                        }

                        // STEP 4: Handle response & adapt concurrency
                        const status = res?.status;
                        const discordCode = res?.error?.code ?? res?.code;

                        if (res?.ok || status === 201) {
                            await recordItemOutcome({ userId, status: "joined" });

                            // Adaptive ramp-up on consecutive successes
                            consecutiveSuccesses++;
                            if (consecutiveSuccesses >= 4 && currentConcurrency < maxConcurrency) {
                                currentConcurrency = Math.min(maxConcurrency, currentConcurrency + 1);
                                consecutiveSuccesses = 0;
                            }
                        } else if (status === 204) {
                            await recordItemOutcome({ userId, status: "already_member" });
                        } else if (status === 429) {
                            // Rate Limited: scale down concurrency & back off
                            consecutiveSuccesses = 0;
                            currentConcurrency = Math.max(minConcurrency, Math.floor(currentConcurrency / 2));

                            const maxRateLimitRetries = Number(config.maxRateLimitRetries || 3);
                            const currentRlRetries = (rateLimitRetries.get(userId) || 0) + 1;
                            rateLimitRetries.set(userId, currentRlRetries);

                            if (currentRlRetries <= maxRateLimitRetries) {
                                const explicitRetry = Number(res?.retryAfter);
                                const retryAfterMs = Number.isFinite(explicitRetry) && explicitRetry > 0
                                    ? explicitRetry
                                    : 2500;
                                const backoffDelay = retryAfterMs + randomJitter(50, 150);

                                backoffUntil = Date.now() + backoffDelay;

                                // Re-queue item for retry with backoff delay
                                await recordItemOutcome({ userId, status: "retry", error: "rate_limited", retryDelayMs: backoffDelay });
                            } else {
                                await recordItemOutcome({ userId, status: "failed", error: "rate_limit_retries_exceeded" });
                            }
                        } else if (status >= 500 || status === 0) {
                            // Server / Network Transient Error
                            consecutiveSuccesses = 0;
                            currentConcurrency = Math.max(minConcurrency, currentConcurrency - 1);

                            const currentNetRetries = (networkRetries.get(userId) || 0) + 1;
                            networkRetries.set(userId, currentNetRetries);

                            if (currentNetRetries <= 2) {
                                const delay = Math.min(1000 * Math.pow(2, currentNetRetries), 12000) + randomJitter(50, 200);
                                await recordItemOutcome({ userId, status: "retry", error: "network_error", retryDelayMs: delay });
                            } else {
                                await recordItemOutcome({ userId, status: "failed", error: "network_retries_exceeded" });
                            }
                        } else {
                            // 4xx Permanent Errors
                            consecutiveSuccesses = 0;

                            if (discordCode === 30005) {
                                // Target Guild member limit reached (Max guild members)
                                isGuildFull = true;
                                await recordItemOutcome({ userId, status: "guild_full", error: "guild_full" });
                                return;
                            }

                            const errReason = res?.error?.message || (discordCode ? `error_${discordCode}` : `http_${status}`);
                            await recordItemOutcome({ userId, status: "failed", error: errReason });
                        }
                    } catch (taskErr) {
                        if (this._isStopping && (taskErr?.name === "AbortError" || this._abortController?.signal?.aborted)) {
                            return;
                        }
                        console.error(`[JoinCampaign] Task execution error for user ${item.userId}:`, taskErr?.message);
                        try {
                            await recordItemOutcome({ userId: item.userId, status: "failed", error: taskErr?.message || "task_error" });
                        } catch (_) {}
                    } finally {
                        if (heartbeatTimer) clearInterval(heartbeatTimer);
                        currentlyProcessingUsers.delete(item.userId);
                        inFlightJoins--;
                        checkpointJobCounters();
                    }
                })();

                activeTasks.add(taskPromise);
                taskPromise.then(
                    () => activeTasks.delete(taskPromise),
                    () => activeTasks.delete(taskPromise)
                );

                // Microtask yield instead of artificial 50ms throttle
                await new Promise(resolve => setImmediate(resolve));
            }

            // Await any remaining active concurrent tasks
            if (activeTasks.size > 0) {
                await Promise.allSettled(Array.from(activeTasks));
            }

            // Flush remaining batch logs
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

            if (this._isStopping) {
                finalStatus = "INTERRUPTED";
                statusReason = "หยุดการทำงานชั่วคราวเนื่องจากบอทปิดระบบ (Graceful Shutdown) พร้อมกลับมาทำงานต่อเมื่อระบบเริ่มใหม่";
            } else if (joinedCount >= requestedQuota && requestedQuota > 0) {
                finalStatus = "COMPLETED";
                statusReason = null;
            } else if (isGuildFull) {
                finalStatus = "SERVER_FULL";
                statusReason = "เซิร์ฟเวอร์ปลายทางมีสมาชิกเต็มแล้ว";
            } else if (joinedCount > 0) {
                finalStatus = "PARTIAL";
                statusReason = "สมาชิกที่พร้อมดึงในระบบหมดแล้วก่อนถึงเป้าหมาย";
            } else {
                finalStatus = "FAILED";
                if (!statusReason) {
                    statusReason = "ไม่สามารถดึงสมาชิกเข้าเซิร์ฟเวอร์ได้ตามเป้าหมาย (ไม่มีสมาชิกที่พร้อมดึงหรือเกิดข้อผิดพลาด)";
                }
            }

        } catch (err) {
            finalStatus = "FAILED";
            statusReason = sanitizeUserFacingError(err.message || "เกิดข้อผิดพลาดในการประมวลผล");
            const elapsedSeconds = Math.max(1, (Date.now() - startTime) / 1000);
            repository.updateJob(job.id, {
                status: "FAILED",
                lastError: statusReason,
                joinedCount,
                alreadyCount,
                failedCount,
                processedCount,
                retryCount,
                currentThroughput: Number((joinedCount / elapsedSeconds).toFixed(2)),
                completedAt: Date.now()
            });
            dispatchSystemicAlert({
                code: "join_campaign.worker_crash",
                title: "Join Campaign: การประมวลผลล้มเหลว",
                description: err.message || statusReason,
                details: {
                    campaignId: job.id,
                    joinedCount,
                    requestedQuota
                }
            });
            throw err;
        } finally {
            const completedAt = Date.now();
            const durationMs = completedAt - startTime;
            const elapsedSeconds = Math.max(1, durationMs / 1000);
            const currentThroughput = Number((joinedCount / elapsedSeconds).toFixed(2));
            const isInterrupted = finalStatus === "INTERRUPTED";
            const completedTimestamp = isInterrupted ? null : completedAt;

            // Release any stale leases
            if (repository.releaseExpiredLeases) {
                repository.releaseExpiredLeases(job.id);
            }

            // Checkpoint final state to SQLite
            repository.updateJob(job.id, {
                status: finalStatus,
                lastError: statusReason ? sanitizeUserFacingError(statusReason) : null,
                joinedCount,
                alreadyCount,
                failedCount,
                processedCount,
                retryCount,
                currentConcurrency,
                currentThroughput,
                candidateCursor,
                completedAt: completedTimestamp
            });

            // ALWAYS send Final Summary Webhook regardless of success or failure
            try {
                await sendFinalSummaryEmbed({
                    webhookUrl: job.webhookUrl,
                    mode,
                    targetGuildName,
                    targetGuildId,
                    sourceGuildName: job.sourceGuildName,
                    sourceGuildId: job.sourceGuildId,
                    requestedQuota,
                    joinedCount,
                    alreadyCount,
                    failedCount,
                    processedCount,
                    retryCount,
                    durationMs,
                    finalStatus,
                    statusReason
                });
            } catch (_) {}

            // Update panel message in channel to final idle state
            try {
                await this._finishPanelUpdate({
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
                });
            } catch (_) {}
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

            const summaryText = `${statusPrefix} **${Number(joinedCount).toLocaleString("th-TH")}** คน` +
                (alreadyCount > 0 ? ` | อยู่ในเซิร์ฟแล้ว **${Number(alreadyCount).toLocaleString("th-TH")}** คน` : "") +
                (failedCount > 0 ? ` | ไม่สำเร็จ **${Number(failedCount).toLocaleString("th-TH")}** คน` : "");

            const isInterrupted = finalStatus === "INTERRUPTED";
            const targetChannelId = job.startedByChannelId || "";
            let panel = (targetChannelId && repository.findPanelByChannelId) ? repository.findPanelByChannelId(targetChannelId) : null;
            if (!panel && repository.findPanelByActiveJobId) {
                panel = repository.findPanelByActiveJobId(job.id);
            }

            let freshReadyCount = null;
            try {
                let targetGuild = client.guilds.cache.get(String(job.targetGuildId));
                if (!targetGuild && client.guilds?.fetch) {
                    targetGuild = await client.guilds.fetch(String(job.targetGuildId)).catch(() => null);
                }
                if (targetGuild) {
                    const liveMemberIds = await getLiveTargetMemberIds(targetGuild);
                    freshReadyCount = await countEligibleCandidates({
                        mode,
                        baseConfig: {
                            sourceGuildId: job.sourceGuildId,
                            targetGuildId: job.targetGuildId
                        },
                        tokenManager,
                        targetMemberIds: liveMemberIds
                    });
                } else {
                    freshReadyCount = panel?.lastReadyCount ?? null;
                }
            } catch (_) {
                // If member check failed, retain previous count to avoid presenting inflated numbers
                freshReadyCount = panel?.lastReadyCount ?? null;
            }
            if (panel) {
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
            }
        } catch (_) {}
    }
}

module.exports = new CampaignWorker();
