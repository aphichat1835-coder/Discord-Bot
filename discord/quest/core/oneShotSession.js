'use strict';

const ONE_SHOT_QUEST_STATUS = Object.freeze({
    PENDING: 'pending',
    RUNNING: 'running',
    COMPLETED_BY_BOT: 'completed_by_bot',
    COMPLETED_EXTERNAL: 'completed_external',
    FAILED: 'failed'
});

const EXTERNAL_COMPLETION_REASON = 'Quest เสร็จจากภายนอก จึงไม่นับเป็น Quest ที่บอททำ';

const TERMINAL_STATUSES = new Set([
    ONE_SHOT_QUEST_STATUS.COMPLETED_BY_BOT,
    ONE_SHOT_QUEST_STATUS.COMPLETED_EXTERNAL,
    ONE_SHOT_QUEST_STATUS.FAILED
]);

function normalizeProgress(value) {
    const progress = Number(value);
    return Number.isFinite(progress) && progress >= 0 ? progress : 0;
}

function getRequiredQuest(session, questId) {
    const quest = session?.quests?.get(questId);
    if (!quest) throw new Error(`Quest ${questId} is not part of this one-shot session`);
    return quest;
}

function isTerminalStatus(status) {
    return TERMINAL_STATUSES.has(status);
}

function createOneShotQuestSession(quests) {
    const questOrder = [];
    const questMap = new Map();

    for (const quest of quests ?? []) {
        const id = String(quest?.id ?? '').trim();
        if (!id || questMap.has(id)) continue;
        const initialProgressSecs = normalizeProgress(quest.progressSecs);
        questOrder.push(id);
        questMap.set(id, {
            id,
            name: String(quest.name || id),
            eventName: String(quest.eventName || 'UNKNOWN'),
            initialProgressSecs,
            lastVerifiedProgressSecs: initialProgressSecs,
            status: ONE_SHOT_QUEST_STATUS.PENDING,
            attemptStarted: false,
            progressMutationSent: false,
            botProgressVerified: false,
            reason: null
        });
    }

    return {
        questOrder,
        quests: questMap,
        totalSupportedQuests: questOrder.length
    };
}

function hasOneShotQuest(session, questId) {
    return Boolean(session?.quests?.has(questId));
}

function getOneShotQuest(session, questId) {
    return getRequiredQuest(session, questId);
}

function getNextPendingOneShotQuest(session) {
    for (const questId of session?.questOrder ?? []) {
        const quest = session.quests.get(questId);
        if (quest?.status === ONE_SHOT_QUEST_STATUS.PENDING) return quest;
    }
    return null;
}

function markOneShotQuestRunning(session, questId, progressSecs = null) {
    const quest = getRequiredQuest(session, questId);
    if (isTerminalStatus(quest.status)) return false;
    if (quest.status === ONE_SHOT_QUEST_STATUS.PENDING) {
        quest.status = ONE_SHOT_QUEST_STATUS.RUNNING;
        quest.attemptStarted = true;
    }
    const currentProgress = normalizeProgress(progressSecs);
    quest.initialProgressSecs = Math.max(quest.initialProgressSecs, currentProgress);
    quest.lastVerifiedProgressSecs = Math.max(quest.lastVerifiedProgressSecs, currentProgress);
    return true;
}

function markOneShotProgressMutationSent(session, questId) {
    const quest = getRequiredQuest(session, questId);
    if (quest.status !== ONE_SHOT_QUEST_STATUS.RUNNING) return false;
    quest.progressMutationSent = true;
    return true;
}

function recordOneShotVerifiedProgress(
    session,
    questId,
    progressSecs,
    { completed = false } = {}
) {
    const quest = getRequiredQuest(session, questId);
    if (quest.status !== ONE_SHOT_QUEST_STATUS.RUNNING || !quest.progressMutationSent) {
        return false;
    }

    const progress = normalizeProgress(progressSecs);
    const increased = progress > quest.lastVerifiedProgressSecs;
    if (!increased && !completed) return false;

    quest.lastVerifiedProgressSecs = Math.max(quest.lastVerifiedProgressSecs, progress);
    quest.botProgressVerified = true;
    return true;
}

function completeOneShotQuest(session, questId) {
    const quest = getRequiredQuest(session, questId);
    if (isTerminalStatus(quest.status)) return quest.status;

    const completedByBot = quest.status === ONE_SHOT_QUEST_STATUS.RUNNING
        && quest.attemptStarted
        && quest.progressMutationSent
        && quest.botProgressVerified;

    quest.status = completedByBot
        ? ONE_SHOT_QUEST_STATUS.COMPLETED_BY_BOT
        : ONE_SHOT_QUEST_STATUS.COMPLETED_EXTERNAL;
    quest.reason = completedByBot ? null : EXTERNAL_COMPLETION_REASON;
    return quest.status;
}

function failOneShotQuest(session, questId, reason) {
    const quest = getRequiredQuest(session, questId);
    if (isTerminalStatus(quest.status)) return false;
    quest.status = ONE_SHOT_QUEST_STATUS.FAILED;
    quest.reason = String(reason || 'ไม่สามารถดำเนินการ Quest ได้');
    return true;
}

function getOneShotSessionSummary(session) {
    const summary = {
        totalSupportedQuests: session?.totalSupportedQuests ?? 0,
        completedByBotCount: 0,
        completedExternalCount: 0,
        failedCount: 0,
        pendingCount: 0,
        issues: []
    };

    for (const questId of session?.questOrder ?? []) {
        const quest = session.quests.get(questId);
        if (!quest) continue;
        switch (quest.status) {
            case ONE_SHOT_QUEST_STATUS.COMPLETED_BY_BOT:
                summary.completedByBotCount++;
                break;
            case ONE_SHOT_QUEST_STATUS.COMPLETED_EXTERNAL:
                summary.completedExternalCount++;
                summary.issues.push({ id: quest.id, name: quest.name, reason: quest.reason });
                break;
            case ONE_SHOT_QUEST_STATUS.FAILED:
                summary.failedCount++;
                summary.issues.push({ id: quest.id, name: quest.name, reason: quest.reason });
                break;
            default:
                summary.pendingCount++;
        }
    }
    return summary;
}

function isOneShotSessionComplete(session) {
    return getOneShotSessionSummary(session).pendingCount === 0;
}

module.exports = {
    ONE_SHOT_QUEST_STATUS,
    EXTERNAL_COMPLETION_REASON,
    createOneShotQuestSession,
    hasOneShotQuest,
    getOneShotQuest,
    getNextPendingOneShotQuest,
    markOneShotQuestRunning,
    markOneShotProgressMutationSent,
    recordOneShotVerifiedProgress,
    completeOneShotQuest,
    failOneShotQuest,
    getOneShotSessionSummary,
    isOneShotSessionComplete
};
