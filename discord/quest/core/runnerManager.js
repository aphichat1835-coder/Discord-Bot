'use strict';

const {
    fetchMe,
    fetchQuests,
    fetchFreshQuest,
    waitForQuestState,
    enrollQuest,
    claimQuest,
    selectQuestClaimPlatform,
    runVideoQuest,
    runGameQuest,
    isVideoEvent,
    isRunnableQuest,
    isFatalAuthError
} = require('./questSession');
const { encryptToken, maskToken } = require('./tokenCrypto');
const { formatRunnerStatusContent } = require('./runnerStatusHeader');
const {
    createOneShotQuestSession,
    getNextPendingOneShotQuest,
    markOneShotQuestRunning,
    markOneShotProgressMutationSent,
    recordOneShotVerifiedProgress,
    completeOneShotQuest,
    failOneShotQuest,
    getOneShotSessionSummary,
    isOneShotSessionComplete,
    ONE_SHOT_QUEST_STATUS
} = require('./oneShotSession');
const {
    addScheduleJitter,
    nextScheduledCheck,
    nextRecheckState,
    formatScheduleTime,
    transientRetryDelayMs,
    RECHECK_INTERVAL_MS
} = require('./runnerSchedule');
const {
    createScheduledRunner,
    listScheduledRunners,
    updateScheduledRunner,
    deleteScheduledRunner,
    decryptRunnerRecordToken
} = require('./scheduledRunnerStore');
const {
    withOwnerAdmissionLock,
    withAccountAdmissionLock
} = require('./admissionLock');
const {
    resolveUserDMChannel,
    isPermanentDmError,
    sendQuestSummaryDM,
    sendQuestAuthFailureDM
} = require('./questDm');
const QuestLog = require('../models/QuestLog');
const { sendWebhookEvent } = require('../../core/webhooks');

const jobs = new Map(); // key: jobKey -> jobRecord
const activeRunPromises = new Set();
const RENDER_THROTTLE_MS = 2000;
const CLAIM_RETRY_DELAY_MS = 15 * 60 * 1000;
const CLAIM_LONG_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error('aborted'));
            return;
        }
        let t;
        const onAbort = () => {
            clearTimeout(t);
            reject(new Error('aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        t = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
    });
}

function rethrowFatalAuth(error) {
    if (isFatalAuthError(error)) throw error;
}

function trackRunPromise(promise) {
    activeRunPromises.add(promise);
    const cleanup = () => activeRunPromises.delete(promise);
    promise.then(cleanup, cleanup);
    return promise;
}

function getJob(key) {
    return jobs.get(key) ?? null;
}

function listJobs() {
    return [...jobs.entries()].map(([key, j]) => ({ key, ...j.summary() }));
}

function getUserJobs(ownerId, { mode = null, includeStopping = false } = {}) {
    return [...jobs.entries()]
        .filter(([, job]) => (
            job.ownerId === ownerId
            && (!mode || job.mode === mode)
            && (includeStopping || job.lifecycle !== 'stopping')
        ))
        .map(([key, job]) => ({ key, ...job.summary() }));
}

function findUserJobByAccount(ownerId, accountId) {
    for (const [key, job] of jobs) {
        if (job.ownerId === ownerId && job.accountId === accountId) {
            return { key, ...job.summary() };
        }
    }
    return null;
}

function findAnyJobByAccount(accountId) {
    for (const [key, job] of jobs) {
        if (job.accountId === accountId) return { key, ...job.summary() };
    }
    return null;
}

function stopJob(ownerId, key, { removeSchedule = true } = {}) {
    const job = jobs.get(key);
    if (!job || job.ownerId !== ownerId) return false;
    if (job.lifecycle !== 'stopping') {
        job.lifecycle = 'stopping';
        job.controller.abort();
    }
    if (removeSchedule && job.scheduleId != null) {
        deleteScheduledRunner(job.scheduleId, ownerId).catch(() => {});
    }
    return true;
}

function stopScheduledJob(ownerId, scheduleId) {
    const key = `scheduled:${scheduleId}`;
    const stopped = stopJob(ownerId, key);
    deleteScheduledRunner(scheduleId, ownerId).catch(() => {});
    return stopped;
}

function stopAllForUser(ownerId, { mode = null } = {}) {
    let count = 0;
    for (const [key, job] of jobs) {
        if (job.ownerId !== ownerId || (mode && job.mode !== mode)) continue;
        if (stopJob(ownerId, key)) count++;
    }
    return count;
}

function stopRunner(ownerId, options = {}) {
    return stopAllForUser(ownerId, options) > 0;
}

async function shutdownRunners(timeoutMs = 5000) {
    const activeJobs = [...jobs.values()];
    for (const job of activeJobs) job.controller.abort();

    if (!activeRunPromises.size) return activeJobs.length;

    let timeoutId;
    const timeoutPromise = new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve('timeout'), timeoutMs);
    });

    await Promise.race([
        Promise.allSettled(activeRunPromises),
        timeoutPromise
    ]);

    clearTimeout(timeoutId);
    return activeJobs.length;
}

// ── Core Runner implementation ─────────────────────────────────────────────

async function startRunner({
    jobKey,
    ownerId,
    userToken,
    channelId = null,
    client = null,
    mode = 'oneshot',
    scheduleId = null,
    accountId: initialAccountId = null,
    username: initialUsername = null,
    initialNextCheckAt = null
}) {
    if (jobs.has(jobKey)) throw new Error(`Job ${jobKey} กำลังทำงานอยู่`);
    if (!['oneshot', 'scheduled'].includes(mode)) throw new Error(`Unknown runner mode: ${mode}`);

    const controller = new AbortController();
    const { signal } = controller;

    let liveMsg = null;
    let outputChannel = null;
    let username = initialUsername ?? '...';
    let accountId = initialAccountId;
    let lastRenderAt = 0;
    let pendingTimer = null;
    let flushPromise = Promise.resolve();
    let nextCheckAt = initialNextCheckAt;
    let logoutReported = false;
    let countAlreadyReported = false;
    let oneShotSession = null;
    let oneShotSummaryReported = false;
    const claimRetryAt = new Map();
    const logLines = [];

    function addLog(line) {
        logLines.push(String(line).slice(0, 180));
        if (logLines.length > 25) logLines.shift();
    }

    async function resolveOutputChannel() {
        if (outputChannel?.isTextBased?.()) return outputChannel;
        if (!client) return null;

        // Prefer sending to DM of the owner who started the runner (with timeout guard)
        if (ownerId) {
            const dm = await resolveUserDMChannel(client, ownerId);
            if (dm) {
                outputChannel = dm;
                return outputChannel;
            }
        }

        // Fallback to guild text channel
        if (channelId) {
            const ch = await client.channels.fetch(channelId).catch(() => null);
            if (ch?.isTextBased?.()) {
                outputChannel = ch;
                return outputChannel;
            }
        }
        return null;
    }

    async function flush() {
        const task = flushPromise.then(async () => {
            lastRenderAt = Date.now();
            const visibleLines = [...logLines];
            let rawContent = '```\n' + visibleLines.join('\n') + '\n```';
            const formattedContent = formatRunnerStatusContent(rawContent, {
                loginLine: `✅ LOGIN : ${username}`,
                modeLine: mode === 'scheduled' ? '🤖 AUTO DAILY ENABLED' : null
            });

            const editingExisting = Boolean(liveMsg);
            try {
                if (!liveMsg) {
                    const ch = await resolveOutputChannel();
                    if (!ch?.isTextBased?.()) return;
                    try {
                        liveMsg = await ch.send({ content: formattedContent });
                    } catch (sendErr) {
                        // Fallback to guild channel if DM failed (e.g. user has DMs closed)
                        if (channelId && ch?.id !== channelId) {
                            if (isPermanentDmError(sendErr)) {
                                console.warn(`[Quest Runner:${jobKey}] Permanent DM error (${sendErr.code || sendErr.message}); falling back to guild channel`);
                            }
                            const fallbackCh = await client.channels.fetch(channelId).catch(() => null);
                            if (fallbackCh?.isTextBased?.()) {
                                outputChannel = fallbackCh;
                                liveMsg = await fallbackCh.send({ content: formattedContent });
                            } else {
                                throw sendErr;
                            }
                        } else {
                            throw sendErr;
                        }
                    }
                } else {
                    await liveMsg.edit({ content: formattedContent });
                }
            } catch (err) {
                if (editingExisting) liveMsg = null;
                console.warn(`[Quest Runner:${jobKey}] Status message update failed: ${err.message}`);
            }
        });

        flushPromise = task.catch(() => {});
        await task;
    }

    async function render() {
        const now = Date.now();
        if (liveMsg && now - lastRenderAt < RENDER_THROTTLE_MS) {
            if (!pendingTimer) {
                const wait = RENDER_THROTTLE_MS - (now - lastRenderAt);
                pendingTimer = setTimeout(() => {
                    pendingTimer = null;
                    flush();
                }, wait);
                pendingTimer.unref?.();
            }
            return;
        }
        if (pendingTimer) {
            clearTimeout(pendingTimer);
            pendingTimer = null;
        }
        await flush();
    }

    const jobRecord = {
        ownerId,
        accountId,
        mode,
        scheduleId,
        controller,
        lifecycle: 'running',
        summary: () => ({
            username,
            accountId,
            mode,
            scheduleId,
            lifecycle: jobRecord.lifecycle,
            nextCheckAt,
            status: logLines.at(-1) ?? ''
        })
    };
    jobs.set(jobKey, jobRecord);

    const clearPendingRender = () => {
        if (pendingTimer) {
            clearTimeout(pendingTimer);
            pendingTimer = null;
        }
    };
    signal.addEventListener('abort', clearPendingRender, { once: true });

    function persistSchedule(values = {}) {
        if (mode === 'scheduled' && scheduleId != null) {
            updateScheduledRunner(scheduleId, values).catch(() => {});
        }
    }

    async function claimSilently(quest) {
        if ((claimRetryAt.get(quest.id) ?? 0) > Date.now()) return false;
        const platform = selectQuestClaimPlatform(quest);
        if (platform == null) {
            claimRetryAt.set(quest.id, Date.now() + CLAIM_LONG_RETRY_DELAY_MS);
            return false;
        }

        try {
            await claimQuest(userToken, quest.id, platform, signal);
            const claimed = await waitForQuestState(userToken, quest.id, (fresh) => fresh.claimed, signal);
            if (claimed) {
                claimRetryAt.delete(quest.id);
            } else {
                claimRetryAt.set(quest.id, Date.now() + CLAIM_RETRY_DELAY_MS);
            }
            return Boolean(claimed);
        } catch (error) {
            if (signal.aborted) throw new Error('aborted');
            rethrowFatalAuth(error);
            claimRetryAt.set(quest.id, Date.now() + CLAIM_RETRY_DELAY_MS);
            return false;
        }
    }

    async function reportOneShotLogout() {
        if (mode !== 'oneshot' || logoutReported) return;
        logoutReported = true;
        addLog(`🔒 LOGOUT : ${username}`);
        await flush();
    }

    async function reportRunnableCount(count) {
        addLog(`🔎 ${username}: พบ ${count} QUESTS`);
        await render();
    }

    function questActivityLine(icon, content) {
        return mode === 'oneshot'
            ? `${icon} ${content}`
            : `${icon} ${username}: ${content}`;
    }

    function oneShotSummary() {
        return getOneShotSessionSummary(oneShotSession);
    }

    async function reportOneShotInitialState() {
        const summary = oneShotSummary();
        addLog(`🔎 ${username}: พบ ${summary.totalSupportedQuests} QUESTS`);
        addLog(`🎉 ${username}: ทำสำเร็จ ${summary.completedByBotCount} QUESTS`);
        await flush();
    }

    async function reportOneShotTerminalState() {
        const summary = oneShotSummary();
        addLog(`🔎 ${username}: พบ ${summary.totalSupportedQuests} QUESTS`);
        addLog(`🎉 ${username}: ทำสำเร็จ ${summary.completedByBotCount} QUESTS`);
        addLog('🧹 QUEST ACTIVITY CLEARED');
        await flush();
        return summary;
    }

    function oneShotOutcome() {
        const summary = oneShotSummary();
        return {
            attempted: true,
            progressed: true,
            supportedCount: summary.pendingCount
        };
    }

    async function reportOneShotFailure(quest, reason) {
        if (mode !== 'oneshot') return null;
        failOneShotQuest(oneShotSession, quest.id, reason);
        await reportOneShotTerminalState();
        return oneShotOutcome();
    }

    async function reportOneShotExternalCompletion(quest) {
        if (mode !== 'oneshot') return null;
        completeOneShotQuest(oneShotSession, quest.id);
        await reportOneShotTerminalState();
        return oneShotOutcome();
    }

    async function reportOneShotBotCompletion(quest) {
        if (mode !== 'oneshot') return null;
        const status = completeOneShotQuest(oneShotSession, quest.id);
        if (status !== ONE_SHOT_QUEST_STATUS.COMPLETED_BY_BOT) {
            return reportOneShotExternalCompletion(quest);
        }
        await reportOneShotTerminalState();
        return oneShotOutcome();
    }

    async function reportOneShotSummary() {
        if (mode !== 'oneshot' || oneShotSummaryReported) return;
        oneShotSummaryReported = true;
        const summary = oneShotSummary();
        addLog(`🔎 ${username}: พบ ${summary.totalSupportedQuests} QUESTS`);
        addLog(`🎉 ${username}: ทำสำเร็จ ${summary.completedByBotCount} QUESTS`);
        addLog('🧹 QUEST ACTIVITY CLEARED');

        if (summary.totalSupportedQuests === 0) {
            addLog('ℹ️ ไม่พบ Quest ที่บอทสามารถทำได้ในขณะนี้');
            await flush();
            sendQuestSummaryDM({
                ownerId,
                accountId,
                username,
                mode: 'oneshot',
                totalQuests: 0,
                completedQuests: 0,
                issues: [],
                jobKey
            }).catch(() => {});
            return;
        }

        if (summary.issues.length === 0 && summary.completedByBotCount === summary.totalSupportedQuests) {
            addLog('🎉 บอทได้เข้าไปทำ Quest ทั้งหมดเสร็จสิ้นทั้งหมดแล้ว');
            await flush();
            sendQuestSummaryDM({
                ownerId,
                accountId,
                username,
                mode: 'oneshot',
                totalQuests: summary.totalSupportedQuests,
                completedQuests: summary.completedByBotCount,
                issues: [],
                jobKey
            }).catch(() => {});
            return;
        }

        addLog(summary.completedByBotCount === 0
            ? '❌ บอทไม่สามารถดำเนินการ Quest ให้สำเร็จได้'
            : '⚠️ มีบาง Quest ที่บอทดำเนินการไม่สำเร็จ');
        summary.issues.forEach((issue, index) => {
            addLog(`${index + 1}. ${issue.name}`);
            addLog(`   └ ${issue.reason}`);
        });
        await flush();
        sendQuestSummaryDM({
            ownerId,
            accountId,
            username,
            mode: 'oneshot',
            totalQuests: summary.totalSupportedQuests,
            completedQuests: summary.completedByBotCount,
            issues: summary.issues,
            jobKey
        }).catch(() => {});
    }

    async function prepareOneShotRound(allQuests) {
        if (!oneShotSession) {
            const initialRunnable = allQuests.filter((quest) => !quest.completed && isRunnableQuest(quest));
            oneShotSession = createOneShotQuestSession(initialRunnable);
            await reportOneShotInitialState();
        }
        if (isOneShotSessionComplete(oneShotSession)) {
            return { outcome: { attempted: false, progressed: false, supportedCount: 0 } };
        }

        const initialQuest = getNextPendingOneShotQuest(oneShotSession);
        if (!initialQuest) return { outcome: { attempted: false, progressed: false, supportedCount: 0 } };
        return { runnable: [initialQuest], initialQuest };
    }

    async function claimScheduledCompletions(allQuests) {
        const completed = allQuests.filter((quest) => quest.completed && !quest.claimed);
        for (const quest of completed) {
            if (signal.aborted) throw new Error('aborted');
            await claimSilently(quest);
        }
    }

    async function prepareScheduledRound(allQuests) {
        await claimScheduledCompletions(allQuests);
        const runnable = allQuests.filter((quest) => !quest.completed && isRunnableQuest(quest));
        if (!countAlreadyReported) await reportRunnableCount(runnable.length);
        countAlreadyReported = false;
        if (runnable.length === 0) return { outcome: { attempted: false, progressed: false, supportedCount: 0 } };
        return { runnable, initialQuest: runnable[0] };
    }

    function prepareQuestRound(allQuests) {
        return mode === 'oneshot'
            ? prepareOneShotRound(allQuests)
            : prepareScheduledRound(allQuests);
    }

    async function refreshRoundQuest(selection) {
        try {
            return {
                quest: await fetchFreshQuest(userToken, selection.initialQuest.id, signal)
            };
        } catch (error) {
            rethrowFatalAuth(error);
            if (mode === 'oneshot') {
                return {
                    outcome: await reportOneShotFailure(
                        selection.initialQuest,
                        `ตรวจสอบข้อมูลไม่สำเร็จ: ${error.message}`
                    )
                };
            }
            addLog(`⚠️ ${username}: refresh failed — ${selection.initialQuest.name} — ${error.message}`);
            await render();
            return { outcome: { attempted: true, progressed: false, supportedCount: selection.runnable.length } };
        }
    }

    async function resolveQuestAvailability(quest, selection) {
        if (!quest.completed && isRunnableQuest(quest)) return null;
        if (quest.completed) {
            if (mode === 'oneshot') {
                await claimSilently(quest);
                return reportOneShotExternalCompletion(quest);
            }
            return { attempted: false, progressed: false, supportedCount: selection.runnable.length };
        }
        if (mode === 'oneshot') {
            return reportOneShotFailure(quest, 'Quest ไม่พร้อมให้บอทดำเนินการ');
        }
        return { attempted: false, progressed: false, supportedCount: selection.runnable.length };
    }

    async function announceQuestPreparation(quest) {
        if (mode === 'oneshot') {
            markOneShotQuestRunning(oneShotSession, quest.id, quest.progressSecs);
        }
        addLog(questActivityLine('⏭️', `กำลังเตรียมทำ ${quest.name}`));
        await render();
    }

    async function questFailureOutcome(quest, selection, reason, scheduledMessage) {
        if (mode === 'oneshot') return reportOneShotFailure(quest, reason);
        addLog(scheduledMessage);
        await render();
        return { attempted: true, progressed: false, supportedCount: selection.runnable.length };
    }

    async function ensureQuestEnrollment(quest, selection) {
        if (quest.enrolled) return { quest };
        try {
            await enrollQuest(userToken, quest.id, signal);
            const enrolled = await waitForQuestState(userToken, quest.id, (fresh) => fresh.enrolled, signal);
            if (enrolled) return { quest: enrolled };
            return {
                outcome: await questFailureOutcome(
                    quest,
                    selection,
                    'Discord ยังไม่ยืนยันการรับ Quest',
                    `⚠️ ${username}: ${quest.name} — Discord ยังไม่ยืนยันการรับ Quest`
                )
            };
        } catch (error) {
            rethrowFatalAuth(error);
            return {
                outcome: await questFailureOutcome(
                    quest,
                    selection,
                    'รับ Quest ไม่สำเร็จ',
                    `⚠️ ${username}: enroll failed — ${quest.name} — ${error.message}`
                )
            };
        }
    }

    async function announceQuestProgress(quest) {
        addLog(questActivityLine('▶️', `กำลังทำ ${quest.name}`));
        const initialPercent = Math.min(100, Math.max(0, Math.floor(quest.progress)));
        addLog(questActivityLine('⌛', `${quest.name} ${initialPercent}%`));
        await render();
        return initialPercent;
    }

    function createQuestProgressHooks(quest, initialPercent) {
        let nextCheckpoint = Math.max(25, (Math.floor(initialPercent / 25) + 1) * 25);
        let lastReportedPercent = initialPercent;
        let lastVerifiedProgressSecs = quest.progressSecs;
        let completionSeen = quest.completed;

        const onServerProgress = async (fresh) => {
            const percent = fresh.completed ? 100 : Math.min(100, Math.floor(fresh.progress));
            if (mode === 'oneshot') {
                recordOneShotVerifiedProgress(oneShotSession, quest.id, fresh.progressSecs, {
                    completed: fresh.completed
                });
            }
            lastVerifiedProgressSecs = Math.max(lastVerifiedProgressSecs, fresh.progressSecs);
            completionSeen = completionSeen || fresh.completed;
            while (nextCheckpoint <= 100 && percent >= nextCheckpoint) {
                if (nextCheckpoint > lastReportedPercent) {
                    addLog(questActivityLine('⌛', `${quest.name} ${nextCheckpoint}%`));
                    lastReportedPercent = nextCheckpoint;
                }
                nextCheckpoint += 25;
            }
            await render();
        };

        const onMutationAccepted = () => {
            if (mode === 'oneshot') {
                markOneShotProgressMutationSent(oneShotSession, quest.id);
            }
        };

        return { onServerProgress, onMutationAccepted };
    }

    async function executeQuestProgress(quest, selection, hooks) {
        const runner = isVideoEvent(quest.eventName) ? runVideoQuest : runGameQuest;
        try {
            await runner(
                userToken,
                quest,
                signal,
                hooks.onServerProgress,
                5,
                30,
                hooks.onMutationAccepted
            );
            if (signal.aborted) throw new Error('aborted');
            return null;
        } catch (error) {
            rethrowFatalAuth(error);
            if (signal.aborted) throw new Error('aborted');
            if (mode === 'oneshot') {
                return reportOneShotFailure(quest, 'การส่งความคืบหน้าไม่สำเร็จ');
            }
            addLog(`⚠️ ${username}: ERROR ${error.message}`);
            await render();
            return { attempted: true, progressed: false, supportedCount: selection.runnable.length };
        }
    }

    async function verifyQuestCompletion(quest, selection) {
        try {
            const fresh = await waitForQuestState(userToken, quest.id, (item) => item.completed, signal);
            if (fresh) return { fresh };
            return {
                outcome: await questFailureOutcome(
                    quest,
                    selection,
                    'Discord ยังไม่ยืนยันสถานะเสร็จ',
                    `⚠️ ${username}: ${quest.name} — Discord ยังไม่ส่ง completed_at หลังตรวจ 3 ครั้ง`
                )
            };
        } catch (error) {
            rethrowFatalAuth(error);
            return {
                outcome: await questFailureOutcome(
                    quest,
                    selection,
                    'ตรวจสอบผลลัพธ์กับ Discord ไม่สำเร็จ',
                    `⚠️ ${username}: verify failed — ${error.message}`
                )
            };
        }
    }

    async function finalizeQuestCompletion(fresh, hooks) {
        await hooks.onServerProgress(fresh);
        if (mode === 'oneshot') {
            const status = completeOneShotQuest(oneShotSession, fresh.id);
            await claimSilently(fresh);
            return status === ONE_SHOT_QUEST_STATUS.COMPLETED_BY_BOT
                ? reportOneShotBotCompletion(fresh)
                : reportOneShotExternalCompletion(fresh);
        }

        await claimSilently(fresh);
        const latestQuests = await fetchQuests(userToken, signal);
        const supportedRemaining = latestQuests.filter((item) => !item.completed && isRunnableQuest(item)).length;
        await reportRunnableCount(supportedRemaining);
        countAlreadyReported = true;
        return { attempted: true, progressed: true, supportedCount: supportedRemaining };
    }

    async function runQuestRound() {
        const selection = await prepareQuestRound(await fetchQuests(userToken, signal));
        if (selection.outcome) return selection.outcome;

        const refreshed = await refreshRoundQuest(selection);
        if (refreshed.outcome) return refreshed.outcome;

        const availabilityOutcome = await resolveQuestAvailability(refreshed.quest, selection);
        if (availabilityOutcome) return availabilityOutcome;

        await announceQuestPreparation(refreshed.quest);
        const enrollment = await ensureQuestEnrollment(refreshed.quest, selection);
        if (enrollment.outcome) return enrollment.outcome;

        const initialPercent = await announceQuestProgress(enrollment.quest);
        const hooks = createQuestProgressHooks(enrollment.quest, initialPercent);
        const progressOutcome = await executeQuestProgress(enrollment.quest, selection, hooks);
        if (progressOutcome) return progressOutcome;

        const verification = await verifyQuestCompletion(enrollment.quest, selection);
        if (verification.outcome) return verification.outcome;
        return finalizeQuestCompletion(verification.fresh, hooks);
    }

    async function initializeRunnerSession() {
        if (!accountId || !initialUsername) {
            const me = await fetchMe(userToken, signal);
            username = me.username ?? 'unknown';
            accountId = me.id ?? accountId;
        }
        const job = jobs.get(jobKey);
        if (job) job.accountId = accountId;
        addLog(`✅ LOGIN : ${username}`);
        if (mode === 'scheduled') {
            addLog('🤖 AUTO DAILY ENABLED — CHECK 00:00 / 08:00 / 16:00');
        }
        await render();
    }

    async function restoreInitialSchedule() {
        if (mode !== 'scheduled' || !initialNextCheckAt) return;
        const restoredAt = new Date(initialNextCheckAt);
        if (!Number.isFinite(restoredAt.getTime()) || restoredAt.getTime() <= Date.now()) return;
        nextCheckAt = restoredAt.toISOString();
        addLog(`⏰ ${username}: NEXT CHECK ${formatScheduleTime(restoredAt)}`);
        await render();
        await sleep(restoredAt.getTime() - Date.now(), signal);
    }

    async function runRoundSafely() {
        try {
            const outcome = await runQuestRound();
            persistSchedule({ lastCheckAt: new Date(), lastError: null });
            return outcome;
        } catch (error) {
            if (error.message === 'aborted' || isFatalAuthError(error) || mode === 'oneshot') {
                throw error;
            }
            addLog(`⚠️ ${username}: CHECK ERROR — ${error.message}`);
            await render();
            persistSchedule({
                lastCheckAt: new Date(),
                lastError: error.message
            });
            return {
                attempted: false,
                progressed: false,
                supportedCount: 0,
                transientError: true
            };
        }
    }

    async function waitForTransientErrorRetry(attempt) {
        const delayMs = transientRetryDelayMs(attempt);
        nextCheckAt = new Date(Date.now() + delayMs).toISOString();
        persistSchedule({ nextCheckAt });
        addLog(`🌐 ${username}: NETWORK RETRY — อีก ${Math.round(delayMs / 60000)} นาที`);
        await render();
        countAlreadyReported = false;
        await sleep(delayMs, signal);
        return attempt + 1;
    }

    async function waitForVerificationRecheck(state, outcome) {
        const recheck = nextRecheckState({
            isRecheck: state.isRecheck,
            rechecksRemaining: state.rechecksRemaining,
            attempted: outcome.attempted,
            progressed: outcome.progressed
        });
        if (!recheck.shouldRecheck) return null;

        const checkNumber = 4 - recheck.rechecksRemaining;
        nextCheckAt = new Date(Date.now() + RECHECK_INTERVAL_MS).toISOString();
        persistSchedule({ nextCheckAt });
        addLog(`🔁 ${username}: VERIFY ${checkNumber}/3 — อีก 5 นาที`);
        await render();
        countAlreadyReported = false;
        await sleep(RECHECK_INTERVAL_MS, signal);
        return { isRecheck: true, rechecksRemaining: recheck.rechecksRemaining };
    }

    async function waitForNextScheduledCheck() {
        const scheduledAt = addScheduleJitter(
            nextScheduledCheck(new Date(), 'Asia/Bangkok')
        );
        nextCheckAt = scheduledAt.toISOString();
        persistSchedule({ nextCheckAt });
        addLog(`💤 ${username}: AUTO DAILY ACTIVE`);
        addLog(`⏰ ${username}: NEXT CHECK ${formatScheduleTime(scheduledAt)}`);
        await render();
        countAlreadyReported = false;
        await sleep(scheduledAt.getTime() - Date.now(), signal);
    }

    async function handleScheduledIdle(state, outcome) {
        const recheckState = await waitForVerificationRecheck(state, outcome);
        if (recheckState) return recheckState;
        await waitForNextScheduledCheck();
        return { isRecheck: false, rechecksRemaining: 0 };
    }

    async function executeOneShotModeLoop() {
        let noProgressRounds = 0;
        while (!signal.aborted) {
            const outcome = await runRoundSafely();
            if (signal.aborted || isOneShotSessionComplete(oneShotSession) || outcome.supportedCount === 0) {
                break;
            }
            noProgressRounds = outcome.progressed ? 0 : noProgressRounds + 1;
            if (noProgressRounds >= 3) {
                break;
            }
        }
        await reportOneShotSummary();
        await reportOneShotLogout();
    }

    async function executeScheduledModeLoop() {
        let scheduledState = { isRecheck: false, rechecksRemaining: 0 };
        let transientAttempt = 0;
        while (!signal.aborted) {
            const outcome = await runRoundSafely();
            if (signal.aborted) break;

            if (outcome.transientError) {
                transientAttempt = await waitForTransientErrorRetry(transientAttempt);
                continue;
            }
            transientAttempt = 0;
            scheduledState = await handleScheduledIdle(scheduledState, outcome);
        }
    }

    async function handleRunnerFatalError(err) {
        if (err.message === 'aborted') {
            addLog(`🛑 ${username}: RUNNER STOPPED`);
        } else if (isFatalAuthError(err)) {
            addLog(`🔒 ${username}: AUTH FAILED (Token invalid)`);
            persistSchedule({ lastError: 'Fatal auth failure (token invalid)' });
            sendQuestAuthFailureDM({
                ownerId,
                accountId,
                username,
                jobKey
            }).catch(() => {});
        } else {
            addLog(`❌ ${username}: FATAL ERROR — ${err.message}`);
            persistSchedule({ lastError: err.message });
        }
        await flush();
    }

    // Main execution loop
    const runTask = (async () => {
        try {
            await initializeRunnerSession();
            await restoreInitialSchedule();

            if (mode === 'oneshot') {
                await executeOneShotModeLoop();
            } else {
                await executeScheduledModeLoop();
            }
        } catch (err) {
            await handleRunnerFatalError(err);
        } finally {
            clearPendingRender();
            jobs.delete(jobKey);
        }
    })();

    trackRunPromise(runTask);
    return { jobKey, controller, task: runTask };
}

// ── Restore on startup ─────────────────────────────────────────────────────

async function restoreScheduledRunners(client) {
    let rows = [];
    try {
        rows = await listScheduledRunners();
    } catch (err) {
        console.warn(`[ScheduledRunner] Failed to fetch scheduled runners from DB: ${err.message}`);
        return { restored: 0, failed: 0 };
    }

    if (!rows.length) return { restored: 0, failed: 0 };

    let restored = 0;
    let failed = 0;
    const restoredByOwner = new Map();
    const restoredAccounts = new Set();

    for (const row of rows) {
        const ownerCount = restoredByOwner.get(row.ownerId) ?? 0;
        if (ownerCount >= 10) {
            failed++;
            continue;
        }
        if (restoredAccounts.has(row.accountId)) {
            failed++;
            continue;
        }

        try {
            const token = decryptRunnerRecordToken(row);
            await startRunner({
                jobKey: `scheduled:${row._id}`,
                ownerId: row.ownerId,
                userToken: token,
                channelId: row.channelId,
                client,
                mode: 'scheduled',
                scheduleId: String(row._id),
                accountId: row.accountId,
                username: row.username,
                initialNextCheckAt: row.nextCheckAt ? new Date(row.nextCheckAt).toISOString() : null
            });
            restored++;
            restoredByOwner.set(row.ownerId, ownerCount + 1);
            restoredAccounts.add(row.accountId);
        } catch (err) {
            failed++;
            console.warn(`[ScheduledRunner] Restore failed for ${row.username} (${row._id}): ${err.message}`);
        }
    }

    console.log(`[ScheduledRunner] Restored ${restored} scheduled runner(s) (failed: ${failed})`);
    return { restored, failed };
}

// Compatibility wrapper for user quest session batch
async function startUserQuestSession({
    client,
    invokerId,
    invokerTag,
    guildId = null,
    channelId = null,
    tokens = [],
    mode = 'oneshot'
}) {
    return withOwnerAdmissionLock(invokerId, async () => {
        const results = [];
        let startIndex = Date.now();

        // Create QuestLog document in MongoDB
        const questLog = new QuestLog({
            invokerId,
            invokerTag,
            guildId,
            channelId,
            totalTokens: tokens.length,
            overallStatus: 'in_progress',
            accounts: tokens.map((t) => {
                const encrypted = encryptToken(t, invokerId);
                return {
                    maskedToken: maskToken(t),
                    encryptedToken: encrypted.packed,
                    status: 'pending'
                };
            })
        });
        await questLog.save().catch(() => {});

        // Emit startup webhook event
        sendWebhookEvent({
            severity: 'INFO',
            category: 'COMMAND',
            code: 'quest.session.started',
            title: '🚀 มีการเริ่มระบบทำ Quest อัตโนมัติ',
            description: `ผู้ใช้ <@${invokerId}> ได้ส่งคำขอทำ Discord Quest (โหมด: ${mode})`,
            context: {
                'ผู้สั่งการ': `${invokerTag} (${invokerId})`,
                'เซิร์ฟเวอร์': guildId ? `Guild ID: ${guildId}` : 'Direct',
                'จำนวนบัญชี': `${tokens.length} บัญชี`,
                'โหมด': mode
            },
            dedupeKey: `quest-started:${invokerId}:${startIndex}`
        }).catch(() => {});

        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            try {
                let me;
                try {
                    me = await fetchMe(token);
                } catch (authErr) {
                    results.push({ started: false, line: `❌ Token ลำดับที่ ${i + 1} ไม่ถูกต้องหรือหมดอายุ` });
                    continue;
                }

                const accountId = me.id;
                const username = me.username;

                await withAccountAdmissionLock(accountId, async () => {
                    if (findAnyJobByAccount(accountId)) {
                        results.push({ started: false, line: `⚠️ **${username}** มี Runner ทำงานอยู่แล้วในระบบ` });
                        return;
                    }

                    let scheduleId = null;
                    if (mode === 'scheduled') {
                        const sched = await createScheduledRunner({
                            ownerId: invokerId,
                            guildId,
                            channelId,
                            accountId,
                            username,
                            token
                        });
                        scheduleId = String(sched._id);
                    }

                    const jobKey = mode === 'scheduled'
                        ? `scheduled:${scheduleId}`
                        : `${invokerId}:oneshot:${startIndex++}`;

                    await startRunner({
                        jobKey,
                        ownerId: invokerId,
                        userToken: token,
                        channelId,
                        client,
                        mode,
                        scheduleId,
                        accountId,
                        username
                    });

                    results.push({
                        started: true,
                        username,
                        line: mode === 'scheduled'
                            ? `🤖 เริ่มระบบอัตโนมัติรายวัน: **${username}**\n   ตรวจทันที และตรวจประจำเวลา **00:00 / 08:00 / 16:00 น.**`
                            : `✅ เริ่ม Quest auto : **${username}**`
                    });
                });
            } catch (err) {
                results.push({ started: false, line: `❌ บัญชีลำดับที่ ${i + 1} ไม่สำเร็จ: ${err.message}` });
            }
        }

        return results;
    });
}

module.exports = {
    startRunner,
    getJob,
    listJobs,
    getUserJobs,
    findUserJobByAccount,
    findAnyJobByAccount,
    stopJob,
    stopScheduledJob,
    stopAllForUser,
    stopRunner,
    shutdownRunners,
    restoreScheduledRunners,
    startUserQuestSession
};
