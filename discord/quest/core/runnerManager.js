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
const QuestLog = require('../models/QuestLog');
const { sendWebhookEvent } = require('../../core/webhooks');

const activeJobs = new Map(); // key: `${invokerId}:${jobId}` -> { controller, invokerId, ... }
const userLocks = new Map();

async function withUserLock(userId, fn) {
    const prev = userLocks.get(userId) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const next = prev.then(() => gate);
    userLocks.set(userId, next);

    await prev;
    try {
        return await fn();
    } finally {
        release();
        if (userLocks.get(userId) === next) {
            userLocks.delete(userId);
        }
    }
}

function buildStatusText({ username, totalQuests, completedQuests, logs = [] }) {
    const header = [
        `✅ ACCOUNT : ${username || 'กำลังตรวจสอบ...'}`,
        `🔍 บอทตรวจพบ Quest ที่ทำได้ทั้งหมด : ${totalQuests ?? 'กำลังตรวจสอบ...'}`,
        `🎉 บอททำ Quest สำเร็จไปแล้วทั้งหมด : ${completedQuests ?? 0}`,
        '────────────────────────────────────────'
    ];
    const visibleLogs = [...logs].slice(-12);
    return '```\n' + [...header, ...visibleLogs].join('\n') + '\n```';
}

class DmThrottler {
    constructor(dmMessage, intervalMs = 1500) {
        this.dmMessage = dmMessage;
        this.intervalMs = intervalMs;
        this.lastEditTime = 0;
        this.pendingState = null;
        this.timer = null;
        this.isFlushing = false;
    }

    queueUpdate(state) {
        this.pendingState = state;
        const now = Date.now();
        const elapsed = now - this.lastEditTime;

        if (elapsed >= this.intervalMs && !this.isFlushing) {
            this.flush();
        } else if (!this.timer) {
            const waitTime = Math.max(100, this.intervalMs - elapsed);
            this.timer = setTimeout(() => {
                this.timer = null;
                this.flush();
            }, waitTime);
        }
    }

    async flush() {
        if (!this.dmMessage || !this.pendingState || this.isFlushing) return;
        this.isFlushing = true;
        const state = this.pendingState;
        this.pendingState = null;
        this.lastEditTime = Date.now();

        try {
            const content = buildStatusText(state);
            await this.dmMessage.edit({ content });
        } catch (err) {
            console.warn(`[Quest DM update warning]: ${err.message}`);
        } finally {
            this.isFlushing = false;
            if (this.pendingState) {
                this.flush();
            }
        }
    }

    async forceUpdate(state) {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.pendingState = null;
        if (!this.dmMessage) return;

        try {
            const content = buildStatusText(state);
            await this.dmMessage.edit({ content });
            this.lastEditTime = Date.now();
        } catch (err) {
            console.warn(`[Quest DM update warning]: ${err.message}`);
        }
    }
}

async function executeSingleAccountQuest({
    token,
    signal,
    onLogUpdate,
    onProgress
}) {
    const result = {
        targetUserId: null,
        targetUsername: null,
        status: 'running',
        questsFound: 0,
        questsCompleted: 0,
        details: [],
        errorMessage: null
    };

    // 1. Fetch user account
    let me;
    try {
        me = await fetchMe(token, signal);
        result.targetUserId = me.id;
        result.targetUsername = me.username;
        onLogUpdate(`✅ เข้าสู่ระบบสำเร็จ: ${me.username}`);
    } catch (err) {
        result.status = 'failed';
        result.errorMessage = isFatalAuthError(err) ? 'Token ไม่ถูกต้องหรือหมดอายุ' : `เข้าสู่ระบบไม่สำเร็จ: ${err.message}`;
        onLogUpdate(`❌ ${result.errorMessage}`);
        return result;
    }

    // 2. Fetch quests
    let allQuests;
    try {
        onLogUpdate(`🔎 กำลังดึงรายการเควสต์ของ ${me.username}...`);
        allQuests = await fetchQuests(token, signal);
    } catch (err) {
        result.status = 'failed';
        result.errorMessage = `ไม่สามารถดึงรายการเควสต์ได้: ${err.message}`;
        onLogUpdate(`❌ ${result.errorMessage}`);
        return result;
    }

    // Filter runnable quests
    const runnable = allQuests.filter((q) => !q.completed && isRunnableQuest(q));
    result.questsFound = runnable.length;
    onLogUpdate(`🎯 ตรวจพบ ${runnable.length} เควสต์ที่ระบบสามารถทำได้`);

    if (runnable.length === 0) {
        // Also check if any completed quests can be claimed
        const claimable = allQuests.filter((q) => q.completed && !q.claimed);
        for (const q of claimable) {
            try {
                const platform = selectQuestClaimPlatform(q);
                await claimQuest(token, q.id, platform, signal);
                onLogUpdate(`🎁 รับรางวัลเควสต์: ${q.name}`);
            } catch {}
        }
        result.status = 'completed';
        onLogUpdate(`ℹ️ ไม่มีเควสต์ที่ต้องดำเนินการเพิ่มเติมสำหรับบัญชีนี้`);
        return result;
    }

    // 3. Run each quest
    for (const quest of runnable) {
        if (signal.aborted) throw new Error('aborted');

        const questRecord = {
            questId: quest.id,
            questName: quest.name,
            eventName: quest.eventName,
            progress: quest.progressSecs,
            target: quest.secondsNeeded,
            completed: false,
            claimed: false,
            error: null
        };
        result.details.push(questRecord);

        onLogUpdate(`⏭️ กำลังเตรียมเควสต์: ${quest.name}`);

        // Ensure enrollment
        let freshQuest = quest;
        if (!freshQuest.enrolled) {
            try {
                await enrollQuest(token, freshQuest.id, signal);
                freshQuest = await waitForQuestState(token, freshQuest.id, (q) => q.enrolled, signal) || freshQuest;
                onLogUpdate(`📝 กดรับเควสต์: ${quest.name}`);
            } catch (err) {
                questRecord.error = `รับเควสต์ไม่สำเร็จ: ${err.message}`;
                onLogUpdate(`⚠️ ${questRecord.error}`);
                continue;
            }
        }

        // Run progression
        onLogUpdate(`▶️ เริ่มดำเนินการเควสต์: ${quest.name}`);
        const runnerFn = isVideoEvent(quest.eventName) ? runVideoQuest : runGameQuest;

        try {
            let lastReportedPercent = Math.min(100, Math.floor(quest.progress));
            freshQuest = await runnerFn(token, freshQuest, signal, async (fresh) => {
                const pct = fresh.completed ? 100 : Math.min(100, Math.floor(fresh.progress));
                questRecord.progress = fresh.progressSecs;
                questRecord.completed = fresh.completed;
                if (pct >= lastReportedPercent + 25 || fresh.completed) {
                    lastReportedPercent = pct;
                    onLogUpdate(`⌛ ${quest.name}: ${pct}%`);
                }
                if (onProgress) onProgress();
            });

            // Verify completed
            freshQuest = await waitForQuestState(token, quest.id, (q) => q.completed, signal) || freshQuest;

            if (freshQuest.completed) {
                questRecord.completed = true;
                result.questsCompleted++;
                onLogUpdate(`🎉 เควสต์เสร็จสมบูรณ์: ${quest.name}`);

                // Auto claim
                if (!freshQuest.claimed) {
                    try {
                        const platform = selectQuestClaimPlatform(freshQuest);
                        await claimQuest(token, freshQuest.id, platform, signal);
                        questRecord.claimed = true;
                        onLogUpdate(`🎁 รับรางวัลเควสต์สำเร็จ: ${quest.name}`);
                    } catch (claimErr) {
                        onLogUpdate(`⚠️ เคลมรางวัลไม่สำเร็จ (${quest.name}): ${claimErr.message}`);
                    }
                }
            } else {
                questRecord.error = 'Discord ยังไม่ยืนยันความคืบหน้าครบ 100%';
                onLogUpdate(`⚠️ ${questRecord.error}`);
            }
        } catch (err) {
            if (signal.aborted) throw err;
            questRecord.error = err.message;
            onLogUpdate(`❌ เกิดข้อผิดพลาดในเควสต์ ${quest.name}: ${err.message}`);
        }
    }

    result.status = result.questsCompleted > 0 ? 'completed' : 'failed';
    return result;
}

async function startUserQuestSession({
    client,
    invokerId,
    invokerTag,
    guildId = null,
    channelId = null,
    tokens = []
}) {
    return withUserLock(invokerId, async () => {
        const jobId = `${invokerId}_${Date.now()}`;
        const controller = new AbortController();
        const { signal } = controller;

        const jobEntry = { jobId, invokerId, controller, startedAt: new Date() };
        activeJobs.set(jobId, jobEntry);

        // Pre-create database log entry
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
        await questLog.save().catch((err) => console.error('[Quest DB Save Error]:', err));

        // Attempt to establish DM message
        let dmMessage = null;
        let dmError = null;
        try {
            const user = await client.users.fetch(invokerId);
            if (user) {
                const initialText = buildStatusText({
                    username: 'กำลังเริ่มตรวจสอบ...',
                    totalQuests: '...',
                    completedQuests: 0,
                    logs: ['🚀 เริ่มระบบ NeverDie Auto Quest', `📋 รับ Token ทั้งหมด ${tokens.length} บัญชี`]
                });
                dmMessage = await user.send({ content: initialText });
                questLog.dmDelivered = true;
            }
        } catch (err) {
            dmError = err.message;
            questLog.dmDelivered = false;
            questLog.dmError = err.message;
            console.warn(`[Quest DM could not be opened for user ${invokerId}]: ${err.message}`);
        }

        // Emit startup webhook event
        sendWebhookEvent({
            severity: 'INFO',
            category: 'COMMAND',
            code: 'quest.session.started',
            title: '🚀 มีการเริ่มระบบทำ Quest อัตโนมัติ',
            description: `ผู้ใช้ <@${invokerId}> ได้ส่งคำขอทำ Discord Quest`,
            context: {
                'ผู้สั่งการ': `${invokerTag} (${invokerId})`,
                'เซิร์ฟเวอร์': guildId ? `Guild ID: ${guildId}` : 'DM / Direct',
                'จำนวนบัญชี': `${tokens.length} บัญชี`
            },
            dedupeKey: `quest-started:${jobId}`
        }).catch(() => {});

        // Run accounts asynchronously in background
        (async () => {
            const throttler = new DmThrottler(dmMessage, 1500);
            let anySuccess = false;
            let anyFailure = false;
            let totalDoneQuests = 0;

            for (let i = 0; i < tokens.length; i++) {
                if (signal.aborted) break;

                const token = tokens[i];
                const accountLogIndex = i;
                const logs = [`▶️ กำลังดำเนินการบัญชีลำดับที่ ${i + 1}/${tokens.length}`];

                const onLogUpdate = (line) => {
                    logs.push(line);
                    throttler.queueUpdate({
                        username: questLog.accounts[accountLogIndex]?.targetUsername || `บัญชี ${i + 1}`,
                        totalQuests: questLog.accounts[accountLogIndex]?.questsFound ?? '...',
                        completedQuests: totalDoneQuests,
                        logs
                    });
                };

                try {
                    questLog.accounts[accountLogIndex].status = 'running';
                    questLog.accounts[accountLogIndex].startedAt = new Date();
                    await questLog.save().catch(() => {});

                    const accResult = await executeSingleAccountQuest({
                        token,
                        signal,
                        onLogUpdate,
                        onProgress: () => {
                            throttler.queueUpdate({
                                username: questLog.accounts[accountLogIndex]?.targetUsername || `บัญชี ${i + 1}`,
                                totalQuests: questLog.accounts[accountLogIndex]?.questsFound,
                                completedQuests: totalDoneQuests,
                                logs
                            });
                        }
                    });

                    questLog.accounts[accountLogIndex].targetUserId = accResult.targetUserId;
                    questLog.accounts[accountLogIndex].targetUsername = accResult.targetUsername;
                    questLog.accounts[accountLogIndex].status = accResult.status;
                    questLog.accounts[accountLogIndex].questsFound = accResult.questsFound;
                    questLog.accounts[accountLogIndex].questsCompleted = accResult.questsCompleted;
                    questLog.accounts[accountLogIndex].details = accResult.details;
                    questLog.accounts[accountLogIndex].errorMessage = accResult.errorMessage;
                    questLog.accounts[accountLogIndex].finishedAt = new Date();

                    totalDoneQuests += accResult.questsCompleted;
                    if (accResult.status === 'completed') anySuccess = true;
                    else anyFailure = true;

                } catch (accErr) {
                    if (signal.aborted) {
                        questLog.accounts[accountLogIndex].status = 'stopped';
                        questLog.accounts[accountLogIndex].errorMessage = 'ผู้ใช้สั่งหยุดทำงาน (STOP ALL)';
                    } else {
                        questLog.accounts[accountLogIndex].status = 'failed';
                        questLog.accounts[accountLogIndex].errorMessage = accErr.message;
                        anyFailure = true;
                    }
                    questLog.accounts[accountLogIndex].finishedAt = new Date();
                }

                await questLog.save().catch(() => {});
            }

            // Finalize status
            if (signal.aborted) {
                questLog.overallStatus = 'stopped';
            } else if (anySuccess && !anyFailure) {
                questLog.overallStatus = 'completed';
            } else if (anySuccess && anyFailure) {
                questLog.overallStatus = 'partial_failure';
            } else {
                questLog.overallStatus = 'failed';
            }

            await questLog.save().catch(() => {});
            activeJobs.delete(jobId);

            // Final DM update
            if (dmMessage) {
                const finalLogs = [
                    '────────────────────────────────────────',
                    '🏁 ดำเนินการเสร็จสิ้นทุกบัญชีเรียบร้อยแล้ว',
                    `📊 ทำเควสต์สำเร็จทั้งหมด: ${totalDoneQuests} เควสต์`,
                    `สถานะรวม: ${questLog.overallStatus}`
                ];
                await throttler.forceUpdate({
                    username: 'เสร็จสิ้นทั้งหมด',
                    totalQuests: '-',
                    completedQuests: totalDoneQuests,
                    logs: finalLogs
                });
            }

            // Emit completion webhook event
            const finishSeverity = (anyFailure && !anySuccess) ? 'ERROR' : anyFailure ? 'WARNING' : 'SUCCESS';
            sendWebhookEvent({
                severity: finishSeverity,
                category: 'COMMAND',
                code: 'quest.session.finished',
                title: (anyFailure && !anySuccess)
                    ? '❌ การทำ Quest ล้มเหลวทั้งหมด'
                    : anyFailure
                        ? '⚠️ การทำ Quest เสร็จสิ้น (มีข้อผิดพลาดบางส่วน)'
                        : '🎉 การทำ Quest เสร็จสิ้นสมบูรณ์',
                description: `ระบบดำเนินการเควสต์สำหรับ <@${invokerId}> ครบทุกบัญชีแล้ว`,
                context: {
                    'ผู้สั่งการ': `${invokerTag} (${invokerId})`,
                    'สถานะรวม': questLog.overallStatus,
                    'เควสต์สำเร็จทั้งหมด': `${totalDoneQuests} เควสต์`,
                    'จำนวนบัญชี': `${tokens.length} บัญชี`
                },
                dedupeKey: `quest-finished:${jobId}`
            }).catch(() => {});
        })().catch((sessionErr) => {
            console.error('[Quest Session Uncaught Error]:', sessionErr);
            activeJobs.delete(jobId);
        });

        return {
            jobId,
            dmDelivered: Boolean(dmMessage),
            dmError
        };
    });
}

function stopAllUserQuestSessions(invokerId) {
    let stoppedCount = 0;
    for (const [jobId, job] of activeJobs.entries()) {
        if (job.invokerId === invokerId) {
            job.controller.abort();
            activeJobs.delete(jobId);
            stoppedCount++;
        }
    }
    return stoppedCount;
}

function stopAllQuestSessions() {
    let stoppedCount = 0;
    for (const [jobId, job] of activeJobs.entries()) {
        job.controller.abort();
        activeJobs.delete(jobId);
        stoppedCount++;
    }
    return stoppedCount;
}

function getActiveUserJobs(invokerId) {
    return [...activeJobs.values()].filter((j) => j.invokerId === invokerId);
}

module.exports = {
    startUserQuestSession,
    stopAllUserQuestSessions,
    stopAllQuestSessions,
    getActiveUserJobs
};
