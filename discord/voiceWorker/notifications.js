"use strict";

const crypto = require("node:crypto");
const sessionManager = require("../sessionManager");
const dm = require("./dm");

const EVENTS = Object.freeze({
    SESSION_READY: "SESSION_READY",
    RECOVERY_DELAYED: "RECOVERY_DELAYED",
    SESSION_RECOVERED: "SESSION_RECOVERED",
    RECOVERY_EXHAUSTED: "RECOVERY_EXHAUSTED",
    TOKEN_INVALID: "TOKEN_INVALID",
    LOGIN_FAILED: "LOGIN_FAILED",
    GUILD_NOT_FOUND: "GUILD_NOT_FOUND",
    CHANNEL_NOT_FOUND: "CHANNEL_NOT_FOUND",
    VOICE_PERMISSION_DENIED: "VOICE_PERMISSION_DENIED",
    VOICE_CONNECTION_FAILED: "VOICE_CONNECTION_FAILED",
    SESSION_STOPPED_IDLE: "SESSION_STOPPED_IDLE",
    SESSION_STOPPED_MANUAL: "SESSION_STOPPED_MANUAL",
    STOP_FAILED: "STOP_FAILED"
});
const EVENT_TYPES = new Set(Object.values(EVENTS));
const UNSAFE_RECORD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function containsControlCharacter(value) {
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (codePoint < 32 || codePoint === 127) return true;
    }
    return false;
}

function isSafeRecordKey(value) {
    const key = String(value || "");
    return key.length > 0
        && key.length <= 512
        && !UNSAFE_RECORD_KEYS.has(key)
        && !containsControlCharacter(key);
}

function policyAllows(type, context, mode) {
    if (mode === "off") return false;
    if (context.source === "auto_resume" && type === EVENTS.SESSION_READY) return false;
    if (mode === "important_only" && type === EVENTS.SESSION_STOPPED_MANUAL && context.actorNotified === true) {
        return false;
    }
    return true;
}

function createEventRecord(source = {}) {
    const record = Object.create(null);
    for (const [key, value] of Object.entries(source)) {
        if (!isSafeRecordKey(key)) continue;
        Object.defineProperty(record, key, {
            value,
            writable: true,
            configurable: true,
            enumerable: true
        });
    }
    return record;
}

function getEventRecordValue(record, key) {
    if (!record || !isSafeRecordKey(key)) return undefined;
    return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function setEventRecordValue(record, key, value) {
    if (!record || !isSafeRecordKey(key)) return false;
    Object.defineProperty(record, key, {
        value,
        writable: true,
        configurable: true,
        enumerable: true
    });
    return true;
}

const TERMINAL_EVENTS = new Set([
    EVENTS.RECOVERY_EXHAUSTED,
    EVENTS.TOKEN_INVALID,
    EVENTS.LOGIN_FAILED,
    EVENTS.GUILD_NOT_FOUND,
    EVENTS.CHANNEL_NOT_FOUND,
    EVENTS.VOICE_PERMISSION_DENIED,
    EVENTS.VOICE_CONNECTION_FAILED,
    EVENTS.SESSION_STOPPED_IDLE,
    EVENTS.SESSION_STOPPED_MANUAL,
    EVENTS.STOP_FAILED
]);

const DEFAULTS = Object.freeze({
    recoveryGraceMs: 2 * 60 * 1000,
    ownerBudgetMax: 3,
    ownerBudgetWindowMs: 10 * 60 * 1000,
    digestDelayMs: 60 * 1000,
    digestMinIntervalMs: 10 * 60 * 1000,
    eventHistoryMax: 50,
    ownerStateMax: 5000
});

function createVoiceNotificationSystem(options = {}) {
    const manager = options.sessionManager || sessionManager;
    const dmSender = options.dm || dm;
    const now = options.now || Date.now;
    const randomUUID = options.randomUUID || crypto.randomUUID;
    const setTimer = options.setTimer || setTimeout;
    const clearTimer = options.clearTimer || clearTimeout;
    const config = { ...DEFAULTS, ...options.config };
    const inFlight = new Map();
    const transitions = new Map();
    const incidentTimers = new Map();
    const ownerBudgets = new Map();
    const ownerDigests = new Map();
    const diagnostics = {
        candidates: 0,
        sent: 0,
        suppressed: 0,
        coalesced: 0,
        digested: 0,
        failed: 0
    };

    function getSession(sessionId) {
        return manager.getSession(sessionId) || null;
    }

    function ensureRuntimeState(session) {
        if (!session.lifecycleGeneration) session.lifecycleGeneration = randomUUID();
        if (!session.notificationState || typeof session.notificationState !== "object") {
            session.notificationState = { events: createEventRecord() };
        }
        if (!session.notificationState.events || typeof session.notificationState.events !== "object") {
            session.notificationState.events = createEventRecord();
        } else if (Object.getPrototypeOf(session.notificationState.events) !== null) {
            session.notificationState.events = createEventRecord(session.notificationState.events);
        }
        if (!session.recoveryState || typeof session.recoveryState !== "object") {
            session.recoveryState = {
                phase: "starting",
                incidentId: null,
                openedAt: null,
                attempts: 0,
                lifetimeAttempts: Number(session.reconnectCount || 0)
            };
        }
        return session;
    }

    async function persist(sessionId) {
        if (typeof manager.saveVoiceRuntimeState !== "function") return false;
        return manager.saveVoiceRuntimeState(sessionId).catch(() => false);
    }

    function serialize(sessionId, operation) {
        const previous = transitions.get(sessionId) || Promise.resolve();
        const current = previous.catch(() => {}).then(operation);
        transitions.set(sessionId, current);
        current.finally(() => {
            if (transitions.get(sessionId) === current) transitions.delete(sessionId);
        }).catch(() => {});
        return current;
    }

    function getIncidentKey(session, type, context = {}) {
        const incidentId = context.incidentId || session.recoveryState?.incidentId || "lifecycle";
        const rawKey = `${session.lifecycleGeneration}:${incidentId}:${type}`;
        if (isSafeRecordKey(rawKey)) return rawKey;
        return `event:${crypto.createHash("sha256").update(rawKey).digest("hex")}`;
    }

    function pruneEventHistory(events) {
        const entries = Object.entries(events);
        if (entries.length <= config.eventHistoryMax) return events;
        entries.sort(([, left], [, right]) => Number(left?.at || 0) - Number(right?.at || 0));
        return createEventRecord(Object.fromEntries(entries.slice(-config.eventHistoryMax)));
    }

    async function setEventStatus(sessionId, eventKey, status, extra = {}) {
        const session = getSession(sessionId);
        if (!session) return false;
        ensureRuntimeState(session);
        const saved = setEventRecordValue(session.notificationState.events, eventKey, {
            status,
            at: now(),
            ...extra
        });
        if (!saved) return false;
        session.notificationState.events = pruneEventHistory(session.notificationState.events);
        return persist(sessionId);
    }

    async function readMode() {
        if (typeof manager.getSetting !== "function") return "important_only";
        const mode = await manager.getSetting("voiceDmMode", "important_only").catch(() => "important_only");
        return ["all", "important_only", "off"].includes(mode) ? mode : "important_only";
    }

    function reserveOwnerBudget(ownerId) {
        const timestamp = now();
        const recent = (ownerBudgets.get(ownerId) || [])
            .filter(value => timestamp - value < config.ownerBudgetWindowMs);
        if (recent.length >= config.ownerBudgetMax) {
            ownerBudgets.set(ownerId, recent);
            return false;
        }
        recent.push(timestamp);
        ownerBudgets.set(ownerId, recent);
        return true;
    }

    function scheduleDigest(ownerId) {
        const digest = ownerDigests.get(ownerId);
        if (!digest || digest.timer) return;
        const elapsed = now() - Number(digest.lastSentAt || 0);
        const delayMs = Math.max(config.digestDelayMs, config.digestMinIntervalMs - elapsed);
        digest.timer = setTimer(() => flushDigest(ownerId).catch(() => {}), delayMs);
        digest.timer.unref?.();
    }

    async function flushDigest(ownerId) {
        const digest = ownerDigests.get(ownerId);
        if (!digest) return { status: "skipped", reason: "digest_missing" };
        if (digest.timer) clearTimer(digest.timer);
        digest.timer = null;
        const items = digest.items.splice(0, digest.items.length);
        const total = digest.total;
        const counts = Object.fromEntries(digest.counts);
        digest.total = 0;
        digest.counts.clear();
        if (total === 0) return { status: "skipped", reason: "digest_empty" };

        const result = await dmSender.sendVoiceDigestDM(ownerId, items, { total, counts });
        digest.lastSentAt = now();
        if (digest.items.length) scheduleDigest(ownerId);
        return result;
    }

    function queueDigest(session, type, context) {
        const ownerId = String(session.ownerId || "");
        if (!ownerId) return false;
        let digest = ownerDigests.get(ownerId);
        if (!digest) {
            digest = { items: [], total: 0, counts: new Map(), timer: null, lastSentAt: 0 };
            ownerDigests.set(ownerId, digest);
        }
        digest.total++;
        digest.counts.set(type, Number(digest.counts.get(type) || 0) + 1);
        if (digest.items.length < 50) digest.items.push(dmSender.createVoiceSnapshot(session, type, context));
        scheduleDigest(ownerId);
        return true;
    }

    async function dispatch(sessionId, type, context, eventKey) {
        const session = getSession(sessionId);
        if (!session?.ownerId) return { status: "skipped", reason: "owner_missing" };
        ensureRuntimeState(session);

        if (getEventRecordValue(session.notificationState.events, eventKey)) {
            diagnostics.suppressed++;
            return { status: "skipped", reason: "duplicate" };
        }

        await setEventStatus(sessionId, eventKey, "reserved");
        const mode = await readMode();
        if (!policyAllows(type, context, mode)) {
            diagnostics.suppressed++;
            await setEventStatus(sessionId, eventKey, "suppressed", { reason: "policy" });
            return { status: "skipped", reason: "policy" };
        }

        if (!reserveOwnerBudget(String(session.ownerId))) {
            const queued = queueDigest(session, type, context);
            diagnostics.digested++;
            await setEventStatus(sessionId, eventKey, "digested");
            return { status: queued ? "digested" : "skipped", reason: "owner_budget" };
        }

        const snapshot = dmSender.createVoiceSnapshot(session, type, context);
        const result = await dmSender.sendVoiceEventDM(snapshot);
        if (result?.status === "sent") diagnostics.sent++;
        else diagnostics.failed++;
        await setEventStatus(sessionId, eventKey, result?.status || "failed", {
            reason: result?.reason || null
        });
        return result;
    }

    function emit(sessionId, type, context = {}) {
        diagnostics.candidates++;
        if (!EVENT_TYPES.has(type)) {
            diagnostics.suppressed++;
            return Promise.resolve({ status: "skipped", reason: "invalid_event_type" });
        }
        const session = getSession(sessionId);
        if (!session) return Promise.resolve({ status: "skipped", reason: "session_missing" });
        ensureRuntimeState(session);
        const eventKey = getIncidentKey(session, type, context);
        if (inFlight.has(eventKey)) {
            diagnostics.coalesced++;
            return inFlight.get(eventKey);
        }

        const task = dispatch(sessionId, type, context, eventKey)
            .finally(() => inFlight.delete(eventKey));
        inFlight.set(eventKey, task);
        return task;
    }

    function cancelIncidentTimer(sessionId) {
        const timer = incidentTimers.get(sessionId);
        if (timer) clearTimer(timer);
        incidentTimers.delete(sessionId);
    }

    function scheduleIncidentNotice(sessionId, incidentId) {
        cancelIncidentTimer(sessionId);
        const timer = setTimer(() => {
            if (incidentTimers.get(sessionId) === timer) incidentTimers.delete(sessionId);
            const session = getSession(sessionId);
            if (session?.recoveryState?.phase !== "degraded") return;
            if (session.recoveryState.incidentId !== incidentId) return;
            emit(sessionId, EVENTS.RECOVERY_DELAYED, {
                incidentId,
                outageDurationMs: now() - Number(session.recoveryState.openedAt || now())
            }).catch(() => {});
        }, config.recoveryGraceMs);
        timer.unref?.();
        incidentTimers.set(sessionId, timer);
    }

    function beginIncident(sessionId, context = {}) {
        return serialize(sessionId, async () => {
            const session = getSession(sessionId);
            if (!session) return null;
            ensureRuntimeState(session);
            if (session.recoveryState.phase === "degraded" && session.recoveryState.incidentId) {
                return { ...session.recoveryState };
            }

            const incidentId = randomUUID();
            session.recoveryState = {
                phase: "degraded",
                incidentId,
                openedAt: now(),
                attempts: 0,
                lifetimeAttempts: Number(session.recoveryState.lifetimeAttempts || session.reconnectCount || 0),
                cause: context.cause || "voice_disconnected"
            };
            session.reconnecting = true;
            await persist(sessionId);
            scheduleIncidentNotice(sessionId, incidentId);
            return { ...session.recoveryState };
        });
    }

    async function recordRecoveryAttempt(sessionId, context = {}) {
        await beginIncident(sessionId, context);
        return serialize(sessionId, async () => {
            const session = getSession(sessionId);
            if (!session) return null;
            ensureRuntimeState(session);
            session.recoveryState.attempts = Number(session.recoveryState.attempts || 0) + 1;
            session.recoveryState.lifetimeAttempts = Number(session.recoveryState.lifetimeAttempts || 0) + 1;
            session.recoveryState.lastAttemptAt = now();
            session.reconnectCount = session.recoveryState.lifetimeAttempts;
            await persist(sessionId);
            return { ...session.recoveryState };
        });
    }

    async function markReady(sessionId, context = {}) {
        const transition = await serialize(sessionId, async () => {
            const session = getSession(sessionId);
            if (!session) return null;
            ensureRuntimeState(session);
            const previous = { ...session.recoveryState };
            const readyAt = now();
            session.voiceReadyAt = readyAt;
            session.lastActivity = readyAt;
            session.reconnecting = false;
            session.recoveryState = {
                phase: "ready",
                incidentId: null,
                openedAt: null,
                attempts: 0,
                lifetimeAttempts: Number(previous.lifetimeAttempts || session.reconnectCount || 0),
                lastIncidentId: previous.incidentId || null,
                resolvedAt: previous.incidentId ? readyAt : null
            };
            cancelIncidentTimer(sessionId);
            await persist(sessionId);
            return { previous, readyAt };
        });
        if (!transition) return { status: "skipped", reason: "session_missing" };

        if (transition.previous.incidentId) {
            const outageDurationMs = transition.readyAt - Number(transition.previous.openedAt || transition.readyAt);
            const session = getSession(sessionId);
            const delayedKey = session
                ? getIncidentKey(session, EVENTS.RECOVERY_DELAYED, { incidentId: transition.previous.incidentId })
                : null;
            const delayedRecorded = Boolean(
                delayedKey && getEventRecordValue(session?.notificationState?.events, delayedKey)
            );
            if (delayedRecorded || outageDurationMs >= config.recoveryGraceMs) {
                return emit(sessionId, EVENTS.SESSION_RECOVERED, {
                    ...context,
                    incidentId: transition.previous.incidentId,
                    outageDurationMs,
                    attempts: transition.previous.attempts
                });
            }
            diagnostics.suppressed++;
            return { status: "skipped", reason: "brief_recovery" };
        }

        if (context.notifyInitial === false) return { status: "skipped", reason: "initial_notification_disabled" };
        return emit(sessionId, EVENTS.SESSION_READY, context);
    }

    async function markTerminal(sessionId, type, context = {}) {
        const transition = await serialize(sessionId, async () => {
            const session = getSession(sessionId);
            if (!session) return null;
            ensureRuntimeState(session);
            const incidentId = context.incidentId || session.recoveryState.incidentId || randomUUID();
            session.reconnecting = false;
            session.recoveryState = {
                ...session.recoveryState,
                phase: "terminal",
                incidentId,
                terminalType: type,
                terminalAt: now()
            };
            cancelIncidentTimer(sessionId);
            await persist(sessionId);
            return incidentId;
        });
        if (!transition) return { status: "skipped", reason: "session_missing" };
        return emit(sessionId, type, { ...context, incidentId: transition });
    }

    function cleanupSession(sessionId) {
        cancelIncidentTimer(sessionId);
        transitions.delete(sessionId);
    }

    function cleanupVolatileState(timestamp = now()) {
        for (const [ownerId, values] of ownerBudgets) {
            const recent = values.filter(value => timestamp - value < config.ownerBudgetWindowMs);
            if (recent.length) ownerBudgets.set(ownerId, recent);
            else ownerBudgets.delete(ownerId);
        }
        for (const [ownerId, digest] of ownerDigests) {
            const expired = !digest.timer && digest.total === 0 &&
                timestamp - Number(digest.lastSentAt || 0) >= config.digestMinIntervalMs;
            if (expired) ownerDigests.delete(ownerId);
        }
        while (ownerBudgets.size > config.ownerStateMax) ownerBudgets.delete(ownerBudgets.keys().next().value);
        while (ownerDigests.size > config.ownerStateMax) {
            const ownerId = ownerDigests.keys().next().value;
            const digest = ownerDigests.get(ownerId);
            if (digest?.timer) clearTimer(digest.timer);
            ownerDigests.delete(ownerId);
        }
        return getDiagnostics();
    }

    function getDiagnostics() {
        return {
            ...diagnostics,
            inFlight: inFlight.size,
            transitions: transitions.size,
            incidents: incidentTimers.size,
            ownerBudgets: ownerBudgets.size,
            ownerDigests: ownerDigests.size
        };
    }

    return {
        emit,
        beginIncident,
        recordRecoveryAttempt,
        markReady,
        markTerminal,
        cleanupSession,
        cleanupVolatileState,
        flushDigest,
        getDiagnostics
    };
}

const notificationSystem = createVoiceNotificationSystem();

module.exports = {
    EVENTS,
    TERMINAL_EVENTS,
    DEFAULTS,
    createVoiceNotificationSystem,
    ...notificationSystem
};
