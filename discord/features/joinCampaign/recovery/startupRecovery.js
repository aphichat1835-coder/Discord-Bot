"use strict";

const campaignWorker = require("../worker/campaignWorker");
const { getLiveTargetMemberIds } = require("../services/preflightService");
const { sanitizeUserFacingError } = require("../worker/batchLogger");

const MAX_RECOVERY_ATTEMPTS = 5;

function dispatchRecoveryAlert({ code, title, description, details = {} }) {
    try {
        const { sendWebhookEvent } = require("../../../core/webhooks");
        if (typeof sendWebhookEvent === "function") {
            sendWebhookEvent({
                category: "SYSTEM",
                severity: "CRITICAL",
                actionRequired: true,
                code: code || "join_campaign.recovery_failed",
                title: title || "Join Campaign: การกู้คืนล้มเหลว",
                description: description || "เกิดข้อผิดพลาดในการกู้คืนงานเดิม",
                fields: Object.entries(details).map(([name, value]) => ({
                    name,
                    value: String(value),
                    inline: true
                }))
            });
        }
    } catch (_) {}
}

async function updatePanelRecoveryFailure({ client, repository, jobId, channelId, errorMsg, targetGuildName }) {
    try {
        if (!repository) return;
        const panel = (channelId && repository.findPanelByChannelId)
            ? repository.findPanelByChannelId(channelId)
            : (jobId && repository.findPanelByActiveJobId ? repository.findPanelByActiveJobId(jobId) : null);
        if (!panel) return;

        const sanitizedError = sanitizeUserFacingError(errorMsg);
        const summaryText = sanitizedError.startsWith("เกิดข้อผิดพลาด")
            ? sanitizedError
            : `เกิดข้อผิดพลาดในการกู้คืนงาน: ${sanitizedError}`;
        const updatedPanel = {
            ...panel,
            activeJobId: null,
            lastStatusSummary: summaryText
        };

        if (repository.savePanel) {
            repository.savePanel(updatedPanel);
        }

        if (client && panel.channelId && panel.messageId) {
            const channel = await client.channels?.fetch?.(panel.channelId).catch(() => null);
            if (channel) {
                const message = await channel.messages?.fetch?.(panel.messageId).catch(() => null);
                if (message) {
                    const { getMode } = require("../modes/modeRegistry");
                    const { buildPanelPayload } = require("../ui/panelBuilder");
                    const mode = getMode(panel.mode || "ALL_TO_TARGET");
                    const payload = buildPanelPayload({
                        mode,
                        panelState: updatedPanel,
                        readyCount: updatedPanel.lastReadyCount,
                        liveJob: null,
                        targetGuildName: targetGuildName || panel.targetGuildId || "เซิร์ฟเวอร์เป้าหมาย"
                    });
                    await message.edit(payload).catch(() => {});
                }
            }
        }
    } catch (_) {}
}

let activeRecoveryPromise = null;

function runStartupRecovery({ client, repository, tokenManager, discord }) {
    if (!repository || typeof repository.findActiveRunningJob !== "function") {
        return Promise.resolve({ recovered: false, reason: "no_repository" });
    }

    if (activeRecoveryPromise) {
        return activeRecoveryPromise;
    }

    activeRecoveryPromise = (async () => {
        try {
            const interruptedJob = repository.findActiveRunningJob();
            if (!interruptedJob) {
                return { recovered: false, reason: "no_interrupted_jobs" };
            }

            // 1. Expire stale pre-start STAGE jobs that were left in-flight during crash/restart
            if (interruptedJob.status === "STAGE") {
                const expireReason = "staged_job_expired";
                console.warn(`[JoinCampaign] ⚠️ งาน ${interruptedJob.id} อยู่ในสถานะ STAGE ก่อนรีสตาร์ต — ยกเลิกงานที่ค้างในขั้นตอนเตรียมการ`);
                repository.updateJob(interruptedJob.id, {
                    status: "FAILED",
                    lastError: expireReason,
                    completedAt: Date.now()
                });
                await updatePanelRecoveryFailure({
                    client,
                    repository,
                    jobId: interruptedJob.id,
                    channelId: interruptedJob.startedByChannelId,
                    errorMsg: "งานในขั้นตอนเตรียมการหมดอายุจากการรีสตาร์ต",
                    targetGuildName: interruptedJob.targetGuildName
                });
                return { recovered: false, reason: "staged_job_expired", jobId: interruptedJob.id };
            }

            // 2. Atomic claim on orphaned RUNNING jobs left from hard crash/SIGKILL
            if (interruptedJob.status === "RUNNING") {
                if (typeof repository.claimOrphanedRunningJob === "function") {
                    const claimedRunning = repository.claimOrphanedRunningJob(interruptedJob.id);
                    if (!claimedRunning) {
                        return { recovered: false, reason: "running_job_already_claimed" };
                    }
                    interruptedJob.status = "INTERRUPTED";
                    console.warn(`[JoinCampaign] ⚠️ ตรวจพบงานที่ค้างในสถานะ RUNNING จาก Hard Crash/Kill: ${interruptedJob.id} -> เปลี่ยนเป็น INTERRUPTED เพื่อกู้คืน`);
                }
            }

            // 3. Atomic claim on interrupted job to prevent concurrent recovery execution
            if (typeof repository.claimInterruptedJob === "function" && interruptedJob.status === "INTERRUPTED") {
                const claimed = repository.claimInterruptedJob(interruptedJob.id);
                if (!claimed) {
                    return { recovered: false, reason: "job_already_claimed" };
                }
                interruptedJob.status = "RUNNING";
            }

            const currentRecoveryCount = interruptedJob.recoveryCount || interruptedJob.recovery_count || 0;
            if (currentRecoveryCount >= MAX_RECOVERY_ATTEMPTS) {
                const failReason = `กู้คืนเกินขีดจำกัด ${MAX_RECOVERY_ATTEMPTS} ครั้ง`;
                console.warn(`[JoinCampaign] ⚠️ งาน ${interruptedJob.id} ถูกกู้คืนเกินขีดจำกัด (${MAX_RECOVERY_ATTEMPTS} ครั้ง) ยกเลิกการกู้คืนเพื่อความปลอดภัย`);
                repository.updateJob(interruptedJob.id, {
                    status: "FAILED",
                    lastError: failReason,
                    completedAt: Date.now()
                });
                await updatePanelRecoveryFailure({
                    client,
                    repository,
                    jobId: interruptedJob.id,
                    channelId: interruptedJob.startedByChannelId,
                    errorMsg: failReason,
                    targetGuildName: interruptedJob.targetGuildName
                });
                dispatchRecoveryAlert({
                    code: "join_campaign.max_recovery_exceeded",
                    title: "Join Campaign: การกู้คืนล้มเหลวเกินกำหนด",
                    description: `งาน ${interruptedJob.id} ถูกกู้คืนเกินขีดจำกัด ${MAX_RECOVERY_ATTEMPTS} ครั้งและถูกยกเลิก`,
                    details: {
                        campaignId: interruptedJob.id,
                        targetGuildId: interruptedJob.targetGuildId,
                        recoveryAttempts: currentRecoveryCount
                    }
                });
                return { recovered: false, reason: "max_recovery_exceeded" };
            }

            // Reconcile job counters with actual item status records to guarantee crash-consistency (P1 #1)
            if (typeof repository.reconcileJobCounters === "function") {
                const reconciled = repository.reconcileJobCounters(interruptedJob.id);
                if (reconciled) {
                    interruptedJob.joinedCount = reconciled.joinedCount;
                    interruptedJob.alreadyCount = reconciled.alreadyCount;
                    interruptedJob.failedCount = reconciled.failedCount;
                    interruptedJob.processedCount = reconciled.processedCount;
                }
            }

            // Reconnect panel channel ID if not set directly on job (P1 #3)
            if (!interruptedJob.startedByChannelId && typeof repository.findPanelByActiveJobId === "function") {
                const associatedPanel = repository.findPanelByActiveJobId(interruptedJob.id);
                if (associatedPanel?.channelId) {
                    interruptedJob.startedByChannelId = associatedPanel.channelId;
                    try {
                        repository.updateJob(interruptedJob.id, { startedByChannelId: associatedPanel.channelId });
                    } catch (_) {}
                }
            }

            console.log(`[JoinCampaign] 🔄 ตรวจพบงานที่ค้างอยู่จากการรีสตาร์ต: ${interruptedJob.id} (สำเร็จแล้ว ${interruptedJob.joinedCount}/${interruptedJob.requestedAmount})`);
            console.log(`[JoinCampaign] ℹ️ งานเดิมถูกกู้คืนแล้ว (Webhook URL ไม่ได้ถูกบันทึกลงฐานข้อมูลตามนโยบายความปลอดภัย จึงไม่สามารถส่งความคืบหน้าผ่าน Webhook เดิมได้)`);

            // 1. Release all leased items back to PENDING
            if (typeof repository.releaseExpiredLeases === "function") {
                repository.releaseExpiredLeases(interruptedJob.id, true);
            }

        // 2. Increment recovery count
        const nextRecoveryCount = currentRecoveryCount + 1;
        repository.updateJob(interruptedJob.id, {
            recovery_count: nextRecoveryCount,
            status: "RUNNING"
        });
        interruptedJob.recoveryCount = nextRecoveryCount;
        interruptedJob.recovery_count = nextRecoveryCount;

        // 3. Fetch current target guild members to avoid redundant joins (Fail-closed)
        let targetMemberIds = null;
        if (client && interruptedJob.targetGuildId) {
            let targetGuild = client.guilds.cache.get(interruptedJob.targetGuildId);
            if (!targetGuild && client.guilds?.fetch) {
                targetGuild = await client.guilds.fetch(interruptedJob.targetGuildId).catch(() => null);
            }
            if (!targetGuild) {
                const failMsg = "ไม่พบเซิร์ฟเวอร์ปลายทาง หรือบอทไม่ได้อยู่ในเซิร์ฟเวอร์เป้าหมายแล้ว (Fail-Closed)";
                console.error(`[JoinCampaign] ❌ ${failMsg}`);
                repository.updateJob(interruptedJob.id, {
                    status: "FAILED",
                    lastError: failMsg,
                    completedAt: Date.now()
                });
                await updatePanelRecoveryFailure({
                    client,
                    repository,
                    jobId: interruptedJob.id,
                    channelId: interruptedJob.startedByChannelId,
                    errorMsg: failMsg,
                    targetGuildName: interruptedJob.targetGuildName
                });
                dispatchRecoveryAlert({
                    code: "join_campaign.recovery_target_missing",
                    title: "Join Campaign: เซิร์ฟเวอร์เป้าหมายไม่พร้อมใช้งานขณะกู้คืน",
                    description: failMsg,
                    details: {
                        campaignId: interruptedJob.id,
                        targetGuildId: interruptedJob.targetGuildId
                    }
                });
                return { recovered: false, error: failMsg, jobId: interruptedJob.id };
            }
            try {
                targetMemberIds = await getLiveTargetMemberIds(targetGuild);
            } catch (err) {
                const failMsg = `ไม่สามารถดึงรายชื่อสมาชิกปัจจุบันของเซิร์ฟเวอร์ปลายทางได้: ${sanitizeUserFacingError(err.message)}`;
                console.error(`[JoinCampaign] ❌ ${failMsg}`);
                repository.updateJob(interruptedJob.id, {
                    status: "FAILED",
                    lastError: failMsg,
                    completedAt: Date.now()
                });
                await updatePanelRecoveryFailure({
                    client,
                    repository,
                    jobId: interruptedJob.id,
                    channelId: interruptedJob.startedByChannelId,
                    errorMsg: failMsg,
                    targetGuildName: interruptedJob.targetGuildName
                });
                dispatchRecoveryAlert({
                    code: "join_campaign.recovery_member_fetch_failed",
                    title: "Join Campaign: ตรวจสอบรายชื่อสมาชิกล้มเหลวขณะกู้คืน",
                    description: err.message || failMsg,
                    details: {
                        campaignId: interruptedJob.id,
                        targetGuildId: interruptedJob.targetGuildId
                    }
                });
                return { recovered: false, error: failMsg, jobId: interruptedJob.id };
            }
        }

        // 4. Auto-resume campaign worker asynchronously
        let workerPromise = null;
        try {
            const startResult = await campaignWorker.startWorker({
                job: interruptedJob,
                client,
                repository,
                targetMemberIds,
                ...(tokenManager ? { tokenManager } : {}),
                ...(discord ? { discord } : {})
            });
            workerPromise = startResult?.workerPromise || null;
            if (!workerPromise) {
                throw new Error("Worker promise was null or undefined");
            }
        } catch (err) {
            console.error(`[JoinCampaign] ❌ ไม่สามารถกู้คืนงานเดิมได้:`, err.message);
            const failMsg = `กู้คืนงานเดิมไม่สำเร็จ: ${sanitizeUserFacingError(err.message)}`;
            repository.updateJob(interruptedJob.id, {
                status: "FAILED",
                lastError: failMsg,
                completedAt: Date.now()
            });
            await updatePanelRecoveryFailure({
                client,
                repository,
                jobId: interruptedJob.id,
                channelId: interruptedJob.startedByChannelId,
                errorMsg: failMsg,
                targetGuildName: interruptedJob.targetGuildName
            });
            dispatchRecoveryAlert({
                code: "join_campaign.recovery_worker_start_failed",
                title: "Join Campaign: ไม่สามารถเริ่ม Worker กู้คืนได้",
                description: err.message,
                details: {
                    campaignId: interruptedJob.id,
                    targetGuildId: interruptedJob.targetGuildId
                }
            });
            return { recovered: false, error: failMsg, jobId: interruptedJob.id };
        }

        return { recovered: true, jobId: interruptedJob.id, workerPromise };
        } catch (err) {
            console.error(`[JoinCampaign] ❌ เกิดข้อผิดพลาดในการตรวจสอบงานค้าง:`, err.message);
            const userError = sanitizeUserFacingError(err.message);
            dispatchRecoveryAlert({
                code: "join_campaign.recovery_error",
                title: "Join Campaign: เกิดข้อผิดพลาดร้ายแรงขณะกู้คืน",
                description: err.message
            });
            return { recovered: false, error: userError };
        }
    })().finally(() => {
        activeRecoveryPromise = null;
    });

    return activeRecoveryPromise;
}

module.exports = {
    runStartupRecovery
};
