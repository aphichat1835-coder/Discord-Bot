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
    fetchUserStatus,
    restoreUserStatus,
    isFatalAuthError
} = require('./questSession');
const { encryptToken, maskToken } = require('./tokenCrypto');
const tokenCoordinator = require('../../tokens/tokenCoordinator');
const config = require('../../config.json');

try {
    tokenCoordinator.registerSubsystem({
        name: 'questRunner',
        onTokenQuarantined: (tokenHash, reason) => {
            // Quest runner execution detects quarantine on next executeWithToken call and aborts gracefully
        }
    });
} catch {
    // Safe swallow if already registered
}
const {
    formatRunnerStatusContent,
    formatRunnerStatusEmbed,
    formatQuestCurrentTask,
    buildQuestErrorEmbed,
    resolveDiscordAvatarUrl
} = require('./runnerStatusHeader');
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
    RECHECK_INTERVAL_MS,
    zonedParts
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
    buildQuestAuthFailureEmbed,
    buildQuestStoppedEmbed,
    sendQuestSummaryDM,
    sendQuestAuthFailureDM
} = require('./questDm');
const { getQuestLogRepository } = require('../../../database/repositories/quest');
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

function stopJob(ownerId, key, { removeSchedule = true, asAdmin = false } = {}) {
    const job = jobs.get(key);
    if (!job) return false;
    if (!asAdmin && job.ownerId !== ownerId) return false;
    if (job.lifecycle !== 'stopping') {
        job.lifecycle = 'stopping';
        job.controller.abort();
    }
    if (removeSchedule && job.scheduleId != null) {
        deleteScheduledRunner(job.scheduleId, asAdmin ? job.ownerId : ownerId).catch(() => {});
    }
    return true;
}

function stopScheduledJob(ownerId, scheduleId, { asAdmin = false } = {}) {
    const key = `scheduled:${scheduleId}`;
    const stopped = stopJob(ownerId, key, { asAdmin });
    if (!stopped) {
        deleteScheduledRunner(scheduleId, asAdmin ? null : ownerId).catch(() => {});
    }
    return stopped;
}

function stopScheduledJobAsAdmin(scheduleId) {
    return stopScheduledJob(null, scheduleId, { asAdmin: true });
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
    logChannelId = null,
    client = null,
    mode = 'oneshot',
    scheduleId = null,
    accountId: initialAccountId = null,
    username: initialUsername = null,
    avatarUrl: initialAvatarUrl = null,
    initialNextCheckAt = null
}) {
    if (jobs.has(jobKey)) throw new Error(`Job ${jobKey} กำลังทำงานอยู่`);
    if (!['oneshot', 'scheduled'].includes(mode)) throw new Error(`Unknown runner mode: ${mode}`);

    const controller = new AbortController();
    const { signal } = controller;

    let liveMsg = null;
    let outputChannel = null;
    let usingFallbackDm = false;
    let dmDisabled = false;
    let username = initialUsername ?? '...';
    let accountId = initialAccountId;
    let avatarUrl = initialAvatarUrl || null;
    let runnerStatus = 'checking';
    let errorType = null;
    let errorMessage = null;
    let currentTaskText = '-';
    let totalQuestsCount = null;
    let completedQuestsCount = 0;
    const completedQuestNames = [];

    // Auto Daily counters
    let allTimeSupported = 0;
    let allTimeCompleted = 0;
    let todaySupported = null;
    let todayCompleted = null;
    const seenSupportedQuestIds = new Set();

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
        if (dmDisabled) return null;
        if (outputChannel?.isTextBased?.()) return outputChannel;

        if (logChannelId && client && !usingFallbackDm) {
            try {
                const targetCh = client.channels?.cache?.get?.(logChannelId)
                    || await client.channels?.fetch?.(logChannelId).catch(() => null);
                if (targetCh?.isTextBased?.()) {
                    outputChannel = targetCh;
                    return outputChannel;
                }
                console.warn(`[Quest Runner:${jobKey}] Specified log channel ${logChannelId} not found or not text-based; falling back to DM`);
                usingFallbackDm = true;
            } catch (chErr) {
                console.warn(`[Quest Runner:${jobKey}] Failed to fetch channel ${logChannelId}: ${chErr.message}; falling back to DM`);
                usingFallbackDm = true;
            }
        }

        if (!client || !ownerId) return null;

        const dm = await resolveUserDMChannel(client, ownerId);
        if (dm?.isTextBased?.()) {
            outputChannel = dm;
            return outputChannel;
        }
        return null;
    }

    function buildRunnerEmbedState() {
        return {
            ownerId,
            username,
            accountId,
            avatarUrl,
            mode,
            modeLine: mode === 'scheduled' ? '🤖 AUTO DAILY ENABLED' : null,
            nextCheckAt,
            status: signal.aborted ? 'stopped' : runnerStatus,
            errorType,
            errorMessage,
            currentTaskText,
            totalQuests: totalQuestsCount,
            totalQuestCount: totalQuestsCount,
            completedQuests: completedQuestsCount,
            completedQuestCount: completedQuestsCount,
            completedQuestList: [...completedQuestNames],
            allTimeSupported,
            allTimeCompleted,
            todaySupported,
            todayCompleted
        };
    }

    async function handleFlushDeliveryError(err, payload, editingExisting) {
        if (editingExisting) {
            liveMsg = null;
            if (isPermanentDmError(err)) {
                dmDisabled = true;
                outputChannel = null;
            }
        } else {
            if (outputChannel && logChannelId && outputChannel.id === logChannelId && !usingFallbackDm && ownerId && client) {
                console.warn(`[Quest Runner:${jobKey}] Failed to send log to guild channel ${logChannelId} (${err.code || err.message}); falling back to DM`);
                usingFallbackDm = true;
                outputChannel = null;
                try {
                    const dm = await resolveUserDMChannel(client, ownerId);
                    if (dm?.isTextBased?.()) {
                        outputChannel = dm;
                        liveMsg = await dm.send(payload);
                        return;
                    }
                } catch (dmErr) {
                    console.warn(`[Quest Runner:${jobKey}] Fallback to DM also failed (${dmErr.code || dmErr.message})`);
                }
            }
            dmDisabled = true;
            outputChannel = null;
            liveMsg = null;
        }
        console.warn(`[Quest Runner:${jobKey}] Log message update failed (${err.code || err.message}); continuing runner silently without output`);
    }

    async function deliverFlushPayload(payload) {
        if (dmDisabled) return;
        const editingExisting = Boolean(liveMsg);
        try {
            if (!liveMsg) {
                const ch = await resolveOutputChannel();
                if (!ch?.isTextBased?.()) {
                    dmDisabled = true;
                    return;
                }
                liveMsg = await ch.send(payload);
            } else {
                await liveMsg.edit(payload);
            }
        } catch (err) {
            await handleFlushDeliveryError(err, payload, editingExisting);
        }
    }

    async function flush({ silentRollover = false } = {}) {
        const task = flushPromise.then(async () => {
            lastRenderAt = Date.now();
            const visibleLines = [...logLines];
            const rawContent = '```\n' + visibleLines.join('\n') + '\n```';
            const embedState = buildRunnerEmbedState();
            const liveEmbed = formatRunnerStatusEmbed(rawContent, embedState);
            const payload = { embeds: [liveEmbed] };
            if (silentRollover) {
                payload.flags = 4096;
            }
            await deliverFlushPayload(payload);
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
        avatarUrl,
        mode,
        scheduleId,
        controller,
        lifecycle: 'running',
        summary: () => ({
            username,
            accountId,
            avatarUrl,
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
        if (!completedQuestNames.includes(quest.name)) {
            completedQuestNames.push(quest.name);
        }
        completedQuestsCount = completedQuestNames.length;
        completeOneShotQuest(oneShotSession, quest.id);
        await reportOneShotTerminalState();
        return oneShotOutcome();
    }

    async function reportOneShotBotCompletion(quest) {
        if (mode !== 'oneshot') return null;
        if (!completedQuestNames.includes(quest.name)) {
            completedQuestNames.push(quest.name);
        }
        completedQuestsCount = completedQuestNames.length;
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
        const allDone = summary.totalSupportedQuests > 0
            && summary.issues.length === 0
            && completedQuestsCount === summary.totalSupportedQuests;
        if (signal.aborted) {
            runnerStatus = 'stopped';
        } else if (allDone || completedQuestsCount > 0 || summary.totalSupportedQuests === 0) {
            runnerStatus = 'completed';
        } else {
            runnerStatus = 'error';
            errorType = 'EXECUTION_FAILED';
        }
        addLog(`🔎 ${username}: พบ ${summary.totalSupportedQuests} QUESTS`);
        addLog(`🎉 ${username}: ทำสำเร็จ ${completedQuestsCount} QUESTS`);
        addLog('🧹 QUEST ACTIVITY CLEARED');

        let issues = [];
        if (summary.totalSupportedQuests === 0) {
            addLog('ℹ️ ไม่พบ Quest ที่บอทสามารถทำได้ในขณะนี้');
        } else if (summary.issues.length === 0 && completedQuestsCount === summary.totalSupportedQuests) {
            addLog('🎉 บอทได้เข้าไปทำ Quest ทั้งหมดเสร็จสิ้นทั้งหมดแล้ว');
        } else {
            addLog(completedQuestsCount === 0
                ? '❌ บอทไม่สามารถดำเนินการ Quest ให้สำเร็จได้'
                : '⚠️ มีบาง Quest ที่บอทดำเนินการไม่สำเร็จ');
            summary.issues.forEach((issue, index) => {
                addLog(`${index + 1}. ${issue.name}`);
                addLog(`   └ ${issue.reason}`);
            });
            issues = summary.issues;
        }

        if (!dmDisabled) {
            await sendQuestSummaryDM({
                ownerId,
                accountId,
                username,
                avatarUrl,
                mode: 'oneshot',
                totalQuests: totalQuestsCount ?? summary.totalSupportedQuests,
                completedQuests: completedQuestsCount,
                completedQuestList: completedQuestNames,
                issues,
                jobKey,
                targetMessage: liveMsg,
                channelId: usingFallbackDm ? null : logChannelId,
                client
            }).catch(() => {});
        }
    }

    async function prepareOneShotRound(allQuests) {
        if (!oneShotSession) {
            const initialRunnable = allQuests.filter((quest) => !quest.completed && isRunnableQuest(quest));
            totalQuestsCount = initialRunnable.length;
            completedQuestsCount = 0;
            if (initialRunnable.length === 0) {
                runnerStatus = 'error';
                errorType = 'NO_RUNNABLE_QUESTS';
                await flush();
                return { outcome: { attempted: false, progressed: false, supportedCount: 0 } };
            }
            oneShotSession = createOneShotQuestSession(initialRunnable);
            runnerStatus = 'running';
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
        todaySupported = runnable.length;
        for (const quest of runnable) {
            if (!seenSupportedQuestIds.has(quest.id)) {
                seenSupportedQuestIds.add(quest.id);
                allTimeSupported += 1;
            }
        }
        if (!countAlreadyReported) await reportRunnableCount(runnable.length);
        countAlreadyReported = false;
        if (runnable.length === 0) {
            runnerStatus = 'standby';
            currentTaskText = 'เสร็จสิ้นเเล้ววันนี้';
            await flush();
            return { outcome: { attempted: false, progressed: false, supportedCount: 0 } };
        }
        runnerStatus = 'running';
        todayCompleted ??= 0;
        await render();
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
        currentTaskText = formatQuestCurrentTask({ stage: 'preparing', gameName: quest.name });
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
        currentTaskText = formatQuestCurrentTask({ stage: 'doing', gameName: quest.name });
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
            currentTaskText = formatQuestCurrentTask({ stage: 'progress', gameName: quest.name, percent });
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
        if (!completedQuestNames.includes(fresh.name)) {
            completedQuestNames.push(fresh.name);
        }
        if (mode === 'oneshot') {
            completedQuestsCount = completedQuestNames.length;
            const status = completeOneShotQuest(oneShotSession, fresh.id);
            await claimSilently(fresh);
            return status === ONE_SHOT_QUEST_STATUS.COMPLETED_BY_BOT
                ? reportOneShotBotCompletion(fresh)
                : reportOneShotExternalCompletion(fresh);
        }

        todayCompleted = (todayCompleted || 0) + 1;
        allTimeCompleted += 1;
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
        if (!accountId || !initialUsername || !avatarUrl) {
            try {
                const me = await fetchMe(userToken, signal);
                username = me.username ?? username ?? 'unknown';
                accountId = me.id ?? accountId;
                if (!avatarUrl) {
                    avatarUrl = resolveDiscordAvatarUrl(me);
                }
            } catch {
                // Subsequent runner logic handles errors
            }
        }
        const job = jobs.get(jobKey);
        if (job) {
            job.accountId = accountId;
            job.avatarUrl = avatarUrl;
        }
        addLog(`✅ LOGIN : ${username}`);
        if (mode === 'scheduled') {
            addLog('🤖 AUTO DAILY ENABLED — CHECK 00:00 / 08:00 / 16:00');
        }
        runnerStatus = 'checking';
        await flush();
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
        tokenCoordinator.notifyQuestStart(userToken, { mode, username });
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
        } finally {
            tokenCoordinator.notifyQuestEnd(userToken);
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

        const bkkLocal = zonedParts(scheduledAt, 'Asia/Bangkok');
        const isEndOfDayRollover = bkkLocal.hour === 0;
        runnerStatus = 'standby';
        currentTaskText = 'เสร็จสิ้นเเล้ววันนี้';
        if (isEndOfDayRollover && liveMsg) {
            await liveMsg.delete().catch(() => {});
            liveMsg = null;
            todaySupported = 0;
            todayCompleted = 0;
            currentTaskText = '-';
        }

        addLog(`💤 ${username}: AUTO DAILY ACTIVE`);
        addLog(`⏰ ${username}: NEXT CHECK ${formatScheduleTime(scheduledAt)}`);

        if (isEndOfDayRollover) {
            await flush({ silentRollover: true });
        } else {
            await render();
        }

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

    let originalStatus = null;

    async function processScheduledIteration(scheduledState, transientAttempt) {
        const outcome = await runRoundSafely();
        if (signal.aborted) {
            return { aborted: true, scheduledState, transientAttempt };
        }
        if (originalStatus) {
            await restoreUserStatus(userToken, originalStatus).catch(() => {});
        }

        if (outcome.transientError) {
            const nextAttempt = await waitForTransientErrorRetry(transientAttempt);
            return { aborted: false, scheduledState, transientAttempt: nextAttempt };
        }
        const nextState = await handleScheduledIdle(scheduledState, outcome);
        return { aborted: false, scheduledState: nextState, transientAttempt: 0 };
    }

    async function executeScheduledModeLoop() {
        let scheduledState = { isRecheck: false, rechecksRemaining: 0 };
        let transientAttempt = 0;
        while (!signal.aborted) {
            const iter = await processScheduledIteration(scheduledState, transientAttempt);
            if (iter.aborted) break;
            scheduledState = iter.scheduledState;
            transientAttempt = iter.transientAttempt;
        }
    }

    async function handleAbortError() {
        runnerStatus = 'stopped';
        errorType = 'RUNNER_ABORTED';
        addLog(`🛑 ${username}: RUNNER STOPPED`);
        if (liveMsg) {
            const stoppedEmbed = buildQuestStoppedEmbed({
                username,
                accountId,
                ownerId,
                avatarUrl,
                reason: 'ผู้ใช้สั่งหยุดการทำงานของ Quest แล้ว',
                jobKey
            });
            await liveMsg.edit({ embeds: [stoppedEmbed] }).catch(() => {});
        }
    }

    async function handleAuthError(err) {
        runnerStatus = 'error';
        errorType = 'FATAL_AUTH_FAILURE';
        const authReason = err?.code === 'TOKEN_QUARANTINED' ? 'Token quarantined' : 'Token invalid';
        addLog(`🔒 ${username}: AUTH FAILED (${authReason})`);
        persistSchedule({ lastError: `Fatal auth failure (${authReason.toLowerCase()})` });
        if (liveMsg) {
            const authFailEmbed = buildQuestAuthFailureEmbed({
                username,
                accountId,
                ownerId,
                avatarUrl,
                jobKey
            });
            await liveMsg.edit({ embeds: [authFailEmbed] }).catch(() => {});
        }
        if (!dmDisabled) {
            await sendQuestAuthFailureDM({
                ownerId,
                accountId,
                username,
                avatarUrl,
                jobKey
            }).catch(() => {});
        }
    }

    async function handleRateLimitError() {
        runnerStatus = 'error';
        errorType = 'RATE_LIMIT_429';
        addLog(`⚠️ ${username}: RATE LIMIT (429)`);
        if (liveMsg) {
            const rateLimitEmbed = buildQuestErrorEmbed({
                errorType: 'RATE_LIMIT_429',
                ownerId,
                username
            });
            await liveMsg.edit({ embeds: [rateLimitEmbed] }).catch(() => {});
        }
    }

    async function handleExecutionFailure(err) {
        runnerStatus = 'error';
        errorType = 'EXECUTION_FAILED';
        addLog(`❌ ${username}: FATAL ERROR — ${err.message}`);
        persistSchedule({ lastError: err.message });
        if (liveMsg) {
            const execFailEmbed = buildQuestErrorEmbed({
                errorType: 'EXECUTION_FAILED',
                ownerId,
                username
            });
            await liveMsg.edit({ embeds: [execFailEmbed] }).catch(() => {});
        }
        sendWebhookEvent({
            target: 'ALERT',
            severity: 'ERROR',
            category: 'QUEST',
            code: 'quest.runner_system_error',
            state: 'OPEN',
            title: 'QUEST RUNNER CRASH',
            description: `เกิดข้อผิดพลาดร้ายแรงใน Quest Runner: ${err.message}`,
            impact: `Quest Runner ของผู้ใช้ ${username} หยุดการทำงานกะทันหัน`,
            action: 'ตรวจสอบข้อผิดพลาดและ stack trace ในระบบ Quest',
            context: {
                'บัญชี': `${username} (${accountId})`,
                'ผู้สั่งการ': ownerId,
                'โหมด': mode,
                'รหัสข้อผิดพลาด': String(err?.code || err?.name || 'runner_error')
            },
            dedupeKey: `quest-runner-error:${accountId}:${err.message}`,
            dedupeMs: 5 * 60 * 1000
        }).catch(() => {});
    }

    async function handleRunnerFatalError(err) {
        if (err.message === 'aborted') {
            const hadLiveMsg = Boolean(liveMsg);
            await handleAbortError();
            if (hadLiveMsg) return;
        } else if (isFatalAuthError(err)) {
            await handleAuthError(err);
        } else if (err?.status === 429 || err?.code === 429 || String(err?.message).includes('429')) {
            await handleRateLimitError();
        } else {
            await handleExecutionFailure(err);
        }
        await flush();
    }

    // Main execution loop
    const runTask = (async () => {
        try {
            originalStatus = await fetchUserStatus(userToken, signal);
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
            if (originalStatus) {
                await restoreUserStatus(userToken, originalStatus).catch(() => {});
            }
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
            const targetLogChannelId = (row.channelId && row.channelId !== 'dm') ? row.channelId : null;
            await startRunner({
                jobKey: `scheduled:${row._id}`,
                ownerId: row.ownerId,
                userToken: token,
                channelId: targetLogChannelId,
                logChannelId: targetLogChannelId,
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
    logChannelId = null,
    tokens = [],
    mode = 'oneshot'
}) {
    return withOwnerAdmissionLock(invokerId, async () => {
        const results = [];
        let startIndex = Date.now();

        // Create QuestLog in SQLite
        try {
            getQuestLogRepository().create({
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
        } catch (_err) {
            // Ignored: Best-effort audit logging into QuestLogRepository
        }

        // Emit startup webhook event
        sendWebhookEvent({
            severity: 'INFO',
            category: 'QUEST',
            code: 'quest.session.started',
            title: `${config.emojis?.boost || '🚀'} มีการเริ่มระบบทำ Quest อัตโนมัติ`,
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
                    results.push({ started: false, line: `${config.emojis?.red_card || config.emojis?.error || '❌'} Token ลำดับที่ ${i + 1} ไม่ถูกต้องหรือหมดอายุ` });
                    continue;
                }

                const accountId = me.id;
                const username = me.username;
                const avatarUrl = resolveDiscordAvatarUrl(me);

                await withAccountAdmissionLock(accountId, async () => {
                    if (findAnyJobByAccount(accountId)) {
                        results.push({ started: false, line: `${config.emojis?.warning || '⚠️'} **${username}** : Token นี้ กำลังทำงานอยู่เเล้วในระบบ` });
                        return;
                    }

                    let scheduleId = null;
                    if (mode === 'scheduled') {
                        const sched = await createScheduledRunner({
                            ownerId: invokerId,
                            guildId,
                            channelId: logChannelId || 'dm',
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
                        logChannelId,
                        client,
                        mode,
                        scheduleId,
                        accountId,
                        username,
                        avatarUrl
                    });

                    results.push({
                        started: true,
                        username,
                        line: mode === 'scheduled'
                            ? `🤖 เริ่มระบบอัตโนมัติรายวัน: **${username}**\n   ตรวจทันที และตรวจประจำเวลา **00:00 / 08:00 / 16:00 น.**`
                            : `${config.emojis?.check_alt || config.emojis?.success || '✅'} เริ่ม Quest auto : **${username}**`
                    });
                });
            } catch (err) {
                results.push({ started: false, line: `${config.emojis?.red_card || config.emojis?.error || '❌'} บัญชีลำดับที่ ${i + 1} ไม่สำเร็จ: ${err.message}` });
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
    stopScheduledJobAsAdmin,
    stopAllForUser,
    stopRunner,
    shutdownRunners,
    restoreScheduledRunners,
    startUserQuestSession
};
