'use strict';

const crypto = require('node:crypto');
const { buildUserHeaders } = require('./clientProfile');
const { fetchWithRetry } = require('../utils/httpRetry');
const { abortableDelay, abortFailure } = require('../utils/abortableDelay');

const DISCORD_API = 'https://discord.com/api/v9';
const QUEST_LIST_PATHS = ['/quests/@me', '/users/@me/quests'];
const FATAL_FORBIDDEN_PATHS = new Set(['/users/@me', ...QUEST_LIST_PATHS]);

class DiscordApiError extends Error {
    constructor(status, path, data) {
        super(`Discord API ${status} at ${path}`);
        this.name = 'DiscordApiError';
        this.status = status;
        this.path = path;
        this.data = data;
        this.fatalAuth = status === 401 || (status === 403 && FATAL_FORBIDDEN_PATHS.has(path));
    }
}

class QuestCompatibilityError extends Error {
    constructor(message) {
        super(message);
        this.name = 'QuestCompatibilityError';
    }
}

function isFatalAuthError(error) {
    return error?.fatalAuth === true;
}

function sleep(ms, signal) {
    return abortableDelay(ms, signal);
}

async function discordFetch(token, path, options = {}, policy = {}) {
    const { headers = {}, ...requestOptions } = options;
    const method = String(requestOptions.method ?? 'GET').toUpperCase();
    const requestPolicy = method === 'POST'
        ? { ...policy, retryRateLimits: false }
        : policy;

    const res = await fetchWithRetry(`${DISCORD_API}${path}`, {
        ...requestOptions,
        headers: { ...buildUserHeaders(token, path), ...headers }
    }, requestPolicy);

    if (res.status === 204) return { ok: true, status: 204 };
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) {
        throw new DiscordApiError(res.status, path, data);
    }
    return data;
}

const VIDEO_EVENTS  = new Set(['WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE']);
const GAME_EVENTS   = new Set(['PLAY_ON_DESKTOP', 'PLAY_ON_DESKTOP_V2']);
const STREAM_EVENTS = new Set(['STREAM_ON_DESKTOP']);
const SKIP_EVENTS   = new Set([
    'ACHIEVEMENT_IN_GAME', 'ACHIEVEMENT_IN_ACTIVITY', 'PLAY_ACTIVITY',
    'PLAY_ON_XBOX', 'PLAY_ON_PLAYSTATION', 'progress',
    ...STREAM_EVENTS
]);

function isVideoEvent(eventName) {
    return VIDEO_EVENTS.has(eventName) || /^WATCH_VIDEO(?:_|$)/.test(eventName);
}

function isGameEvent(eventName) {
    return GAME_EVENTS.has(eventName) || /^PLAY_ON_DESKTOP(?:_V\d+)?$/.test(eventName);
}

function isSupportedEvent(eventName) {
    return isVideoEvent(eventName) || isGameEvent(eventName);
}

function questUnavailableReason(quest, now = Date.now()) {
    if (quest.autoSupported === false) return 'ต้องทำหลาย task พร้อมกัน';
    const enrollmentBlockedUntil = Date.parse(quest.enrollmentBlockedUntil);
    if (!quest.enrolled && Number.isFinite(enrollmentBlockedUntil) && enrollmentBlockedUntil > now) {
        return 'Discord ยังไม่เปิดให้รับ Quest';
    }
    const startsAt = Date.parse(quest.startsAt);
    if (Number.isFinite(startsAt) && startsAt > now) return 'ยังไม่เริ่ม';
    const expiresAt = Date.parse(quest.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= now) return 'หมดเวลาแล้ว';
    return null;
}

function isRunnableQuest(quest) {
    return isSupportedEvent(quest.eventName) && !questUnavailableReason(quest);
}

function selectQuestClaimPlatform(quest) {
    const platforms = Array.isArray(quest?.rewardPlatforms)
        ? quest.rewardPlatforms.filter(Number.isInteger)
        : [];
    if (platforms.length === 0) return 0;
    if (platforms.includes(4)) return 4;
    if (platforms.includes(0)) return 0;
    if (platforms.length === 1) return platforms[0];
    return 0;
}

function isUncertainMutationFailure(error) {
    if (!error) return false;
    if (error.name === 'AbortError' || error.message === 'aborted') return false;
    if (!Number.isInteger(error.status)) return true;
    return error.status === 429 || error.status >= 500;
}

function mutationRetryDelayMs(error) {
    const seconds = Number(
        error?.data?.retry_after
        ?? error?.data?.retryAfter
        ?? error?.retryAfter,
    );
    if (!Number.isFinite(seconds) || seconds < 0) return 1000;
    return Math.min(60000, Math.ceil(seconds * 1000));
}

async function executeVerifiedMutation({ perform, verify, signal }) {
    let firstError;
    try {
        return await perform();
    } catch (error) {
        firstError = error;
    }

    if (!isUncertainMutationFailure(firstError)) throw firstError;
    if (await verify()) return { verifiedAfterFailure: true };

    await sleep(mutationRetryDelayMs(firstError), signal);

    try {
        return await perform();
    } catch (retryError) {
        if (isUncertainMutationFailure(retryError) && await verify()) {
            return { verifiedAfterFailure: true };
        }
        throw retryError;
    }
}

async function readFreshQuestForMutation(token, questId, signal) {
    try {
        return (await fetchQuests(token, signal)).find((quest) => quest.id === questId);
    } catch {
        return null;
    }
}

async function verifiedQuestMutation({ token, questId, signal, perform, predicate }) {
    return executeVerifiedMutation({
        perform,
        signal,
        verify: async () => {
            const fresh = await readFreshQuestForMutation(token, questId, signal);
            return Boolean(fresh && predicate(fresh));
        }
    });
}

async function fetchMe(token, signal) {
    return discordFetch(token, '/users/@me', { signal });
}

function extractQuestArray(candidate) {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === 'object' && Array.isArray(candidate.quests)) {
        return candidate.quests;
    }
    return null;
}

function createQuestPayload(candidate, path) {
    const quests = extractQuestArray(candidate);
    if (!quests) {
        throw new QuestCompatibilityError(
            `Quest API schema changed at ${path}: expected an array or { quests: [] }`
        );
    }
    return {
        path,
        quests,
        excludedCount: Array.isArray(candidate?.excluded_quests)
            ? candidate.excluded_quests.length
            : 0,
        enrollmentBlockedUntil: candidate?.quest_enrollment_blocked_until ?? null
    };
}

function questTaskEntries(taskConfig) {
    const tasks = taskConfig?.tasks;
    if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) return [];
    return Object.entries(tasks);
}

function taskEventType(key, definition) {
    if (typeof definition?.event_name === 'string') return definition.event_name;
    if (typeof definition?.type === 'string') return definition.type;
    return key;
}

function normalizeTaskEntries(entries) {
    return entries.map(([key, definition]) => ({
        key,
        definition,
        type: taskEventType(key, definition)
    }));
}

function progressMapFromStatus(userStatus) {
    const progress = userStatus.progress;
    if (!progress || typeof progress !== 'object' || Array.isArray(progress)) return {};
    return progress;
}

function selectQuestTask(entries, progressMap) {
    const supported = entries.filter(({ type }) => isSupportedEvent(type));
    const matching = supported.find(({ key, type }) => (
        progressMap[key] != null || progressMap[type] != null
    ));
    if (matching) return matching;
    if (supported.length) return supported[0];
    if (entries.length) return entries[0];
    return { key: 'UNKNOWN_SCHEMA', type: 'UNKNOWN_SCHEMA', definition: { target: 0 } };
}

function validateQuestTask(rawId, taskConfig, entries, selectedTask) {
    const schemaIssues = [];
    if (!entries.length) schemaIssues.push(`quest ${rawId}: missing task definitions`);
    const secondsNeeded = Number(selectedTask.definition?.target ?? 0);
    const autoSupported = !(
        (taskConfig?.join_operator ?? 'or') === 'and' && entries.length > 1
    );
    if (!autoSupported) {
        schemaIssues.push(`quest ${rawId}: multi-task join_operator=and requires every task`);
    }
    if (!Number.isFinite(secondsNeeded) || secondsNeeded <= 0) {
        schemaIssues.push(`quest ${rawId}: invalid target for ${selectedTask.type}`);
    }
    return { autoSupported, schemaIssues, secondsNeeded };
}

function progressSeconds(userStatus, progressKey, eventName, secondsNeeded) {
    const rawProgress = userStatus.progress;
    if (rawProgress && typeof rawProgress === 'object' && !Array.isArray(rawProgress)) {
        const eventProgress = rawProgress[progressKey] ?? rawProgress[eventName];
        if (eventProgress && typeof eventProgress === 'object') {
            return Number(eventProgress.value ?? 0);
        }
        return Number(eventProgress ?? 0);
    }
    if (typeof rawProgress === 'string' || typeof rawProgress === 'number') {
        return (Number.parseFloat(rawProgress) / 100) * secondsNeeded;
    }
    const streamProgress = Number(userStatus.stream_progress_seconds);
    return Number.isFinite(streamProgress) ? streamProgress : 0;
}

function rewardPlatforms(config) {
    const platforms = config.rewards_config?.platforms;
    if (!Array.isArray(platforms)) return [];
    return platforms.map(Number).filter(Number.isInteger);
}

function questProgressPercent(completedSeconds, secondsNeeded) {
    if (secondsNeeded <= 0) return 0;
    return Math.min(100, (completedSeconds / secondsNeeded) * 100);
}

function normalizeQuest(raw) {
    if (!raw || typeof raw !== 'object' || !raw.id) {
        throw new QuestCompatibilityError('Quest item is missing a valid id');
    }

    const cfg = raw.config ?? {};
    const userStatus = raw.user_status ?? {};
    const taskConfig = cfg.task_config_v2 ?? cfg.task_config;
    const taskEntries = questTaskEntries(taskConfig);
    const normalizedEntries = normalizeTaskEntries(taskEntries);
    const selectedTask = selectQuestTask(normalizedEntries, progressMapFromStatus(userStatus));
    const validation = validateQuestTask(raw.id, taskConfig, taskEntries, selectedTask);
    const completedSeconds = progressSeconds(
        userStatus,
        selectedTask.key,
        selectedTask.type,
        validation.secondsNeeded
    );

    return {
        id: raw.id,
        name: cfg.messages?.quest_name ?? raw.id,
        applicationId: cfg.application?.id ?? null,
        rewardPlatforms: rewardPlatforms(cfg),
        startsAt: cfg.starts_at ?? null,
        expiresAt: cfg.expires_at ?? null,
        eventName: selectedTask.type,
        progress: questProgressPercent(completedSeconds, validation.secondsNeeded),
        secondsNeeded: validation.secondsNeeded,
        progressSecs: completedSeconds,
        progressKey: selectedTask.key,
        autoSupported: validation.autoSupported,
        enrolledAt: userStatus.enrolled_at ?? null,
        enrolled: Boolean(userStatus.enrolled_at),
        completed: Boolean(userStatus.completed_at),
        claimed: Boolean(userStatus.claimed_at) || userStatus.orb_quantity_claimed != null,
        schemaIssues: validation.schemaIssues
    };
}

async function fetchQuests(token, signal) {
    let lastError = null;
    for (const path of QUEST_LIST_PATHS) {
        try {
            const candidate = await discordFetch(token, path, { signal });
            const payload = createQuestPayload(candidate, path);
            return payload.quests.map((quest) => ({
                ...normalizeQuest(quest),
                enrollmentBlockedUntil: payload.enrollmentBlockedUntil
            }));
        } catch (error) {
            lastError = error;
            if (isFatalAuthError(error)) throw error;
        }
    }
    throw lastError || new QuestCompatibilityError('Failed to fetch Discord quests');
}

async function fetchFreshQuest(token, questId, signal) {
    const quests = await fetchQuests(token, signal);
    const fresh = quests.find((q) => q.id === questId);
    if (!fresh) throw new QuestCompatibilityError(`Quest ${questId} disappeared`);
    return fresh;
}

async function waitForQuestState(token, questId, predicate, signal, { attempts = 3, delayMs = 1500 } = {}) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        const fresh = (await fetchQuests(token, signal)).find((quest) => quest.id === questId);
        if (fresh && predicate(fresh)) return fresh;
        if (attempt < attempts) await sleep(delayMs, signal);
    }
    return null;
}

async function enrollQuest(token, questId, signal) {
    return verifiedQuestMutation({
        token,
        questId,
        signal,
        predicate: (fresh) => fresh.enrolled,
        perform: () => discordFetch(token, `/quests/${questId}/enroll`, {
            method: 'POST',
            body: JSON.stringify({
                location: 11,
                is_targeted: false,
                metadata_raw: null
            }),
            signal
        })
    });
}

async function claimQuest(token, questId, platform, signal) {
    const selectedPlatform = platform ?? 0;
    const perform = async () => {
        try {
            return await discordFetch(token, `/quests/${questId}/claim-reward`, {
                method: 'POST',
                body: JSON.stringify({ location: 11, platform: selectedPlatform }),
                signal
            });
        } catch (error) {
            if (error?.status !== 404) throw error;
            return discordFetch(token, `/quests/${questId}/claim`, {
                method: 'POST',
                body: JSON.stringify({ location: 1, platform: selectedPlatform }),
                signal
            });
        }
    };
    return verifiedQuestMutation({
        token,
        questId,
        signal,
        perform,
        predicate: (fresh) => fresh.claimed
    });
}

async function sendVideoProgress(token, questId, timestamp, signal) {
    const jitter = crypto.randomInt(0, 501) / 1000;
    const ts = Math.round(timestamp + jitter);
    return verifiedQuestMutation({
        token,
        questId,
        signal,
        predicate: (fresh) => fresh.completed || fresh.progressSecs >= Math.floor(timestamp),
        perform: () => discordFetch(token, `/quests/${questId}/video-progress`, {
            method: 'POST',
            body: JSON.stringify({ timestamp: ts }),
            signal
        })
    });
}

async function sendGameHeartbeat(token, quest, terminal, signal) {
    const baseline = quest.progressSecs;
    const perform = async () => {
        try {
            return await discordFetch(token, `/quests/${quest.id}/heartbeat`, {
                method: 'POST',
                body: JSON.stringify({ stream_key: `call:${quest.id}:1`, terminal }),
                signal
            });
        } catch (error) {
            if (error?.status !== 400 || !quest.applicationId) throw error;
            return discordFetch(token, `/quests/${quest.id}/heartbeat`, {
                method: 'POST',
                body: JSON.stringify({ application_id: quest.applicationId, terminal }),
                signal
            });
        }
    };
    return verifiedQuestMutation({
        token,
        questId: quest.id,
        signal,
        perform,
        predicate: (fresh) => fresh.completed || fresh.progressSecs > baseline
    });
}

async function sendApplicationHeartbeat(token, quest, terminal, signal) {
    if (!quest.applicationId) {
        throw new QuestCompatibilityError(`Quest ${quest.id} is missing config.application.id`);
    }
    const baseline = quest.progressSecs;
    return verifiedQuestMutation({
        token,
        questId: quest.id,
        signal,
        predicate: (fresh) => fresh.completed || fresh.progressSecs > baseline,
        perform: () => discordFetch(token, `/quests/${quest.id}/heartbeat`, {
            method: 'POST',
            body: JSON.stringify({ application_id: quest.applicationId, terminal }),
            signal
        })
    });
}

async function sendQuestHeartbeat(token, quest, terminal, useApplicationPayload, signal) {
    if (useApplicationPayload) {
        return sendApplicationHeartbeat(token, quest, terminal, signal);
    }
    return sendGameHeartbeat(token, quest, terminal, signal);
}

const VIDEO_SUBMISSION_INTERVAL_SECS = 10;

function nextVideoTimestamp(current, target, enrolledAtMs, now = Date.now()) {
    const maxAllowed = Number.isFinite(enrolledAtMs)
        ? Math.floor((now - enrolledAtMs) / 1000) + VIDEO_SUBMISSION_INTERVAL_SECS
        : current + 1;
    return Math.min(
        target,
        current + VIDEO_SUBMISSION_INTERVAL_SECS,
        maxAllowed
    );
}

async function executeVideoQuestStep({
    token,
    questId,
    timestamp,
    signal,
    onMutationAccepted,
    onServerProgress
}) {
    const mutation = await sendVideoProgress(token, questId, timestamp, signal);
    if (!mutation?.verifiedAfterFailure) onMutationAccepted();
    await sleep(1000, signal);
    const fresh = await fetchFreshQuest(token, questId, signal);
    if (onServerProgress) await onServerProgress(fresh);
    return fresh;
}

async function runVideoQuest(
    token,
    quest,
    signal,
    onServerProgress,
    _speedMultiplier,
    _heartbeatSecs,
    onMutationAccepted = () => {}
) {
    let fresh = quest;
    let current = fresh.progressSecs;
    const target = fresh.secondsNeeded;
    const enrolledAtMs = Date.parse(fresh.enrolledAt);
    let unchangedChecks = 0;

    while (!fresh.completed && current < target) {
        if (signal?.aborted) throw abortFailure();
        const timestamp = nextVideoTimestamp(current, target, enrolledAtMs);
        if (timestamp <= current) {
            await sleep(1000, signal);
            continue;
        }

        fresh = await executeVideoQuestStep({
            token,
            questId: quest.id,
            timestamp,
            signal,
            onMutationAccepted,
            onServerProgress
        });

        unchangedChecks = fresh.progressSecs > current || fresh.completed ? 0 : unchangedChecks + 1;
        if (unchangedChecks >= 8) {
            throw new Error('Discord ไม่ยืนยัน video progress หลังตรวจ 8 ครั้ง');
        }
        current = Math.max(current, fresh.progressSecs);

        if (!fresh.completed && current < target) {
            await sleep((VIDEO_SUBMISSION_INTERVAL_SECS - 1) * 1000, signal);
        }
    }
    return fresh;
}

async function executeGameHeartbeatStep({
    token,
    quest,
    terminal,
    forceApplicationPayload,
    signal,
    onMutationAccepted,
    onServerProgress
}) {
    const mutation = await sendQuestHeartbeat(token, quest, terminal, forceApplicationPayload, signal);
    if (!mutation?.verifiedAfterFailure) onMutationAccepted();
    await sleep(1000, signal);
    const fresh = await fetchFreshQuest(token, quest.id, signal);
    if (onServerProgress) await onServerProgress(fresh);
    return fresh;
}

async function runGameQuest(
    token,
    quest,
    signal,
    onServerProgress,
    _speedMultiplier,
    heartbeatSecs = 30,
    onMutationAccepted = () => {}
) {
    let fresh = quest;
    let current = fresh.progressSecs;
    const intervalSecs = Math.max(1, Number(heartbeatSecs) || 30);
    let unchangedChecks = 0;
    let forceApplicationPayload = false;

    while (!fresh.completed && current < fresh.secondsNeeded) {
        if (signal?.aborted) throw abortFailure();
        fresh = await executeGameHeartbeatStep({
            token,
            quest: fresh,
            terminal: false,
            forceApplicationPayload,
            signal,
            onMutationAccepted,
            onServerProgress
        });

        if (fresh.progressSecs > current || fresh.completed) {
            unchangedChecks = 0;
        } else {
            unchangedChecks++;
            forceApplicationPayload = forceApplicationPayload || Boolean(fresh.applicationId);
        }

        if (unchangedChecks >= 5) {
            throw new Error('Discord ไม่ยืนยัน game progress หลัง heartbeat 5 ครั้ง');
        }
        current = Math.max(current, fresh.progressSecs);

        if (!fresh.completed && current < fresh.secondsNeeded) {
            await sleep(Math.max(0, intervalSecs - 1) * 1000, signal);
        }
    }

    if (fresh.completed) return fresh;
    return executeGameHeartbeatStep({
        token,
        quest: fresh,
        terminal: true,
        forceApplicationPayload,
        signal,
        onMutationAccepted,
        onServerProgress
    });
}

module.exports = {
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
    isGameEvent,
    isSupportedEvent,
    isRunnableQuest,
    DiscordApiError,
    QuestCompatibilityError,
    isFatalAuthError
};
