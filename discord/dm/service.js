"use strict";

const crypto = require("node:crypto");
const mongoose = require("mongoose");
const DmNotification = require("./model");
const { profileFromUser, safeText } = require("./design");

const RETRY_DELAYS_MS = Object.freeze([5_000, 30_000, 120_000]);
const PERMANENT_CODES = new Set([10013, 50007]);
const PRIORITY_ORDER = Object.freeze({ critical: 0, high: 1, normal: 2, low: 3 });
const VOLATILE_DEDUPE_MAX = 5000;
const PROFILE_FETCH_TIMEOUT_MS = 3000;
const volatileDedupe = new Map();
const volatileDelivered = new Map();
const diagnostics = {
    candidates: 0,
    sent: 0,
    retrying: 0,
    failedPermanent: 0,
    duplicates: 0,
    processed: 0,
    persistenceErrors: 0
};
let client = null;
let workerTimer = null;
let workerBusy = false;

function configure(options = {}) {
    if (options.client) client = options.client;
    return module.exports;
}

function normalizeEventKey(value) {
    const raw = String(value || crypto.randomUUID());
    if (/^[A-Za-z0-9:._-]{1,180}$/.test(raw)) return raw;
    return `dm:${crypto.createHash("sha256").update(raw).digest("hex")}`;
}

function normalizePayload(payload = {}) {
    const embeds = Array.isArray(payload.embeds)
        ? payload.embeds.slice(0, 10).map(embed => typeof embed?.toJSON === "function" ? embed.toJSON() : embed)
        : undefined;
    return {
        content: payload.content ? safeText(payload.content, "", 2000) : undefined,
        embeds,
        allowedMentions: { parse: [], repliedUser: false }
    };
}

function databaseReady() {
    return mongoose.connection.readyState === 1;
}

function rememberVolatile(key) {
    volatileDedupe.set(key, Date.now());
    while (volatileDedupe.size > VOLATILE_DEDUPE_MAX) {
        volatileDedupe.delete(volatileDedupe.keys().next().value);
    }
}

function rememberDelivered(key) {
    volatileDelivered.set(key, Date.now());
    while (volatileDelivered.size > VOLATILE_DEDUPE_MAX) {
        volatileDelivered.delete(volatileDelivered.keys().next().value);
    }
}

function withTimeout(promise, timeoutMs = PROFILE_FETCH_TIMEOUT_MS) {
    let timer = null;
    const raced = Promise.race([
        Promise.resolve(promise).catch(() => null),
        new Promise(resolve => {
            timer = setTimeout(() => resolve(null), timeoutMs);
            timer.unref?.();
        })
    ]);
    return raced.finally(() => {
        if (timer) clearTimeout(timer);
    });
}

async function resolveProfile(userId, fallback = {}) {
    const id = String(userId || fallback.id || "");
    let user = null;
    if (client?.users && id) {
        user = client.users.cache?.get?.(id) || await withTimeout(client.users.fetch(id));
    }
    return profileFromUser(user, { ...fallback, id });
}

async function fetchRecipient(recipientId) {
    if (!client?.users || !recipientId) return null;
    return client.users.cache?.get?.(recipientId) || withTimeout(client.users.fetch(recipientId));
}

function failureCode(error) {
    return Number(error?.code || error?.rawError?.code || error?.status || 0) || 0;
}

function isPermanent(error) {
    return PERMANENT_CODES.has(failureCode(error));
}

function safeFailure(error) {
    return safeText(error?.code || error?.name || error?.status || "dm_delivery_failed", "dm_delivery_failed", 80);
}

async function updateRecord(record, update) {
    if (!record?._id || !databaseReady()) return false;
    try {
        await DmNotification.updateOne({ _id: record._id }, { $set: { ...update, updatedAt: Date.now() } });
        return true;
    } catch {
        diagnostics.persistenceErrors++;
        return false;
    }
}

async function claimRecord(record) {
    if (!record?._id || !databaseReady()) return record;
    return DmNotification.findOneAndUpdate(
        {
            _id: record._id,
            status: { $in: ["pending", "retrying", "sending"] },
            nextAttemptAt: { $lte: Date.now() }
        },
        {
            $set: {
                status: "sending",
                nextAttemptAt: Date.now() + 60_000,
                updatedAt: Date.now()
            }
        },
        { new: true }
    ).lean();
}

function trackRetryOutcome(permanent) {
    if (permanent) diagnostics.failedPermanent++;
    else diagnostics.retrying++;
}

async function deferRecord(record, reason, permanentFailure = false) {
    const attempts = Number(record.attempts || 0) + 1;
    const permanent = permanentFailure || attempts > RETRY_DELAYS_MS.length;
    const status = permanent ? "failed_permanent" : "retrying";
    await updateRecord(record, {
        attempts,
        status,
        lastError: reason,
        nextAttemptAt: Date.now() + (RETRY_DELAYS_MS[attempts - 1] || 0)
    });
    trackRetryOutcome(permanent);
    return { status, reason };
}

async function markDelivered(record, message) {
    rememberDelivered(record.eventKey);
    const persisted = await updateRecord(record, { status: "sent", sentAt: Date.now(), lastError: null });
    if (record?._id && !persisted) {
        console.warn(`[DM] delivery succeeded but outbox acknowledgement was not persisted | category=${safeText(record.category, "general", 80)}`);
    }
    diagnostics.sent++;
    return { status: "sent", message };
}

async function attempt(record) {
    const claimed = await claimRecord(record);
    if (!claimed) return { status: "skipped", reason: "already_claimed" };
    record = claimed;
    if (volatileDelivered.has(record.eventKey)) {
        await updateRecord(record, { status: "sent", sentAt: Date.now(), lastError: null });
        return { status: "skipped", reason: "already_delivered_in_process" };
    }
    const recipient = await fetchRecipient(record.recipientId);
    if (!recipient) return deferRecord(record, "recipient_unavailable");

    try {
        const message = await recipient.send(record.payload);
        return markDelivered(record, message);
    } catch (error) {
        return deferRecord(record, safeFailure(error), isPermanent(error));
    }
}

async function reserve(input) {
    const eventKey = normalizeEventKey(input.eventKey);
    const recordData = {
        eventKey,
        recipientId: String(input.recipientId || ""),
        category: safeText(input.category, "general", 80),
        priority: Object.hasOwn(PRIORITY_ORDER, input.priority) ? input.priority : "normal",
        payload: normalizePayload(input.payload),
        status: "pending",
        attempts: 0,
        nextAttemptAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    };

    if (!databaseReady()) {
        if (volatileDedupe.has(eventKey)) return { duplicate: true, record: null };
        rememberVolatile(eventKey);
        return { duplicate: false, record: recordData };
    }

    try {
        const record = await DmNotification.create(recordData);
        return { duplicate: false, record };
    } catch (error) {
        if (Number(error?.code) !== 11000) throw error;
        return { duplicate: true, record: null };
    }
}

async function send(input = {}) {
    diagnostics.candidates++;
    if (!input.recipientId) return { status: "skipped", reason: "recipient_missing" };
    const reserved = await reserve(input).catch(() => null);
    if (!reserved) return { status: "failed", reason: "outbox_unavailable" };
    if (reserved.duplicate) {
        diagnostics.duplicates++;
        return { status: "skipped", reason: "duplicate" };
    }
    return attempt(reserved.record);
}

async function processPending(limit = 25) {
    if (!databaseReady() || !client?.isReady?.() || workerBusy) return { processed: 0 };
    workerBusy = true;
    try {
        const candidates = await DmNotification.find({
            status: { $in: ["pending", "retrying", "sending"] },
            nextAttemptAt: { $lte: Date.now() }
        }).limit(100).lean();
        candidates.sort((left, right) =>
            (PRIORITY_ORDER[left.priority] ?? 2) - (PRIORITY_ORDER[right.priority] ?? 2) ||
            Number(left.createdAt || 0) - Number(right.createdAt || 0)
        );
        const pending = candidates.slice(0, Math.max(1, Math.min(100, Number(limit) || 25)));
        for (const record of pending) await attempt(record);
        diagnostics.processed += pending.length;
        return { processed: pending.length };
    } finally {
        workerBusy = false;
    }
}

function start() {
    if (workerTimer) return false;
    workerTimer = setInterval(() => processPending().catch(() => {}), 15_000);
    workerTimer.unref?.();
    processPending().catch(() => {});
    return true;
}

function stop() {
    if (!workerTimer) return false;
    clearInterval(workerTimer);
    workerTimer = null;
    return true;
}

function getDiagnostics() {
    return {
        ...diagnostics,
        workerRunning: Boolean(workerTimer),
        workerBusy,
        volatileDedupe: volatileDedupe.size,
        volatileDelivered: volatileDelivered.size
    };
}

module.exports = {
    RETRY_DELAYS_MS,
    PERMANENT_CODES,
    configure,
    resolveProfile,
    normalizeEventKey,
    normalizePayload,
    isPermanent,
    send,
    processPending,
    start,
    stop,
    getDiagnostics,
    _test: { attempt, reserve, claimRecord, failureCode, safeFailure, withTimeout, volatileDedupe, volatileDelivered }
};
