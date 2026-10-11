"use strict";

const crypto = require("node:crypto");
const { runPreflight, getLiveTargetMemberIds } = require("./preflightService");
const { countEligibleCandidates } = require("./candidateQueryService");
const oauthTokenManager = require("../../../core/oauthTokenManager");
const { buildPreflightConfirmationPayload } = require("../ui/confirmationBuilder");
const { buildPanelPayload } = require("../ui/panelBuilder");
const campaignWorker = require("../worker/campaignWorker");
const { getMode } = require("../modes/modeRegistry");
const { sanitizeUserFacingError } = require("../worker/batchLogger");

const stagedSessions = new Map();

async function updatePanelFailureState({ client, repository, channelId, jobId, errorMsg, mode, targetGuildName, readyCount }) {
    try {
        if (!repository) return;
        const panel = (channelId && repository.findPanelByChannelId)
            ? repository.findPanelByChannelId(channelId)
            : (jobId && repository.findPanelByActiveJobId ? repository.findPanelByActiveJobId(jobId) : null);
        if (!panel) return;

        const sanitizedMsg = sanitizeUserFacingError(errorMsg);
        const summaryText = sanitizedMsg.startsWith("เกิดข้อผิดพลาด") ? sanitizedMsg : `เกิดข้อผิดพลาด: ${sanitizedMsg}`;
        const updatedPanel = {
            ...panel,
            activeJobId: null,
            lastStatusSummary: summaryText,
            lastReadyCount: readyCount ?? panel.lastReadyCount
        };

        if (repository.savePanel) {
            repository.savePanel(updatedPanel);
        }

        if (client && panel.channelId && panel.messageId) {
            const channel = await client.channels?.fetch?.(panel.channelId).catch(() => null);
            if (channel) {
                const message = await channel.messages?.fetch?.(panel.messageId).catch(() => null);
                if (message) {
                    const resolvedMode = typeof mode === "string" ? getMode(mode) : mode;
                    const payload = buildPanelPayload({
                        mode: resolvedMode,
                        panelState: updatedPanel,
                        readyCount: updatedPanel.lastReadyCount,
                        liveJob: null,
                        targetGuildName: targetGuildName || "เซิร์ฟเวอร์เป้าหมาย"
                    });
                    await message.edit(payload).catch(() => {});
                }
            }
        }
    } catch (_) {}
}

class JoinCampaignService {
    constructor() {}

    get isRunning() {
        return campaignWorker.isRunning;
    }

    async stageCampaign({
        client,
        repository,
        mode,
        baseConfig,
        requestedAmount = null,
        webhookUrl = null,
        startedByUserId = null,
        channelId = null,
        tokenManager = null
    }) {
        if (this.isRunning) {
            return {
                ok: false,
                error: "ตอนนี้มีงานดึงสมาชิกกำลังทำงานอยู่ กรุณารอให้งานเดิมเสร็จก่อนนะครับ"
            };
        }

        const preflight = await runPreflight({
            client,
            mode,
            baseConfig,
            webhookUrl,
            requestedAmount,
            tokenManager
        });

        if (!preflight.ok) {
            return preflight;
        }

        const stageId = `stage_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
        const session = {
            stageId,
            modeId: mode.id,
            baseConfig,
            preflight,
            webhookUrl: webhookUrl ? String(webhookUrl).trim() : null,
            startedByUserId,
            channelId,
            createdAt: Date.now()
        };

        stagedSessions.set(stageId, session);

        // Auto-cleanup staged session after 15 minutes
        setTimeout(() => {
            stagedSessions.delete(stageId);
        }, 15 * 60 * 1000).unref();

        const payload = buildPreflightConfirmationPayload({
            stageId,
            mode,
            sourceGuildName: preflight.sourceGuildName,
            sourceGuildId: preflight.sourceGuildId,
            targetGuildName: preflight.targetGuildName,
            targetGuildId: preflight.targetGuildId,
            readyCount: preflight.readyCount,
            requestedQuota: preflight.requestedQuota,
            hasWebhook: Boolean(webhookUrl)
        });

        return {
            ok: true,
            stageId,
            payload
        };
    }

    async confirmAndStartCampaign({ stageId, client, repository, tokenManager = oauthTokenManager, discord = null }) {
        const session = stagedSessions.get(stageId);
        if (!session) {
            return {
                ok: false,
                error: "ข้อมูลการเตรียมงานหมดอายุแล้ว กรุณากดเริ่มงานใหม่อีกครั้งนะครับ"
            };
        }

        stagedSessions.delete(stageId);

        if (this.isRunning) {
            return {
                ok: false,
                error: "ตอนนี้มีงานดึงสมาชิกกำลังทำงานอยู่ กรุณารอให้งานเดิมเสร็จก่อนนะครับ"
            };
        }

        const jobId = `camp_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
        const mode = getMode(session.modeId);
        const { preflight } = session;

        // Refresh live target membership right before start to ensure fresh snapshot (Fail-Closed)
        let freshTargetMemberIds;
        let freshReadyCount;
        try {
            let targetGuild = client.guilds?.cache?.get(preflight.targetGuildId);
            if (!targetGuild && client.guilds?.fetch) {
                targetGuild = await client.guilds.fetch(preflight.targetGuildId).catch(() => null);
            }
            if (!targetGuild) {
                return {
                    ok: false,
                    error: "ไม่พบเซิร์ฟเวอร์ปลายทาง หรือบอทไม่ได้อยู่ในเซิร์ฟเวอร์เป้าหมายแล้ว กรุณาเชิญบอทเข้าเซิร์ฟเวอร์ก่อนนะครับ"
                };
            }
            freshTargetMemberIds = await getLiveTargetMemberIds(targetGuild);
            freshReadyCount = await countEligibleCandidates({
                mode,
                baseConfig: {
                    sourceGuildId: preflight.sourceGuildId,
                    targetGuildId: preflight.targetGuildId
                },
                tokenManager: tokenManager || oauthTokenManager,
                targetMemberIds: freshTargetMemberIds
            });
        } catch (err) {
            const sanitizedMsg = sanitizeUserFacingError(err?.message || "เกิดข้อผิดพลาดในการเชื่อมต่อ");
            return {
                ok: false,
                error: `ไม่สามารถตรวจสอบรายชื่อสมาชิกปัจจุบันของเซิร์ฟเวอร์ปลายทางได้: ${sanitizedMsg}`
            };
        }

        if (freshReadyCount === 0) {
            return {
                ok: false,
                error: "ไม่พบสมาชิกที่พร้อมดึงเข้าเซิร์ฟเวอร์ในขณะนี้ (หรือทุกคนอยู่ในเซิร์ฟเวอร์เรียบร้อยแล้ว)"
            };
        }

        // Persist initial job in SQLite (Notice: webhookUrl is NOT stored in SQLite)
        let job;
        try {
            job = repository.createJob({
                id: jobId,
                mode: mode.id,
                sourceGuildId: preflight.sourceGuildId,
                sourceGuildName: preflight.sourceGuildName,
                targetGuildId: preflight.targetGuildId,
                targetGuildName: preflight.targetGuildName,
                status: "RUNNING",
                requestedAmount: preflight.requestedQuota,
                selectedAmount: freshReadyCount,
                joinedCount: 0,
                alreadyCount: 0,
                failedCount: 0,
                processedCount: 0,
                retryCount: 0,
                currentConcurrency: 8,
                currentThroughput: 0.0,
                recoveryCount: 0,
                candidateCursor: null,
                lastError: null,
                startedByUserId: session.startedByUserId,
                startedByChannelId: session.channelId,
                createdAt: Date.now(),
                updatedAt: Date.now()
            });
        } catch (err) {
            if (err?.code === "ACTIVE_CAMPAIGN_EXISTS" || String(err?.message || "").includes("UNIQUE constraint failed")) {
                return {
                    ok: false,
                    error: "ตอนนี้มีงานดึงสมาชิกกำลังทำงานอยู่ กรุณารอให้งานเดิมเสร็จก่อนนะครับ"
                };
            }
            throw err;
        }

        // Associate panel with active job and requested quota in SQLite
        try {
            const panel = repository.findPanelByChannelId(session.channelId);
            if (panel) {
                repository.savePanel({
                    ...panel,
                    activeJobId: jobId,
                    requestedAmount: preflight.requestedQuota,
                    lastReadyCount: freshReadyCount
                });
            }
        } catch (_) {}

        // Start bounded adaptive worker pool in background
        try {
            const startResult = await campaignWorker.startWorker({
                job: {
                    ...job,
                    startedByChannelId: session.channelId,
                    webhookUrl: session.webhookUrl,
                    targetMemberIds: freshTargetMemberIds
                },
                client,
                repository,
                ...(tokenManager ? { tokenManager } : {}),
                ...(discord ? { discord } : {})
            });

            if (startResult?.workerPromise) {
                startResult.workerPromise.catch(async (loopErr) => {
                    const rawErrorMsg = loopErr?.message || "Worker loop terminated unexpectedly";
                    const errorMsg = sanitizeUserFacingError(rawErrorMsg);
                    try {
                        repository.updateJob(jobId, {
                            status: "FAILED",
                            lastError: errorMsg,
                            completedAt: Date.now()
                        });
                        await updatePanelFailureState({
                            client,
                            repository,
                            channelId: session.channelId,
                            jobId,
                            errorMsg,
                            mode,
                            targetGuildName: preflight.targetGuildName,
                            readyCount: freshReadyCount
                        });
                    } catch (_) {}
                });
            }
        } catch (err) {
            const rawErrorMsg = err?.message || "ไม่สามารถเริ่มต้น Worker ได้";
            const errorMsg = sanitizeUserFacingError(rawErrorMsg);
            try {
                repository.updateJob(jobId, {
                    status: "FAILED",
                    lastError: errorMsg,
                    completedAt: Date.now()
                });
                await updatePanelFailureState({
                    client,
                    repository,
                    channelId: session.channelId,
                    jobId,
                    errorMsg,
                    mode,
                    targetGuildName: preflight.targetGuildName,
                    readyCount: freshReadyCount
                });
            } catch (_) {}
            return {
                ok: false,
                error: `ไม่สามารถเริ่มงานได้: ${errorMsg}`
            };
        }

        return {
            ok: true,
            jobId,
            requestedAmount: preflight.requestedQuota,
            message: `เริ่มดึงสมาชิกเข้าสู่ **${preflight.targetGuildName}** เรียบร้อยแล้ว ระบบจะอัปเดตความคืบหน้าให้ทราบอย่างต่อเนื่องครับ`
        };
    }

    getStatus(repository) {
        if (!repository) {
            return {
                isRunning: false,
                active: null,
                last: null,
                activeJob: null,
                lastCompletedJob: null
            };
        }

        const activeJob = repository.findActiveRunningJob();
        const recentJobs = repository.listRecentJobs({ limit: 1 });
        const lastJob = recentJobs.length > 0 ? recentJobs[0] : null;

        const formatForDashboard = (job) => {
            if (!job) return null;
            return {
                id: job.id,
                mode: job.mode,
                targetGuildId: job.targetGuildId,
                target_guild_id: job.targetGuildId,
                targetGuildName: job.targetGuildName,
                target_guild_name: job.targetGuildName,
                sourceGuildId: job.sourceGuildId,
                source_guild_id: job.sourceGuildId,
                sourceGuildName: job.sourceGuildName,
                source_guild_name: job.sourceGuildName,
                status: (job.status || "").toLowerCase(),
                requestedAmount: job.requestedAmount,
                requested_amount: job.requestedAmount,
                maxUsers: job.requestedAmount,
                joinedCount: job.joinedCount,
                joined_count: job.joinedCount,
                joined: job.joinedCount,
                alreadyCount: job.alreadyCount,
                already_count: job.alreadyCount,
                already_member_count: job.alreadyCount,
                alreadyMember: job.alreadyCount,
                failedCount: job.failedCount,
                failed_count: job.failedCount,
                failed: job.failedCount,
                processedCount: job.processedCount,
                processed_count: job.processedCount,
                retryCount: job.retryCount,
                retry_count: job.retryCount,
                currentConcurrency: job.currentConcurrency,
                current_concurrency: job.currentConcurrency,
                currentThroughput: job.currentThroughput || 0,
                current_throughput: job.currentThroughput || 0,
                createdAt: job.createdAt,
                created_at: job.createdAt,
                started_at: job.createdAt,
                completedAt: job.completedAt,
                completed_at: job.completedAt,
                durationMs: job.completedAt && job.createdAt ? Math.max(0, job.completedAt - job.createdAt) : (job.createdAt ? Math.max(0, Date.now() - job.createdAt) : 0),
                duration_ms: job.completedAt && job.createdAt ? Math.max(0, job.completedAt - job.createdAt) : (job.createdAt ? Math.max(0, Date.now() - job.createdAt) : 0)
            };
        };

        const activeFormatted = formatForDashboard(activeJob);
        const lastFormatted = formatForDashboard(lastJob && lastJob.status !== "RUNNING" ? lastJob : null);

        return {
            isRunning: this.isRunning || Boolean(activeJob),
            active: activeFormatted,
            last: lastFormatted,
            activeJob,
            lastCompletedJob: lastJob && lastJob.status !== "RUNNING" ? lastJob : null
        };
    }

    getHistory(repository, { limit = 20, offset = 0 } = {}) {
        if (!repository) return [];
        const raw = repository.listRecentJobs({ limit, offset });
        return raw.map(job => ({
            id: job.id,
            mode: job.mode,
            targetGuildId: job.targetGuildId,
            target_guild_id: job.targetGuildId,
            targetGuildName: job.targetGuildName,
            target_guild_name: job.targetGuildName,
            sourceGuildId: job.sourceGuildId,
            source_guild_id: job.sourceGuildId,
            sourceGuildName: job.sourceGuildName,
            source_guild_name: job.sourceGuildName,
            status: (job.status || "").toLowerCase(),
            requestedAmount: job.requestedAmount,
            requested_amount: job.requestedAmount,
            joinedCount: job.joinedCount,
            joined_count: job.joinedCount,
            alreadyCount: job.alreadyCount,
            already_count: job.alreadyCount,
            already_member_count: job.alreadyCount,
            failedCount: job.failedCount,
            failed_count: job.failedCount,
            processedCount: job.processedCount,
            processed_count: job.processedCount,
            retryCount: job.retryCount,
            retry_count: job.retryCount,
            currentConcurrency: job.currentConcurrency,
            current_concurrency: job.currentConcurrency,
            currentThroughput: job.currentThroughput || 0,
            current_throughput: job.currentThroughput || 0,
            createdAt: job.createdAt,
            created_at: job.createdAt,
            started_at: job.createdAt,
            completedAt: job.completedAt,
            completed_at: job.completedAt,
            durationMs: job.completedAt && job.createdAt ? Math.max(0, job.completedAt - job.createdAt) : (job.createdAt ? Math.max(0, Date.now() - job.createdAt) : 0),
            duration_ms: job.completedAt && job.createdAt ? Math.max(0, job.completedAt - job.createdAt) : (job.createdAt ? Math.max(0, Date.now() - job.createdAt) : 0)
        }));
    }

    getMetrics(repository) {
        if (!repository) return { totalJobs: 0, totalCampaigns: 0, totalJoined: 0, totalProcessed: 0, totalFailed: 0, successRatePercent: 0 };
        return repository.getMetrics();
    }
}

module.exports = new JoinCampaignService();
